/**
 * 手動「財務相殺」API（旧仕様）。
 * 現在は reconcile-sales の方針Aに合わせ、返金とプラス売上が混在する注文では status を更新しない。
 * 同一注文は一覧でひとまとめ表示されるため、本 API は成功させず案内のみ返す。
 * POST body: { groupId: string } — amazon_order_id（注文番号）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { canRefundPositiveOffsetForRows } from "@/lib/amazon-refund-offset-like";

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

    return NextResponse.json(
      {
        error:
          "返金とプラス売上が同一注文に未紐付で混在する場合の財務相殺は行っていません。一覧では注文ごとにまとめて表示されます。返品・在庫戻しは「返金処理」等のフローから操作してください。",
      },
      { status: 400 }
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-refund-offset]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
