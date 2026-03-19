import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";

type OtherOrderRow = {
  id: string;
  order_id: string;
  platform: string;
  sell_price: number;
  jan_code: string | null;
  stock_id: number | null;
  status: string;
};

const buildTxEventHash = (payload: {
  orderId: string;
  platform: string;
  sellPrice: number;
}): string => {
  const raw = [payload.orderId, payload.platform, String(payload.sellPrice), "OtherSales", "Sell"].join("_");
  return createHash("sha256").update(raw).digest("hex");
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const otherOrderId = body?.otherOrderId != null ? String(body.otherOrderId).trim() : "";
    const stockId = body?.stockId != null ? Number(body.stockId) : NaN;

    if (!otherOrderId) return NextResponse.json({ error: "otherOrderId を指定してください。" }, { status: 400 });
    if (!Number.isFinite(stockId) || stockId < 1) return NextResponse.json({ error: "有効な stockId を指定してください。" }, { status: 400 });

    const { data: orderRow, error: orderErr } = await supabase
      .from("other_orders")
      .select("id, order_id, platform, sell_price, jan_code, stock_id, status")
      .eq("id", otherOrderId)
      .single();

    if (orderErr || !orderRow) {
      return NextResponse.json({ error: "該当する他販路注文が見つかりません。" }, { status: 404 });
    }

    const otherOrder = orderRow as OtherOrderRow;

    if (otherOrder.status !== "manual_required") {
      return NextResponse.json({ error: "この注文は手動消込対象ではありません。" }, { status: 400 });
    }

    const { data: stockRow, error: stockErr } = await supabase
      .from("inbound_items")
      .select("id, effective_unit_price")
      .eq("id", stockId)
      .single();

    if (stockErr || !stockRow) {
      return NextResponse.json({ error: "指定した在庫が見つかりません。" }, { status: 404 });
    }

    const unitCost = Number(stockRow.effective_unit_price ?? 0);
    const nowIso = new Date().toISOString();

    // 在庫更新（settled_at + order_id）
    const { error: updateStockErr } = await supabase
      .from("inbound_items")
      .update({ settled_at: nowIso, order_id: otherOrder.order_id })
      .eq("id", stockId);

    if (updateStockErr) throw updateStockErr;

    // 売上トランザクション作成（既存があれば upsert）
    const txEventHash = buildTxEventHash({
      orderId: otherOrder.order_id,
      platform: otherOrder.platform,
      sellPrice: Number(otherOrder.sell_price),
    });

    const insertPayload = {
      amazon_order_id: otherOrder.order_id,
      sku: null,
      transaction_type: "Order",
      amount_type: "Sell",
      amount_description: otherOrder.platform,
      amount: Number(otherOrder.sell_price),
      posted_date: nowIso,
      amazon_event_hash: txEventHash,
      stock_id: stockId,
      unit_cost: unitCost,
    };

    const { error: insertTxErr } = await supabase
      .from("sales_transactions")
      .upsert([insertPayload], { onConflict: "amazon_event_hash" })
      .select("id");

    if (insertTxErr) throw insertTxErr;

    // other_orders completed
    const { error: updErr } = await supabase
      .from("other_orders")
      .update({ status: "completed", stock_id: stockId, updated_at: nowIso })
      .eq("id", otherOrderId);

    if (updErr) throw updErr;

    return NextResponse.json({ ok: true, message: "手動消込を確定しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動消込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

