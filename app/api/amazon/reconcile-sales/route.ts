/**
 * 本消込エンジン: sales_transactions と在庫（inbound_items）を紐付ける
 * POST: stock_id が未設定の通常売上を、amazon_order_id で仮消込済みの在庫1件とマッチさせて更新する。
 * inbound_items.settled_at には sales_transactions.posted_date の最早値を用いる（実行時刻は使わない）。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { earliestPostedDateIso } from "@/lib/settlement-posted-date";

export async function POST() {
  try {
    const { data: unlinkedRows, error: fetchError } = await supabase
      .from("sales_transactions")
      .select("id, amazon_order_id, posted_date")
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

    const typed = unlinkedRows as { amazon_order_id: string; posted_date: string | null }[];
    const orderIds = [...new Set(typed.map((r) => r.amazon_order_id).filter(Boolean))] as string[];

    const postedByOrder = new Map<string, string | null>();
    for (const oid of orderIds) {
      const rowsForOrder = typed.filter((r) => r.amazon_order_id === oid);
      postedByOrder.set(oid, earliestPostedDateIso(rowsForOrder));
    }

    let reconciledCount = 0;
    let skippedCount = 0;

    for (const amazonOrderId of orderIds) {
      const settledAt = postedByOrder.get(amazonOrderId) ?? null;
      if (!settledAt) {
        skippedCount += 1;
        continue;
      }

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

      const { error: updateTxError } = await supabase
        .from("sales_transactions")
        .update({ stock_id: stockId, unit_cost: unitCost })
        .eq("amazon_order_id", amazonOrderId);

      if (updateTxError) throw updateTxError;

      const { error: updateStockError } = await supabase
        .from("inbound_items")
        .update({ settled_at: settledAt })
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
