/**
 * 手動消込用：指定注文に紐づく在庫候補一覧
 * GET: ?amazon_order_id=xxx&sku=xxx または ?jan_code=xxx
 * 注文の asin / jan と在庫を突き合わせ、condition は大小文字を区別しない（ilike 等）で一致させる。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { normalizeOrderCondition, type NormalizedListingCondition } from "@/lib/amazon-condition-match";

/** PostgREST: 未割当または同一 Amazon 注文への仮引当のみ */
function orderIdAvailabilityOr(amazonOrderId: string): string {
  const id = amazonOrderId.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `order_id.is.null,order_id.eq."${id}"`;
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
  product_name: string | null;
  condition_type: string | null;
  created_at: string | null;
  order_id: string | null;
};

function baseInboundSelect() {
  return supabase
    .from("inbound_items")
    .select("id, jan_code, product_name, condition_type, created_at, order_id")
    .is("settled_at", null);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id")?.trim() ?? "";
    const sku = searchParams.get("sku")?.trim() ?? "";
    const janCode = searchParams.get("jan_code")?.trim() ?? "";

    if (!amazonOrderId && !janCode) {
      return NextResponse.json({ error: "amazon_order_id または jan_code を指定してください。" }, { status: 400 });
    }

    let asin: string | null = null;
    let jan: string | null = janCode || null;
    let condNorm: NormalizedListingCondition | null = null;
    let orderRowFound = false;

    if (amazonOrderId) {
      const q = supabase
        .from("amazon_orders")
        .select("asin, jan_code, sku, condition_id")
        .eq("amazon_order_id", amazonOrderId);
      if (sku) q.eq("sku", sku);
      const { data: orderRow } = await q.maybeSingle();
      if (orderRow) {
        orderRowFound = true;
        asin = orderRow.asin?.trim() ?? null;
        if (!jan) jan = orderRow.jan_code?.trim() || (orderRow.sku?.trim().match(/^\d{13}$/) ? orderRow.sku.trim() : null);
        condNorm = normalizeOrderCondition(orderRow.condition_id);
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
        q = q.is("order_id", null);
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

    return NextResponse.json(data);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
