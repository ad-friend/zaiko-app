/**
 * 本消込用の在庫候補を取得（Order 手動処理用）
 * GET: ?amazon_order_id=xxx&sku=xxx
 * 条件A: order_id が一致（仮消込済み）、条件B: order_id が NULL かつ jan_code が sku と一致（未紐付け在庫）
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

    // 条件A: 仮消込済み（order_id = amazon_order_id）
    if (amazonOrderId) {
      const { data: linked, error: errA } = await supabase
        .from("inbound_items")
        .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
        .eq("order_id", amazonOrderId)
        .is("settled_at", null)
        .order("created_at", { ascending: true });

      if (!errA && linked?.length) {
        for (const row of linked) {
          results.push({
            id: row.id,
            sku: row.jan_code ?? null,
            condition: row.condition_type ?? null,
            unit_cost: Number(row.effective_unit_price ?? 0),
            amazon_order_id: row.order_id ?? null,
            product_name: row.product_name ?? null,
            created_at: row.created_at ?? null,
          });
        }
      }
    }

    // 条件B: 未紐付け（order_id が NULL または空）、かつ sku（jan_code）一致があればそれで絞る
    if (sku) {
      const { data: unlinked, error: errB } = await supabase
        .from("inbound_items")
        .select("id, jan_code, condition_type, effective_unit_price, order_id, product_name, created_at")
        .is("settled_at", null)
        .or('order_id.is.null,order_id.eq.""') // order_idが空のものだけ
        .eq("jan_code", sku) // 👈 【超重要】データベース側で直接 jan_code = sku のものだけを検索！
        .order("created_at", { ascending: true });

      if (!errB && unlinked?.length) {
        const seen = new Set(results.map((r) => r.id));
        for (const row of unlinked) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          results.push({
            id: row.id,
            sku: row.jan_code?.trim() ?? null,
            condition: row.condition_type ?? null,
            unit_cost: Number(row.effective_unit_price ?? 0),
            amazon_order_id: row.order_id ?? null,
            product_name: row.product_name ?? null,
            created_at: row.created_at ?? null,
          });
        }
      }
    }

    return NextResponse.json(results);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}