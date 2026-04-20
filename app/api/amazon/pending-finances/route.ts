/**
 * 未処理財務データ（stock_id IS NULL）をグループ化して返す
 * GET: sales_transactions の未紐付き明細を amazon_order_id、または補填用の論理キーでグループ化する。
 * - 注文番号が無くても adjustment 系の行は一覧に含める（補填の手動処理用）。
 * - 補填（注文番号なし）: finance_line_group_id があればそれのみで1カード。無ければ同一暦日＋transaction_type＋amount_type で1カード（SKU や行 id はキーに含めない）。
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
import { canRefundPositiveOffsetForRows, isRefundLikeRow } from "@/lib/amazon-refund-offset-like";
import { internalNoteSummaryForGroup } from "@/lib/amazon-pending-finance-internal-note";

export type SuggestedCategory = "Refund" | "Adjustment" | "Mixed" | null;

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

  /** Refund系が含まれるか（正規化 + isRefundLikeRow） */
  hasRefund: boolean;
  /** Adjustment系が含まれるか（正規化 + isAdjustmentLike + goodwill） */
  hasAdjustment: boolean;
  /** UI初期選択の候補（未該当は null） */
  suggestedCategory: SuggestedCategory;
  /** 返金で解除すべき数量（APIが正）。0 の場合は在庫更新しない */
  refund_qty: number;
};

function normLower(s: unknown): string {
  return String(s ?? "").normalize("NFKC").trim().toLowerCase();
}

export async function GET() {
  try {
    const shouldExcludeByType = (transactionType: unknown, amountType: unknown, amountDescription: unknown): boolean => {
      const tt = normLower(transactionType);
      const at = normLower(amountType);
      const ad = normLower(amountDescription);

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
      const txType = String(row.transaction_type ?? "Unknown")
        .normalize("NFKC")
        .trim();
      const amountType = String(row.amount_type ?? "Unknown")
        .normalize("NFKC")
        .trim();

      const finGid = String((row as { finance_line_group_id?: string | null }).finance_line_group_id ?? "").trim();
      const postedDay = posted.length >= 10 ? posted.slice(0, 10) : posted;
      const safeSku = String(row.sku ?? "no_sku")
        .normalize("NFKC")
        .trim()
        .toUpperCase();
      const amountStr = Number(row.amount ?? 0).toFixed(4);

      let key: string;
      if (orderId) {
        key = orderId;
      } else if (finGid) {
        key = `adj_fin:${finGid}`;
      } else {
        key = `adj_day:${postedDay}_${safeSku}_${txType}_${amountType}_${amountStr}`;
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

      const hasRefund = details.some((d) =>
        isRefundLikeRow({
          amount: d.amount,
          transaction_type: d.transaction_type,
          amount_type: d.amount_type,
          amount_description: d.amount_description,
        })
      );

      const hasAdjustment =
        isAdjustmentLike(details) ||
        details.some((d) => {
          const ad = normLower(d.amount_description);
          return ad === "goodwill" || ad.includes("goodwill");
        });

      const suggestedCategory: SuggestedCategory =
        hasRefund && hasAdjustment ? "Mixed" : hasRefund ? "Refund" : hasAdjustment ? "Adjustment" : null;

      // refund_qty 優先順位（仕様固定）
      const refundRows = details.filter((d) =>
        isRefundLikeRow({
          amount: d.amount,
          transaction_type: d.transaction_type,
          amount_type: d.amount_type,
          amount_description: d.amount_description,
        })
      );
      const sumQty = refundRows.reduce((sum, r) => {
        const q = Number((r as { item_quantity?: unknown }).item_quantity);
        if (!Number.isFinite(q)) return sum;
        const n = Math.trunc(q);
        return n >= 1 ? sum + n : sum;
      }, 0);
      const refund_qty = sumQty > 0 ? sumQty : hasRefund ? 1 : 0;

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
        hasRefund,
        hasAdjustment,
        suggestedCategory,
        refund_qty,
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
