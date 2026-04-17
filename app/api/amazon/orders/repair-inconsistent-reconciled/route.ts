/**
 * reconciled / completed なのに在庫（inbound_items.order_id）に紐付けが無い注文の復旧。
 * POST JSON: { orderRowId: string } — amazon_orders.id（UUID）
 *
 * - inbound_items の order_id / settled_at を注文番号単位で解除（cancel モード）
 * - 同一 amazon_order_id の reconciled / completed 行を manual_required に戻す
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { releaseInboundItemsForAmazonOrder } from "@/lib/amazon-order-inventory-release";
import { AMAZON_ORDER_STATUS_MANUAL_REQUIRED } from "@/lib/amazon-order-reconciliation-status";

const RECONCILED_LIKE = ["reconciled", "completed"] as const;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { orderRowId?: unknown } | null;
    const orderRowId = body?.orderRowId != null ? String(body.orderRowId).trim() : "";
    if (!orderRowId) {
      return NextResponse.json({ error: "orderRowId（amazon_orders.id）を指定してください。" }, { status: 400 });
    }

    const { data: row, error: selErr } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, reconciliation_status")
      .eq("id", orderRowId)
      .maybeSingle();

    if (selErr) throw selErr;
    if (!row) {
      return NextResponse.json({ error: "該当する注文行が見つかりません。" }, { status: 404 });
    }

    const st = String(row.reconciliation_status ?? "").trim().toLowerCase();
    if (!RECONCILED_LIKE.includes(st as (typeof RECONCILED_LIKE)[number])) {
      return NextResponse.json(
        { error: "reconciled / completed の行のみ復旧できます。" },
        { status: 400 }
      );
    }

    const amazonOrderId = String(row.amazon_order_id ?? "").trim();
    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id が空です。" }, { status: 400 });
    }

    const rel = await releaseInboundItemsForAmazonOrder(amazonOrderId, "cancel");
    if (!rel.ok) {
      return NextResponse.json({ error: rel.message }, { status: 500 });
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from("amazon_orders")
      .update({
        reconciliation_status: AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
        updated_at: nowIso,
      })
      .eq("amazon_order_id", amazonOrderId)
      .in("reconciliation_status", [...RECONCILED_LIKE])
      .select("id");

    if (updErr) throw updErr;

    return NextResponse.json({
      ok: true,
      amazon_order_id: amazonOrderId,
      rows_updated: Array.isArray(updated) ? updated.length : 0,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "復旧に失敗しました。";
    console.error("[repair-inconsistent-reconciled]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
