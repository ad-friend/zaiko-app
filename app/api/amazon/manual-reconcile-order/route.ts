/**
 * Order 手動本消込: 選択した在庫で売上明細を確定する
 * POST body: { groupId, stockId }
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const groupId = body.groupId != null ? String(body.groupId).trim() : "";
    const stockId = body.stockId != null ? Number(body.stockId) : NaN;

    if (!groupId) {
      return NextResponse.json({ error: "groupId（amazon_order_id）を指定してください。" }, { status: 400 });
    }
    if (!Number.isFinite(stockId) || stockId < 1) {
      return NextResponse.json({ error: "有効な stockId を指定してください。" }, { status: 400 });
    }

    const { data: stock, error: stockErr } = await supabase
      .from("inbound_items")
      .select("id, effective_unit_price")
      .eq("id", stockId)
      .single();

    if (stockErr || !stock) {
      return NextResponse.json({ error: "指定した在庫が見つかりません。" }, { status: 404 });
    }

    const unitCost = Number(stock.effective_unit_price ?? 0);
    const nowIso = new Date().toISOString();

    const { error: updateTxErr } = await supabase
      .from("sales_transactions")
      .update({ stock_id: stockId, unit_cost: unitCost })
      .eq("amazon_order_id", groupId)
      .is("stock_id", null);

    if (updateTxErr) throw updateTxErr;

    const { error: updateStockErr } = await supabase
      .from("inbound_items")
      .update({ settled_at: nowIso, order_id: groupId })
      .eq("id", stockId);

    if (updateStockErr) throw updateStockErr;

    return NextResponse.json({ ok: true, message: "本消込を完了しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動本消込に失敗しました。";
    console.error("[manual-reconcile-order]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
