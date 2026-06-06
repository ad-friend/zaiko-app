import { isRefundLikeRow, type RefundOffsetRowLike } from "@/lib/amazon-refund-offset-like";

export type RefundQtyDetailLike = RefundOffsetRowLike & {
  item_quantity?: unknown;
};

function normLower(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

/**
 * pending-finances と同式: Principal 返金行の item_quantity 合算。
 * 合算 0 かつ返金あり → 1、返金なし → 0。
 */
export function computeSuggestedRefundQty(details: RefundQtyDetailLike[]): number {
  const refundRows = details.filter((d) =>
    isRefundLikeRow({
      amount: d.amount,
      transaction_type: d.transaction_type,
      amount_type: d.amount_type,
      amount_description: d.amount_description,
    })
  );
  const hasRefund = refundRows.length > 0;
  const principalLikeRefundRows = refundRows.filter((r) => {
    const ad = normLower(r.amount_description);
    return ad === "principal" || ad.includes("principal");
  });
  const refundQtyByItemQuantity = principalLikeRefundRows.reduce((sum, r) => {
    const q = Number(r.item_quantity);
    if (!Number.isFinite(q)) return sum;
    const n = Math.trunc(q);
    return n >= 1 ? sum + n : sum;
  }, 0);
  return refundQtyByItemQuantity > 0 ? refundQtyByItemQuantity : hasRefund ? 1 : 0;
}
