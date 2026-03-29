/**
 * 手動消込確定
 * POST: body { amazon_order_id, inbound_item_id, amazon_order_db_id?（推奨: amazon_orders.id = UUID） }
 * 在庫に注文番号を書き込み、該当注文行を reconciled にする。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
  AMAZON_ORDER_STATUS_RETURNED,
} from "@/lib/amazon-order-reconciliation-status";

const AMAZON_ORDER_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAmazonOrderRowUuid(body: Record<string, unknown>): string | null {
  const candidates = [body.amazon_order_db_id, body.id];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t.length > 0 && AMAZON_ORDER_ROW_UUID_RE.test(t)) return t;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const amazonOrderId = body.amazon_order_id != null ? String(body.amazon_order_id).trim() : "";
    const inboundItemId = body.inbound_item_id != null ? Number(body.inbound_item_id) : NaN;
    const skuFromBody = body.sku != null ? String(body.sku).trim() : "";
    const rowUuid = parseAmazonOrderRowUuid(body);

    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id を指定してください。" }, { status: 400 });
    }
    if (!Number.isFinite(inboundItemId) || inboundItemId < 1) {
      return NextResponse.json({ error: "有効な inbound_item_id を指定してください。" }, { status: 400 });
    }

    let orderRow: { id: string; reconciliation_status: string; amazon_order_id: string } | null = null;

    if (rowUuid) {
      const { data, error } = await supabase
        .from("amazon_orders")
        .select("id, reconciliation_status, amazon_order_id")
        .eq("id", rowUuid)
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
          { error: "該当するAmazon注文が見つかりません。複数明細がある場合は amazon_order_db_id（UUID）を送ってください。" },
          { status: 404 }
        );
      }
      orderRow = data;
    }

    const st = orderRow.reconciliation_status;
    if (st === "canceled" || st === "cancelled") {
      return NextResponse.json({ error: "この注文はキャンセル済みのため消込できません。" }, { status: 400 });
    }
    if (st === AMAZON_ORDER_STATUS_RETURNED) {
      return NextResponse.json({ error: "この注文は返品処理済みのため消込できません。" }, { status: 400 });
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
