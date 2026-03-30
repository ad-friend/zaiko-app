/**
 * 未処理財務データ（stock_id IS NULL）をグループ化して返す
 * GET: sales_transactions の未紐付き明細を amazon_order_id（または sku+posted_date）でグループ化し集計する。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type PendingFinanceDetail = {
  id: number;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  [key: string]: unknown;
};

export type PendingFinanceGroup = {
  groupId: string;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  net_amount: number;
  posted_date: string;
  raw_details: PendingFinanceDetail[];
};

export async function GET() {
  try {
    // status カラムが存在する場合は reconciled を除外する。
    // 存在しない場合でも動くように、失敗時は status なしで再クエリする。
    let rows: any[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status")
        .is("stock_id", null)
        .neq("status", "reconciled")
        .order("posted_date", { ascending: false });
      if (!res.error) {
        rows = res.data ?? [];
      } else {
        const code = (res.error as any)?.code;
        const msg = (res.error as any)?.message ?? "";
        if (code !== "42703" && !msg.includes("status")) throw res.error;
      }
    }

    if (rows == null) {
      const { data, error } = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date")
        .is("stock_id", null)
        .order("posted_date", { ascending: false });
      if (error) throw error;
      rows = data ?? [];
    }

    let list = (rows ?? []) as PendingFinanceDetail[];

    // status が無いDB向けフォールバック: 経費・調整として扱うものは一覧から除外
    list = list.filter((row) => {
      const at = String((row as any).amount_type ?? "");
      const tt = String((row as any).transaction_type ?? "");
      return !(
        at.includes("PostageBilling") ||
        tt.includes("PostageBilling") ||
        at.includes("ServiceFee") ||
        tt.includes("ServiceFee") ||
        at.includes("adj_") ||
        tt.includes("adj_")
      );
    });

    const groupMap = new Map<string, PendingFinanceDetail[]>();

    for (const row of list) {
      const orderId = row.amazon_order_id?.trim() ?? null;
      const posted = row.posted_date ?? "";
      const sku = row.sku?.trim() ?? null;
      const txType = row.transaction_type ?? "Unknown";

      let key: string;
      if (orderId) {
        key = orderId;
      } else {
        key = `adj_${txType}_${sku ?? "n/a"}_${posted}`;
      }

      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(row);
    }

    const groups: PendingFinanceGroup[] = [];
    for (const [groupId, details] of groupMap) {
      const netAmount = details.reduce((sum, d) => sum + Number(d.amount ?? 0), 0);
      const first = details[0];
      const orderId = first.amazon_order_id?.trim() ?? null;
      const representativeSku = first.sku?.trim() ?? null;
      const transactionType = first.transaction_type ?? "Unknown";
      const postedDate = first.posted_date ?? "";

      groups.push({
        groupId,
        amazon_order_id: orderId,
        sku: representativeSku,
        transaction_type: transactionType,
        net_amount: netAmount,
        posted_date: postedDate,
        raw_details: details,
      });
    }

    groups.sort((a, b) => (b.posted_date > a.posted_date ? 1 : -1));

    return NextResponse.json(groups);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未処理財務データの取得に失敗しました。";
    console.error("[pending-finances]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
