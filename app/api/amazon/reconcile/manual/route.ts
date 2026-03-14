/**
 * 手動消込確定
 * POST: body { amazon_order_id: string, inbound_item_id: number }
 * 指定した在庫に注文番号を書き込み、該当注文を completed にする。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const amazonOrderId = body.amazon_order_id != null ? String(body.amazon_order_id).trim() : "";
    const inboundItemId = body.inbound_item_id != null ? Number(body.inbound_item_id) : NaN;

    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id を指定してください。" }, { status: 400 });
    }
    if (!Number.isFinite(inboundItemId) || inboundItemId < 1) {
      return NextResponse.json({ error: "有効な inbound_item_id を指定してください。" }, { status: 400 });
    }

    const { data: orderRow, error: orderErr } = await supabase
      .from("amazon_orders")
      .select("id, reconciliation_status")
      .eq("amazon_order_id", amazonOrderId)
      .single();

    if (orderErr || !orderRow) {
      return NextResponse.json({ error: "該当するAmazon注文が見つかりません。" }, { status: 404 });
    }
    if (orderRow.reconciliation_status !== "manual_required") {
      return NextResponse.json({ error: "この注文は手動消込対象ではありません。" }, { status: 400 });
    }

    const { error: updateItemErr } = await supabase
      .from("inbound_items")
      .update({ order_id: amazonOrderId })
      .eq("id", inboundItemId);

    if (updateItemErr) throw updateItemErr;

    const { error: updateOrderErr } = await supabase
      .from("amazon_orders")
      .update({ reconciliation_status: "completed", updated_at: new Date().toISOString() })
      .eq("amazon_order_id", amazonOrderId);

    if (updateOrderErr) throw updateOrderErr;

    return NextResponse.json({ ok: true, message: "手動消込を確定しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動消込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
