/**
 * 未処理財務データ（stock_id IS NULL）をグループ化して返す
 * GET: sales_transactions の未紐付き明細を amazon_order_id（または sku+posted_date）でグループ化し集計する。
 * - 注文番号が無くても adjustment 系の行は一覧に含める（補填の手動処理用）。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  classifyPendingFinanceGroup,
  displayLabelForPendingFinanceKind,
  getRepresentativeTransactionType,
  isAdjustmentLike,
  type PendingFinanceGroupKind,
} from "@/lib/pending-finance-group-kind";
import { isPrincipalTaxOffsetQuad } from "@/lib/amazon-principal-tax-quad";
import { canRefundPositiveOffsetForRows } from "@/lib/amazon-refund-offset-like";

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
  /** 最古明細基準の代表取引タイプ（モーダル既定モード用） */
  representative_transaction_type: string;
  net_amount: number;
  posted_date: string;
  raw_details: PendingFinanceDetail[];
  group_kind: PendingFinanceGroupKind;
  display_label: string;
  /** Principal/Tax 4行相殺パターン */
  is_principal_tax_quad: boolean;
  /** 注文本消込（manual-reconcile-order）を出してよいか */
  can_order_reconcile: boolean;
  /** 返金+プラス売上の相殺完結を出してよいか */
  can_refund_positive_offset: boolean;
};

export async function GET() {
  try {
    const shouldExcludeByType = (transactionType: unknown, amountType: unknown, amountDescription: unknown): boolean => {
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

    let rows: any[] | null = null;
    {
      const res = await supabase
        .from("sales_transactions")
        .select("id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status")
        .is("stock_id", null)
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

    list = list.filter((row) => {
      if (shouldExcludeByType((row as any).transaction_type, (row as any).amount_type, (row as any).amount_description)) {
        return false;
      }
      const orderId = row.amazon_order_id?.trim() ?? "";
      if (orderId) return true;
      return isAdjustmentLike([row] as Parameters<typeof isAdjustmentLike>[0]);
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
        key = `adj_${txType}_${sku ?? "n/a"}_${posted}_${row.id}`;
      }

      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(row);
    }

    const groups: PendingFinanceGroup[] = [];
    for (const [groupId, details] of groupMap) {
      const netAmount = details.reduce((sum, d) => sum + Number(d.amount ?? 0), 0);
      const first = details[0];
      const orderId = first.amazon_order_id?.trim() ?? null;
      const representativeSku =
        details.map((d) => d.sku?.trim()).find((s) => s && s.length > 0) ?? first.sku?.trim() ?? null;
      const transactionType = first.transaction_type ?? "Unknown";
      const postedDate = first.posted_date ?? "";
      const group_kind = classifyPendingFinanceGroup(details);
      const display_label = displayLabelForPendingFinanceKind(group_kind, transactionType);
      const representative_transaction_type = getRepresentativeTransactionType(details);
      const is_principal_tax_quad =
        group_kind === "offset_principal_tax" || isPrincipalTaxOffsetQuad(details as Parameters<typeof isPrincipalTaxOffsetQuad>[0]);

      const realOrder = Boolean(orderId) && !String(groupId).startsWith("adj_");
      const can_order_reconcile =
        realOrder && !is_principal_tax_quad && group_kind !== "adjustment_like";

      const can_refund_positive_offset = realOrder && canRefundPositiveOffsetForRows(details);

      groups.push({
        groupId,
        amazon_order_id: orderId,
        sku: representativeSku,
        transaction_type: transactionType,
        representative_transaction_type,
        net_amount: netAmount,
        posted_date: postedDate,
        raw_details: details,
        group_kind,
        display_label,
        is_principal_tax_quad,
        can_order_reconcile,
        can_refund_positive_offset,
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
