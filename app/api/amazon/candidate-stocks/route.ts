/**
 * 本消込用の在庫候補を取得（Order 手動処理用）
 * GET: ?amazon_order_id=xxx&sku=xxx
 * 注文の asin と在庫(inbound_items)の asin が一致する在庫を検索。表示用には在庫側の jan_code を返す。
 * 条件A: 仮消込済み（order_id 一致）、条件B: 未紐付けで asin 一致（JAN主軸の汎用構造）。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id")?.trim() ?? "";
    const sku = searchParams.get("sku")?.trim() ?? "";

    const results: Array<{
      id: number;
      sku: string | null;
      condition: string | null;
      unit_cost: number;
      amazon_order_id: string | null;
      product_name: string | null;
      created_at: string | null;
    }> = [];

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

    // 条件A: 仮消込済み（order_id = amazon_order_id）
    if (amazonOrderId) {
      const { data: linked, error: errA } = await supabase
        .from("inbound_items")
        .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
        .eq("order_id", amazonOrderId)
        .is("settled_at", null)
        .order("created_at", { ascending: true });

      if (!errA && linked?.length) {
        results.push(...linked.map(toRow));
      }
    }

    // 条件B: 注文の ASIN と在庫の ASIN が一致する未紐付け在庫を検索（表示用SKU/JANは jan_code）
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
      const { data: unlinked, error: errB } = await supabase
        .from("inbound_items")
        .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
        .is("settled_at", null)
        .or('order_id.is.null,order_id.eq.""')
        .eq("asin", orderAsin)
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

    return NextResponse.json(results);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}