import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { markSalesTransactionsReconciled } from "@/lib/amazon-sales-tx-mark-reconciled";

function norm(v: unknown): string {
  return String(v ?? "").normalize("NFKC").trim();
}

function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1);
  return [...new Set(ids)];
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      salesTransactionIds?: unknown;
      amazon_order_id?: unknown;
      refund_qty?: unknown;
      dispositions?: unknown;
    };

    const salesTransactionIds = parseIds(body.salesTransactionIds);
    const amazonOrderIdHint = norm(body.amazon_order_id);
    const refundQtyRaw = Number(body.refund_qty ?? 0);
    const refundQty = Number.isFinite(refundQtyRaw) ? Math.max(0, Math.trunc(refundQtyRaw)) : 0;

    const disp =
      body.dispositions && typeof body.dispositions === "object"
        ? (body.dispositions as { new?: unknown; used?: unknown; junk?: unknown })
        : null;
    const dispNew = Number(disp?.new ?? 0);
    const dispUsed = Number(disp?.used ?? 0);
    const dispJunk = Number(disp?.junk ?? 0);
    const p_disp_new = Number.isFinite(dispNew) ? Math.max(0, Math.trunc(dispNew)) : 0;
    const p_disp_used = Number.isFinite(dispUsed) ? Math.max(0, Math.trunc(dispUsed)) : 0;
    const p_disp_junk = Number.isFinite(dispJunk) ? Math.max(0, Math.trunc(dispJunk)) : 0;

    if (salesTransactionIds.length === 0) {
      return NextResponse.json({ error: "salesTransactionIds を1件以上指定してください。" }, { status: 400 });
    }

    if (!Number.isFinite(refundQtyRaw)) {
      return NextResponse.json({ error: "refund_qty が不正です。" }, { status: 400 });
    }

    if (refundQty === 0) {
      // 仕様固定: refund_qty=0 は在庫更新せず、財務の消込のみ
      await markSalesTransactionsReconciled(salesTransactionIds);
      return NextResponse.json({
        ok: true,
        updated_sales_tx_count: salesTransactionIds.length,
        updated_inbound_count: 0,
        updated_inbound_new: 0,
        updated_inbound_used: 0,
        updated_inbound_junk: 0,
        skipped_total: 0,
        refund_qty: 0,
        order_id_used: amazonOrderIdHint || null,
      });
    }

    // dispositions の整合（仕様固定: 合計一致）
    if (p_disp_new + p_disp_used + p_disp_junk !== refundQty) {
      return NextResponse.json(
        { error: `内訳数量の合計が返金数量と一致しません（返金数: ${refundQty}, 合計: ${p_disp_new + p_disp_used + p_disp_junk}）。` },
        { status: 400 }
      );
    }

    const rpc = await supabase.rpc("manual_finance_refund_release", {
      p_sales_transaction_ids: salesTransactionIds,
      p_amazon_order_id: amazonOrderIdHint || null,
      p_refund_qty: refundQty,
      p_disp_new,
      p_disp_used,
      p_disp_junk,
    });

    if (rpc.error) {
      const msg = String((rpc.error as any)?.message ?? "在庫不足のため処理を中断しました。現場の在庫状況を確認してください。");
      // 仕様固定: 在庫不足は 400（在庫も財務も更新しない）
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const row =
      Array.isArray(rpc.data) ? (rpc.data[0] as any) : (rpc.data as any);

    return NextResponse.json({
      ok: true,
      updated_sales_tx_count: Number(row?.updated_sales_tx_count ?? salesTransactionIds.length),
      updated_inbound_count: Number(row?.updated_inbound_count ?? 0),
      updated_inbound_new: Number(row?.updated_inbound_new ?? 0),
      updated_inbound_used: Number(row?.updated_inbound_used ?? 0),
      updated_inbound_junk: Number(row?.updated_inbound_junk ?? 0),
      skipped_total: Number(row?.skipped_total ?? 0),
      skipped_already_free: Number(row?.skipped_already_free ?? 0),
      skipped_return_flagged: Number(row?.skipped_return_flagged ?? 0),
      refund_qty: Number(row?.refund_qty ?? refundQty),
      order_id_used: (row?.order_id_used as string | null) ?? (amazonOrderIdHint || null),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-refund-release]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

