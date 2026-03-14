/**
 * 本消込エンジン: sales_transactions と在庫（inbound_items）を紐付ける
 * POST: stock_id が未設定の通常売上を、amazon_order_id で仮消込済みの在庫1件とマッチさせて更新する。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST() {
  try {
    const { data: unlinkedRows, error: fetchError } = await supabase
      .from("sales_transactions")
      .select("id, amazon_order_id")
      .not("amazon_order_id", "is", null)
      .is("stock_id", null)
      .eq("transaction_type", "Order");

    if (fetchError) throw fetchError;
    if (!unlinkedRows?.length) {
      return NextResponse.json({
        ok: true,
        reconciledCount: 0,
        skippedCount: 0,
        message: "本消込対象の売上明細がありません。",
      });
    }

    const orderIds = [...new Set((unlinkedRows as { amazon_order_id: string }[]).map((r) => r.amazon_order_id).filter(Boolean))] as string[];
    let reconciledCount = 0;
    let skippedCount = 0;

    for (const amazonOrderId of orderIds) {
      const { data: stocks, error: stocksError } = await supabase
        .from("inbound_items")
        .select("id, effective_unit_price, settled_at")
        .eq("order_id", amazonOrderId);

      if (stocksError) throw stocksError;
      const list = stocks ?? [];
      if (list.length !== 1) {
        skippedCount += 1;
        continue;
      }

      const stock = list[0] as { id: number; effective_unit_price: number; settled_at: string | null };
      const stockId = stock.id;
      const unitCost = Number(stock.effective_unit_price) ?? 0;
      const nowIso = new Date().toISOString();

      const { error: updateTxError } = await supabase
        .from("sales_transactions")
        .update({ stock_id: stockId, unit_cost: unitCost })
        .eq("amazon_order_id", amazonOrderId);

      if (updateTxError) throw updateTxError;

      const { error: updateStockError } = await supabase
        .from("inbound_items")
        .update({ settled_at: nowIso })
        .eq("id", stockId);

      if (updateStockError) throw updateStockError;

      reconciledCount += 1;
    }

    return NextResponse.json({
      ok: true,
      reconciledCount,
      skippedCount,
      message: `本消込: ${reconciledCount}件成功 (保留: ${skippedCount}件)`,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "本消込処理に失敗しました。";
    console.error("[reconcile-sales]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
