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
    const shouldExcludeByType = (transactionType: unknown, amountType: unknown, amountDescription: unknown): boolean => {
      // 手動消込UIでは「注文に紐づく売上/返金」だけを見たい。
      // 取引タイプの表記揺れがあるため、Refund/返金/注文などで分岐せず、
      // 「明らかに手数料・振込・FBA・送料課金系だけ」を部分一致で除外する。
      const tt = String(transactionType ?? "").normalize("NFKC").toLowerCase();
      const at = String(amountType ?? "").normalize("NFKC").toLowerCase();
      const ad = String(amountDescription ?? "").normalize("NFKC").toLowerCase();

      const hay = [tt, at, ad].join("\n");
      const keywords = [
        "transfer",
        "振込み",
        "振り込み",
        "振込",
        "servicefee",
        "fba",
        "postagebilling",
      ];
      return keywords.some((k) => hay.includes(k));
    };

    // status カラムが存在する場合は reconciled を除外する。
    // 存在しない場合でも動くように、失敗時は status なしで再クエリする。
    let rows: any[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status")
        .is("stock_id", null)
        // NULL を落とさないようにする: (status IS NULL) OR (status != 'reconciled')
        .or("status.is.null,status.neq.reconciled")
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

    // 手動消込の対象だけに最適化して除外:
    // - 注文番号が無い行はアカウントレベルの経費等として扱い除外（adj_ グループも生成させない）
    // - 取引タイプ/金額タイプに手数料・振込関連の文字列を含むものは除外
    // - 金額の符号（±/0）では判定しない（返金等のマイナスも残す）
    list = list.filter((row) => {
      const orderId = row.amazon_order_id?.trim() ?? "";
      if (!orderId) return false;
      return !shouldExcludeByType((row as any).transaction_type, (row as any).amount_type, (row as any).amount_description);
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
