/**
 * 本消込用の在庫候補を取得（Order 手動処理用）
 * GET: ?amazon_order_id=xxx&sku=xxx
 * GET: ?amazon_order_id=xxx&search=テキスト — カタログ消滅時のレスキュー検索（JAN・商品名の部分一致）
 * 注文の asin と在庫(inbound_items)の asin が一致する在庫を検索。表示用には在庫側の jan_code を返す。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

const SEARCH_MAX_LEN = 120;

function orderIdAvailabilityOr(amazonOrderId: string): string {
  const id = amazonOrderId.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `order_id.is.null,order_id.eq."${id}",order_id.eq.""`;
}

const toRow = (row: {
  id: number;
  jan_code: string | null;
  condition_type: string | null;
  effective_unit_price: unknown;
  order_id: string | null;
  product_name: string | null;
  created_at: string | null;
}) => ({
  id: row.id,
  sku: row.jan_code?.trim() ?? null,
  condition: row.condition_type ?? null,
  unit_cost: Number(row.effective_unit_price ?? 0),
  amazon_order_id: row.order_id ?? null,
  product_name: row.product_name ?? null,
  created_at: row.created_at ?? null,
});

function buildRescueBase(amazonOrderId: string) {
  let q = supabase
    .from("inbound_items")
    .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
    .is("exit_type", null);
  if (amazonOrderId) {
    q = q.or(orderIdAvailabilityOr(amazonOrderId));
  } else {
    q = q.or("order_id.is.null,order_id.eq.\"\"");
  }
  return q;
}

/**
 * レスキュー検索: JAN または商品名に部分一致。引当可能・検品待ち以外の除外は既存と同じ。
 */
async function searchInboundRescue(search: string, amazonOrderId: string): Promise<
  Array<{
    id: number;
    sku: string | null;
    condition: string | null;
    unit_cost: number;
    amazon_order_id: string | null;
    product_name: string | null;
    created_at: string | null;
  }>
> {
  const q = search.trim();
  if (q.length < 1) return [];

  const like = `%${q}%`;
  const [janRes, nameRes] = await Promise.all([
    buildRescueBase(amazonOrderId).ilike("jan_code", like).order("created_at", { ascending: true }).limit(80),
    buildRescueBase(amazonOrderId).ilike("product_name", like).order("created_at", { ascending: true }).limit(80),
  ]);

  if (janRes.error) throw janRes.error;
  if (nameRes.error) throw nameRes.error;

  const rows = [...(janRes.data ?? []), ...(nameRes.data ?? [])];
  const seen = new Set<number>();
  const out: ReturnType<typeof toRow>[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(toRow(row as Parameters<typeof toRow>[0]));
  }
  out.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  return out.slice(0, 80);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id")?.trim() ?? "";
    const sku = searchParams.get("sku")?.trim() ?? "";
    const searchRaw = searchParams.get("search")?.trim() ?? "";

    if (searchRaw.length > 0) {
      if (searchRaw.length > SEARCH_MAX_LEN) {
        return NextResponse.json({ error: `search は ${SEARCH_MAX_LEN} 文字以内にしてください。` }, { status: 400 });
      }
      const rescue = await searchInboundRescue(searchRaw, amazonOrderId);
      return NextResponse.json(rescue);
    }

    const results: Array<{
      id: number;
      sku: string | null;
      condition: string | null;
      unit_cost: number;
      amazon_order_id: string | null;
      product_name: string | null;
      created_at: string | null;
    }> = [];

    // 条件A: 仮消込済み（order_id = amazon_order_id）
    if (amazonOrderId) {
      const { data: linked, error: errA } = await supabase
        .from("inbound_items")
        .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
        .eq("order_id", amazonOrderId)
        .is("settled_at", null)
        .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
        .order("created_at", { ascending: true });

      if (!errA && linked?.length) {
        results.push(...linked.map(toRow));
      }
    }

    // 条件B: 注文ASIN → 商品マスタ(products)でJAN取得 → inbound_itemsをJANで検索（パフォーマンス最適化）。マスタに無い場合はASINで直接検索（フォールバック）
    let orderAsin: string | null = null;
    if (amazonOrderId && sku) {
      const { data: orderRow } = await supabase
        .from("amazon_orders")
        .select("asin")
        .eq("amazon_order_id", amazonOrderId)
        .eq("sku", sku)
        .maybeSingle();
      orderAsin = orderRow?.asin?.trim() ?? null;
    } else if (amazonOrderId) {
      const { data: orderRows } = await supabase
        .from("amazon_orders")
        .select("asin")
        .eq("amazon_order_id", amazonOrderId)
        .limit(1);
      orderAsin = orderRows?.[0]?.asin?.trim() ?? null;
    }

    if (orderAsin) {
      console.log(`\n================================`);
      console.log(`[LOG] ① 注文データのASIN: ${orderAsin}`);
      const countBeforeConditionB = results.length;
      let janFromMaster: string | null = null;
      const { data: productRow, error: productError } = await supabase
        .from("products")
        .select("jan_code")
        .eq("asin", orderAsin)
        .maybeSingle();

      console.log(`[LOG] ② Supabase検索エラー?:`, productError);
      console.log(`[LOG] ③ マスタからの取得データ:`, JSON.stringify(productRow));

      if (productRow?.jan_code) janFromMaster = String(productRow.jan_code).trim();

      console.log(`[LOG] ④ 最終的にセットされたJAN: ${janFromMaster}`);
      console.log(`================================\n`);
      if (janFromMaster) {
        const { data: unlinked, error: errB } = await supabase
          .from("inbound_items")
          .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
          .is("settled_at", null)
          .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
          .or('order_id.is.null,order_id.eq.""')
          .eq("jan_code", janFromMaster)
          .order("created_at", { ascending: true });

        if (!errB && unlinked?.length) {
          const seen = new Set(results.map((r) => r.id));
          for (const row of unlinked) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            results.push(toRow(row));
          }
        }
      }

      if (results.length === countBeforeConditionB) {
        const { data: unlinked, error: errFallback } = await supabase
          .from("inbound_items")
          .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
          .is("settled_at", null)
          .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
          .or('order_id.is.null,order_id.eq.""')
          .eq("asin", orderAsin)
          .order("created_at", { ascending: true });

        if (!errFallback && unlinked?.length) {
          const seen = new Set(results.map((r) => r.id));
          for (const row of unlinked) {
            if (seen.has(row.id)) continue;
            results.push(toRow(row));
          }
        }
      }
    }

    return NextResponse.json(results);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
