/**
 * 手動消込確定
 * POST: body { amazon_order_id, inbound_item_id, amazon_order_db_id?（推奨: amazon_orders.id） }
 * 在庫に注文番号を書き込み、該当注文行を reconciled にする。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
} from "@/lib/amazon-order-reconciliation-status";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const amazonOrderId = body.amazon_order_id != null ? String(body.amazon_order_id).trim() : "";
    const inboundItemId = body.inbound_item_id != null ? Number(body.inbound_item_id) : NaN;
    const orderDbIdRaw = body.amazon_order_db_id ?? body.order_id;
    const orderDbId = orderDbIdRaw != null ? Number(orderDbIdRaw) : NaN;
    const skuFromBody = body.sku != null ? String(body.sku).trim() : "";

    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id を指定してください。" }, { status: 400 });
    }
    if (!Number.isFinite(inboundItemId) || inboundItemId < 1) {
      return NextResponse.json({ error: "有効な inbound_item_id を指定してください。" }, { status: 400 });
    }

    let orderRow: { id: number; reconciliation_status: string; amazon_order_id: string } | null = null;

    if (Number.isFinite(orderDbId) && orderDbId > 0) {
      const { data, error } = await supabase
        .from("amazon_orders")
        .select("id, reconciliation_status, amazon_order_id")
        .eq("id", orderDbId)
        .single();
      if (error || !data) {
        return NextResponse.json({ error: "該当するAmazon注文が見つかりません。" }, { status: 404 });
      }
      if (String(data.amazon_order_id).trim() !== amazonOrderId) {
        return NextResponse.json({ error: "注文IDと明細行が一致しません。" }, { status: 400 });
      }
      orderRow = data;
    } else {
      let q = supabase
        .from("amazon_orders")
        .select("id, reconciliation_status, amazon_order_id")
        .eq("amazon_order_id", amazonOrderId);
      if (skuFromBody) q = q.eq("sku", skuFromBody);
      const { data, error } = await q.maybeSingle();
      if (error || !data) {
        return NextResponse.json(
          { error: "該当するAmazon注文が見つかりません。複数明細がある場合は amazon_order_db_id を送ってください。" },
          { status: 404 }
        );
      }
      orderRow = data;
    }

    const st = orderRow.reconciliation_status;
    if (st === "canceled") {
      return NextResponse.json({ error: "この注文はキャンセル済みのため消込できません。" }, { status: 400 });
    }
    if (st === AMAZON_ORDER_STATUS_RECONCILED || st === "completed") {
      return NextResponse.json({ error: "この注文はすでに仮消込済みです。" }, { status: 400 });
    }
    if (st !== AMAZON_ORDER_STATUS_MANUAL_REQUIRED && st !== AMAZON_ORDER_STATUS_PENDING) {
      return NextResponse.json({ error: "この注文は手動消込の対象状態ではありません。" }, { status: 400 });
    }

    const { error: updateItemErr } = await supabase
      .from("inbound_items")
      .update({ order_id: amazonOrderId })
      .eq("id", inboundItemId);

    if (updateItemErr) throw updateItemErr;

    const { data: updatedRows, error: updateOrderErr } = await supabase
      .from("amazon_orders")
      .update({ reconciliation_status: AMAZON_ORDER_STATUS_RECONCILED, updated_at: new Date().toISOString() })
      .eq("id", orderRow.id)
      .eq("reconciliation_status", st)
      .select("id");

    if (updateOrderErr) throw updateOrderErr;
    if (!updatedRows?.length) {
      await supabase.from("inbound_items").update({ order_id: null }).eq("id", inboundItemId).eq("order_id", amazonOrderId);
      return NextResponse.json(
        { error: "注文ステータスの更新に失敗しました（他処理で状態が変わった可能性があります）。" },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, message: "手動消込を確定しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動消込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
