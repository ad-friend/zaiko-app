/**
 * 手動消込確定
 * POST: body {
 *   amazon_order_id,
 *   amazon_order_db_id?（推奨: amazon_orders.id = UUID）,
 *   inbound_item_id? または inbound_item_ids?: number[],
 *   set_reconcile?: true,
 *   seller_sku?: string（set_reconcile 時は必須。SKUマスタの出品SKU）
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
  AMAZON_ORDER_STATUS_RETURNED,
} from "@/lib/amazon-order-reconciliation-status";
import {
  parseOrderConditionForManual,
  validateSetManualPicks,
  validateSingleJanMultiQtyPicks,
} from "@/lib/amazon-manual-reconcile-helpers";

type AmazonOrderRowForManual = {
  id: string;
  reconciliation_status: string;
  amazon_order_id: string;
  quantity: number | null;
  jan_code: string | null;
  condition_id: string | null;
};

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

function parseInboundIds(body: Record<string, unknown>): number[] {
  const raw = body.inbound_item_ids;
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const x of raw) {
      const n = Number(x);
      if (Number.isFinite(n) && n >= 1) out.push(Math.floor(n));
    }
    return out;
  }
  const one = body.inbound_item_id;
  if (one != null) {
    const n = Number(one);
    if (Number.isFinite(n) && n >= 1) return [Math.floor(n)];
  }
  return [];
}

async function unlinkInboundsFromOrder(inboundIds: number[], amazonOrderId: string): Promise<void> {
  if (inboundIds.length === 0) return;
  await supabase.from("inbound_items").update({ order_id: null }).in("id", inboundIds).eq("order_id", amazonOrderId);
}

async function appendManualReconcileMemoOrLog(inboundIds: number[], message: string): Promise<void> {
  if (inboundIds.length === 0) return;
  const msg = message.trim();
  if (!msg) return;

  // internal_note → admin_memo のみに限定
  {
    const res = await supabase.from("inbound_items").select("id, internal_note").in("id", inboundIds);
    if (!res.error) {
      const rows = (res.data ?? []) as Array<{ id: number; internal_note: string | null }>;
      for (const r of rows) {
        const prev = String(r.internal_note ?? "").trim();
        const next = [prev, msg].filter(Boolean).join("\n");
        const u = await supabase.from("inbound_items").update({ internal_note: next }).eq("id", r.id);
        if (u.error) throw u.error;
      }
      return;
    }
  }
  {
    const res = await supabase.from("inbound_items").select("id, admin_memo").in("id", inboundIds);
    if (!res.error) {
      const rows = (res.data ?? []) as Array<{ id: number; admin_memo: string | null }>;
      for (const r of rows) {
        const prev = String(r.admin_memo ?? "").trim();
        const next = [prev, msg].filter(Boolean).join("\n");
        const u = await supabase.from("inbound_items").update({ admin_memo: next }).eq("id", r.id);
        if (u.error) throw u.error;
      }
      return;
    }
  }
  console.log(msg, { inboundIds });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const amazonOrderId = body.amazon_order_id != null ? String(body.amazon_order_id).trim() : "";
    const skuFromBody = body.sku != null ? String(body.sku).trim() : "";
    const rowUuid = parseAmazonOrderRowUuid(body);
    const setReconcile = body.set_reconcile === true;
    const sellerSku = body.seller_sku != null ? String(body.seller_sku).trim() : "";
    const inboundIds = parseInboundIds(body);

    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id を指定してください。" }, { status: 400 });
    }
    if (inboundIds.length === 0) {
      return NextResponse.json({ error: "inbound_item_id または inbound_item_ids を指定してください。" }, { status: 400 });
    }
    if (inboundIds.length > 1) {
      const uniq = new Set(inboundIds);
      if (uniq.size !== inboundIds.length) {
        return NextResponse.json({ error: "同じ在庫IDを重複して選べません。" }, { status: 400 });
      }
    }

    let orderRow: AmazonOrderRowForManual | null = null;

    if (rowUuid) {
      const { data, error } = await supabase
        .from("amazon_orders")
        .select("id, reconciliation_status, amazon_order_id, quantity, jan_code, condition_id")
        .eq("id", rowUuid)
        .single();
      if (error || !data) {
        return NextResponse.json({ error: "該当するAmazon注文が見つかりません。" }, { status: 404 });
      }
      if (String(data.amazon_order_id).trim() !== amazonOrderId) {
        return NextResponse.json({ error: "注文IDと明細行が一致しません。" }, { status: 400 });
      }
      orderRow = data as AmazonOrderRowForManual;
    } else {
      let q = supabase
        .from("amazon_orders")
        .select("id, reconciliation_status, amazon_order_id, quantity, jan_code, condition_id")
        .eq("amazon_order_id", amazonOrderId);
      if (skuFromBody) q = q.eq("sku", skuFromBody);
      const { data, error } = await q.maybeSingle();
      if (error || !data) {
        return NextResponse.json(
          { error: "該当するAmazon注文が見つかりません。複数明細がある場合は amazon_order_db_id（UUID）を送ってください。" },
          { status: 404 }
        );
      }
      orderRow = data as AmazonOrderRowForManual;
    }

    if (!orderRow) {
      return NextResponse.json({ error: "該当するAmazon注文が見つかりません。" }, { status: 404 });
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

    const orderQty = Math.max(1, Number(orderRow.quantity) || 1);
    const orderCond = parseOrderConditionForManual(orderRow.condition_id);
    if (!orderCond) {
      return NextResponse.json({ error: "注文のコンディションが未設定です。カード上で新品/中古を設定してください。" }, { status: 400 });
    }

    // 手動ルートのみ: 注文JAN≠在庫JANを許容。ただし不一致時は監査用に記録を残す。
    let pickedJan: string | null = null;
    let orderJan: string | null = orderRow.jan_code != null ? String(orderRow.jan_code).trim() || null : null;
    let janMismatch = false;

    if (setReconcile) {
      if (!sellerSku) {
        return NextResponse.json({ error: "セット消込では seller_sku（出品SKU）を指定してください。" }, { status: 400 });
      }
      const v = await validateSetManualPicks(supabase, {
        amazonOrderId,
        orderCond,
        orderQty,
        sellerSku,
        inboundIds,
      });
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      // セットは構成上JANが複数になり得るため、単品の不一致ログ（orderJan/stockJan）とは別物になりやすい。
      // 要件のログ形式は単品救済を主眼とし、ここでは janMismatch 記録は行わない。
      pickedJan = v.janForOrder;
      janMismatch = false;
    } else {
      const v = await validateSingleJanMultiQtyPicks(supabase, {
        amazonOrderId,
        orderCond,
        orderQty,
        orderJan,
        inboundIds,
      });
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      pickedJan = v.pickedJan;
      orderJan = v.orderJan;
      janMismatch = v.janMismatch;
    }

    const linked: number[] = [];
    for (const id of inboundIds) {
      const { error: updateItemErr } = await supabase
        .from("inbound_items")
        .update({ order_id: amazonOrderId })
        .eq("id", id);
      if (updateItemErr) {
        await unlinkInboundsFromOrder(linked, amazonOrderId);
        throw updateItemErr;
      }
      linked.push(id);
    }

    const { data: updatedRows, error: updateOrderErr } = await supabase
      .from("amazon_orders")
      .update({
        reconciliation_status: AMAZON_ORDER_STATUS_RECONCILED,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderRow.id)
      .eq("reconciliation_status", st)
      .select("id");

    if (updateOrderErr) {
      await unlinkInboundsFromOrder(inboundIds, amazonOrderId);
      throw updateOrderErr;
    }
    if (!updatedRows?.length) {
      await unlinkInboundsFromOrder(inboundIds, amazonOrderId);
      return NextResponse.json(
        { error: "注文ステータスの更新に失敗しました（他処理で状態が変わった可能性があります）。" },
        { status: 409 }
      );
    }

    if (janMismatch) {
      const msg = `[ManualReconcile] orderJan: ${orderJan ?? "—"}, stockJan: ${pickedJan ?? "—"}`;
      await appendManualReconcileMemoOrLog(inboundIds, msg);
    }

    return NextResponse.json({ ok: true, message: "手動消込を確定しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動消込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
