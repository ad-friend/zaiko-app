/**
 * Order 手動本消込: 選択した在庫で売上明細を確定する
 * POST body: { groupId, stockId }
 * settled_at は未紐付け売上明細の posted_date の最早値（実行時刻は使わない）。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { earliestPostedDateIso } from "@/lib/settlement-posted-date";

function escapePostgrestQuotedValue(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * PostgREST `.or()` で「在庫状態OK」かつ「order_id可用性OK」を同時に満たすための式を生成する。
 *
 * - 状態OK: stock_status is null OR available（INBOUND_FILTER_SALABLE_FOR_ALLOCATION）
 * - 紐付けOK: order_id is null OR empty OR eq(groupId)
 *
 * PostgREST の or= は単純な OR なので、
 *   (statusOK) AND (orderIdOK)
 * を表現するために
 *   or(and(statusCase1,orderIdOK),and(statusCase2,orderIdOK))
 * の形に展開する。
 */
function inboundEligibilityOrForManual(groupId: string): string {
  const id = escapePostgrestQuotedValue(String(groupId ?? "").trim());
  const orderAvail = `order_id.is.null,order_id.eq."${id}",order_id.eq.""`;
  // INBOUND_FILTER_SALABLE_FOR_ALLOCATION は "stock_status.is.null,stock_status.eq.available"
  return [
    `and(stock_status.is.null,or(${orderAvail}))`,
    `and(stock_status.eq.available,or(${orderAvail}))`,
  ].join(",");
}

async function appendManualReconcileMemoOrLog(inboundId: number, message: string): Promise<void> {
  const msg = message.trim();
  if (!msg) return;

  // internal_note → admin_memo のみに限定
  {
    const res = await supabase.from("inbound_items").select("id, internal_note").eq("id", inboundId).maybeSingle();
    if (!res.error && res.data) {
      const prev = String((res.data as any).internal_note ?? "").trim();
      const next = [prev, msg].filter(Boolean).join("\n");
      const u = await supabase.from("inbound_items").update({ internal_note: next }).eq("id", inboundId);
      if (u.error) throw u.error;
      return;
    }
  }
  {
    const res = await supabase.from("inbound_items").select("id, admin_memo").eq("id", inboundId).maybeSingle();
    if (!res.error && res.data) {
      const prev = String((res.data as any).admin_memo ?? "").trim();
      const next = [prev, msg].filter(Boolean).join("\n");
      const u = await supabase.from("inbound_items").update({ admin_memo: next }).eq("id", inboundId);
      if (u.error) throw u.error;
      return;
    }
  }
  console.log(msg, { inboundId });
}

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

    const { data: txBefore, error: txFetchErr } = await supabase
      .from("sales_transactions")
      .select("posted_date")
      .eq("amazon_order_id", groupId)
      .is("stock_id", null);

    if (txFetchErr) throw txFetchErr;
    const settledAt = earliestPostedDateIso(txBefore ?? []);
    if (!settledAt) {
      return NextResponse.json(
        { error: "未紐付けの売上明細に有効な posted_date がありません。決済データ取込を確認してください。" },
        { status: 400 }
      );
    }

    const eligibilityOr = inboundEligibilityOrForManual(groupId);

    const { data: stock, error: stockErr } = await supabase
      .from("inbound_items")
      .select("id, jan_code, effective_unit_price")
      .eq("id", stockId)
      .is("settled_at", null)
      .is("exit_type", null)
      // 返品検品待ち等の除外 + order_id 可用性（NULL/空/同一注文）を同時に満たす
      .or(eligibilityOr)
      .single();

    if (stockErr || !stock) {
      return NextResponse.json(
        { error: "指定した在庫が見つからないか、引当対象外です（状態/紐付けを確認してください）。" },
        { status: 404 }
      );
    }

    const unitCost = Number(stock.effective_unit_price ?? 0);

    const { error: updateTxErr } = await supabase
      .from("sales_transactions")
      .update({ stock_id: stockId, unit_cost: unitCost })
      .eq("amazon_order_id", groupId)
      .is("stock_id", null);

    if (updateTxErr) throw updateTxErr;

    const { error: updateStockErr } = await supabase
      .from("inbound_items")
      .update({ settled_at: settledAt, order_id: groupId })
      .eq("id", stockId)
      .is("settled_at", null)
      .is("exit_type", null)
      .or(eligibilityOr);

    if (updateStockErr) throw updateStockErr;

    // 注文JANを取得し、在庫JANと不一致なら記録（手動ルートのみ / UI追加なし）
    let orderJan: string | null = null;
    {
      const res = await supabase
        .from("amazon_orders")
        .select("jan_code")
        .eq("amazon_order_id", groupId)
        .limit(1);
      if (!res.error) {
        const row = (res.data ?? [])[0] as any;
        orderJan = row?.jan_code != null ? String(row.jan_code).trim() || null : null;
      }
    }
    const stockJan = (stock as any).jan_code != null ? String((stock as any).jan_code).trim() || null : null;
    if (orderJan && stockJan && orderJan !== stockJan) {
      const msg = `[ManualReconcile] orderJan: ${orderJan}, stockJan: ${stockJan}`;
      await appendManualReconcileMemoOrLog(stockId, msg);
    }

    return NextResponse.json({ ok: true, message: "本消込を完了しました。" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "手動本消込に失敗しました。";
    console.error("[manual-reconcile-order]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
