/**
 * 他販路 手動在庫引当（manual_required → reconciled）
 * POST: { otherOrderId, stockId } — settled_at は付けない（本消込まで）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  OTHER_ORDER_STATUS_MANUAL_REQUIRED,
  OTHER_ORDER_STATUS_RECONCILED,
} from "@/lib/other-platform-reconciliation-status";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const otherOrderId = body?.otherOrderId != null ? String(body.otherOrderId).trim() : "";
    const stockId = body?.stockId != null ? Number(body.stockId) : NaN;

    if (!otherOrderId) return NextResponse.json({ error: "otherOrderId を指定してください。" }, { status: 400 });
    if (!Number.isFinite(stockId) || stockId < 1) {
      return NextResponse.json({ error: "有効な stockId を指定してください。" }, { status: 400 });
    }

    const { data: orderRow, error: orderErr } = await supabase
      .from("other_orders")
      .select("id, order_id, platform, jan_code, reconciliation_status")
      .eq("id", otherOrderId)
      .single();

    if (orderErr || !orderRow) {
      return NextResponse.json({ error: "該当する他販路注文が見つかりません。" }, { status: 404 });
    }

    if (orderRow.reconciliation_status !== OTHER_ORDER_STATUS_MANUAL_REQUIRED) {
      return NextResponse.json({ error: "この注文は手動引当対象ではありません。" }, { status: 400 });
    }

    const orderId = String(orderRow.order_id ?? "").trim();
    const { data: stockRow, error: stockErr } = await supabase
      .from("inbound_items")
      .select("id, jan_code")
      .eq("id", stockId)
      .is("settled_at", null)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .single();

    if (stockErr || !stockRow) {
      return NextResponse.json({ error: "指定した在庫が見つからないか、引当対象外です。" }, { status: 404 });
    }

    const { error: linkErr } = await supabase
      .from("inbound_items")
      .update({ order_id: orderId })
      .eq("id", stockId)
      .is("settled_at", null);

    if (linkErr) throw linkErr;

    const jan = String(orderRow.jan_code ?? stockRow.jan_code ?? "").trim() || null;
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("other_orders")
      .update({
        reconciliation_status: OTHER_ORDER_STATUS_RECONCILED,
        status: "completed",
        stock_id: stockId,
        jan_code: jan,
        updated_at: nowIso,
      })
      .eq("id", otherOrderId);

    if (updErr) throw updErr;

    return NextResponse.json({ ok: true, message: "手動在庫引当を確定しました。売上本消込は別ボタンから実行してください。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動引当に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
