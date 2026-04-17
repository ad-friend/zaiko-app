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
import { internalNoteSummaryForGroup } from "@/lib/amazon-pending-finance-internal-note";

export type PendingFinanceDetail = {
  id: number;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  internal_note?: string | null;
  item_quantity?: number;
  finance_line_group_id?: string | null;
  needs_quantity_review?: boolean;
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
  /** グループ内 internal_note の一覧用サマリ（STEP5 カード表示） */
  internal_note_summary: string | null;
  /** 明細の needs_quantity_review の OR（要確認アラート） */
  needs_quantity_review?: boolean;
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

    const selectVariants = [
      "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status, internal_note, item_quantity, finance_line_group_id, needs_quantity_review",
      "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status, internal_note",
      "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, status",
      "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, internal_note",
      "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date",
    ] as const;

    let rows: any[] = [];
    for (let i = 0; i < selectVariants.length; i++) {
      const sel = selectVariants[i];
      let q = supabase.from("sales_transactions").select(sel).is("stock_id", null);
      if (sel.includes("status")) {
        q = q.or("status.is.null,status.neq.reconciled");
      }
      const res = await q.order("posted_date", { ascending: false });
      if (!res.error) {
        rows = res.data ?? [];
        break;
      }
      const msg = String((res.error as { message?: string }).message ?? "").toLowerCase();
      const code = String((res.error as { code?: string }).code ?? "");
      const last = i === selectVariants.length - 1;
      if (last) throw res.error;
      const wantsNote = sel.includes("internal_note");
      const wantsStatus = sel.includes("status");
      const wantsQtyCols = sel.includes("needs_quantity_review");
      const missingInternal = msg.includes("internal_note");
      const missingStatus = code === "42703" || msg.includes("status");
      const missingQtyCols = code === "42703" || msg.includes("item_quantity") || msg.includes("needs_quantity_review");
      if (wantsNote && missingInternal) continue;
      if (wantsStatus && missingStatus) continue;
      if (wantsQtyCols && missingQtyCols) continue;
      throw res.error;
    }

    let list = rows as PendingFinanceDetail[];

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

      const finGid = String((row as { finance_line_group_id?: string | null }).finance_line_group_id ?? "").trim();
      let key: string;
      if (orderId) {
        key = orderId;
      } else if (finGid) {
        key = `adj_${txType}_${sku ?? "n/a"}_${posted}_${finGid}`;
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
      const internal_note_summary = internalNoteSummaryForGroup(details);
      const needs_quantity_review = details.some((d) => Boolean((d as { needs_quantity_review?: boolean }).needs_quantity_review));

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
        internal_note_summary,
        needs_quantity_review,
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
