/**
 * 手動消込用：指定注文に紐づく在庫候補一覧
 * GET: ?amazon_order_id=xxx&sku=xxx または ?jan_code=xxx
 * 注文の asin / jan と在庫を突き合わせ、condition は大小文字を区別しない（ilike 等）で一致させる。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { normalizeOrderCondition, type NormalizedListingCondition } from "@/lib/amazon-condition-match";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

/** PostgREST: 未割当または同一 Amazon 注文への仮引当のみ */
function orderIdAvailabilityOr(amazonOrderId: string): string {
  const id = amazonOrderId.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `order_id.is.null,order_id.eq."${id}",order_id.eq.""`;
}

/** 在庫 condition_type: 英字は ilike で大小文字非区別、日本語は eq */
function conditionTypeOrFilter(norm: NormalizedListingCondition): string {
  if (norm === "new") {
    return ["condition_type.ilike.new%", "condition_type.eq.新品"].join(",");
  }
  return ["condition_type.ilike.used%", "condition_type.eq.中古"].join(",");
}

type Row = {
  id: number;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  effective_unit_price: number | string | null;
  condition_type: string | null;
  created_at: string | null;
  order_id: string | null;
};

function baseInboundSelect() {
  return supabase
    .from("inbound_items")
    .select("id, jan_code, brand, model_number, effective_unit_price, condition_type, created_at, order_id")
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id")?.trim() ?? "";
    const sku = searchParams.get("sku")?.trim() ?? "";
    const janCode = searchParams.get("jan_code")?.trim() ?? "";
    const orderRowId = searchParams.get("order_row_id")?.trim() ?? "";
    const ORDER_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!amazonOrderId && !janCode) {
      return NextResponse.json({ error: "amazon_order_id または jan_code を指定してください。" }, { status: 400 });
    }

    let asin: string | null = null;
    let jan: string | null = janCode || null;
    let condNorm: NormalizedListingCondition | null = null;
    let orderRowFound = false;

    if (amazonOrderId) {
      if (orderRowId && ORDER_ROW_UUID_RE.test(orderRowId)) {
        const { data: orderRow } = await supabase
          .from("amazon_orders")
          .select("asin, jan_code, sku, condition_id, amazon_order_id")
          .eq("id", orderRowId)
          .maybeSingle();
        if (orderRow && String(orderRow.amazon_order_id ?? "").trim() === amazonOrderId) {
          orderRowFound = true;
          asin = orderRow.asin?.trim() ?? null;
          if (!jan) jan = orderRow.jan_code?.trim() || (orderRow.sku?.trim().match(/^\d{13}$/) ? orderRow.sku.trim() : null);
          condNorm = normalizeOrderCondition(orderRow.condition_id);
        }
      } else {
        let q = supabase
          .from("amazon_orders")
          .select("asin, jan_code, sku, condition_id")
          .eq("amazon_order_id", amazonOrderId);
        if (sku) q = q.eq("sku", sku);
        const { data: orderRows } = await q.order("line_index", { ascending: true }).limit(1);
        const orderRow = orderRows?.[0];
        if (orderRow) {
          orderRowFound = true;
          asin = orderRow.asin?.trim() ?? null;
          if (!jan) jan = orderRow.jan_code?.trim() || (orderRow.sku?.trim().match(/^\d{13}$/) ? orderRow.sku.trim() : null);
          condNorm = normalizeOrderCondition(orderRow.condition_id);
        }
      }
    }

    if (orderRowFound && condNorm === null) {
      return NextResponse.json([]);
    }

    const applyCommonFilters = (qb: ReturnType<typeof baseInboundSelect>) => {
      let q = qb;
      if (amazonOrderId && orderRowFound) {
        q = q.or(orderIdAvailabilityOr(amazonOrderId));
      } else {
        q = q.or('order_id.is.null,order_id.eq.""');
      }
      if (condNorm) {
        q = q.or(conditionTypeOrFilter(condNorm));
      }
      return q.order("created_at", { ascending: true });
    };

    let data: Row[] = [];

    if (asin) {
      let janFromMaster: string | null = null;
      const { data: productRow } = await supabase.from("products").select("jan_code").eq("asin", asin).maybeSingle();
      if (productRow?.jan_code) janFromMaster = String(productRow.jan_code).trim();

      if (janFromMaster) {
        const { data: byJan, error: errJan } = await applyCommonFilters(
          baseInboundSelect().eq("jan_code", janFromMaster)
        );
        if (!errJan && byJan?.length) data = byJan;
      }

      if (data.length === 0) {
        const { data: byAsin, error: errAsin } = await applyCommonFilters(baseInboundSelect().eq("asin", asin));
        if (!errAsin && byAsin?.length) data = byAsin;
      }
    }
    if (data.length === 0 && jan) {
      const { data: byJan, error: errJan } = await applyCommonFilters(baseInboundSelect().eq("jan_code", jan));
      if (!errJan && byJan?.length) data = byJan;
    }

    const payload = (data ?? []).map((r) => ({
      id: r.id,
      jan_code: r.jan_code,
      brand: r.brand,
      model_number: r.model_number,
      effective_unit_price: Number(r.effective_unit_price ?? 0),
      condition_type: r.condition_type,
      created_at: r.created_at,
      order_id: r.order_id,
    }));
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
