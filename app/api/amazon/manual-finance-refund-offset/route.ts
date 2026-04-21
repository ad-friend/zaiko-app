/**
 * 手動: 同一注文の未紐付売上で「プラス売上」と「返金」が揃っている場合に、
 * reconcile-sales の applyOffsetReconciliation と同様、プラス側等のみ status=reconciled（在庫は触らない）。
 * 返金・返品行は手動返品フロー用に reconciled にせず、処理待ちカードに残す。
 * POST body: { groupId: string } — amazon_order_id（注文番号）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  canRefundPositiveOffsetForRows,
  isRefundLikeRow,
  isPositiveSaleLikeRow,
} from "@/lib/amazon-refund-offset-like";
import { markSalesTransactionsReconciled } from "@/lib/amazon-sales-tx-mark-reconciled";

type TxRow = {
  id: number;
  amazon_order_id: string | null;
  transaction_type: string | null;
  amount_type: string | null;
  amount_description: string | null;
  amount: unknown;
  stock_id: unknown;
  status?: string | null;
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const groupId = body.groupId != null ? String(body.groupId).trim() : "";
    if (!groupId || groupId.startsWith("adj_")) {
      return NextResponse.json({ error: "有効な amazon_order_id（groupId）を指定してください。" }, { status: 400 });
    }

    let rows: TxRow[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, transaction_type, amount_type, amount_description, amount, stock_id, status")
        .eq("amazon_order_id", groupId)
        .is("stock_id", null);
      if (!res.error) {
        rows = (res.data ?? []) as TxRow[];
      } else {
        const code = (res.error as { code?: string })?.code;
        const msg = (res.error as { message?: string })?.message ?? "";
        if (code !== "42703" && !msg.includes("status")) throw res.error;
      }
    }
    if (rows == null) {
      const { data, error } = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, transaction_type, amount_type, amount_description, amount, stock_id")
        .eq("amazon_order_id", groupId)
        .is("stock_id", null);
      if (error) throw error;
      rows = (data ?? []) as TxRow[];
    }

    const active = (rows ?? []).filter((r) => String(r.status ?? "").trim() !== "reconciled");
    if (active.length === 0) {
      return NextResponse.json({ error: "未紐付の明細がありません。" }, { status: 400 });
    }

    if (!canRefundPositiveOffsetForRows(active)) {
      return NextResponse.json(
        { error: "返金らしき行とプラス売上らしき行の両方が必要です（自動相殺と同条件）。" },
        { status: 400 }
      );
    }

    const hasRefund = active.some((r) => isRefundLikeRow(r));
    const hasPositive = active.some((r) => isPositiveSaleLikeRow(r));
    if (!hasRefund || !hasPositive) {
      return NextResponse.json({ error: "相殺条件を満たしません。" }, { status: 400 });
    }

    const idsToReconcile = active.filter((r) => !isRefundLikeRow(r)).map((r) => r.id);
    if (!idsToReconcile.length) {
      return NextResponse.json({ error: "相殺対象のプラス売上側の明細がありません。" }, { status: 400 });
    }
    await markSalesTransactionsReconciled(idsToReconcile);

    return NextResponse.json({
      ok: true,
      message:
        "プラス売上側を財務消込しました。返金・返品行は処理待ちのままです（在庫は変更していません）。",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-refund-offset]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
