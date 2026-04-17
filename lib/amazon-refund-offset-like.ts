/**
 * reconcile-sales の返金相殺判定と同一のルール（手動API・pending-finances 表示用）。
 */

export type RefundOffsetRowLike = {
  amount: unknown;
  transaction_type?: string | null;
  amount_type?: string | null;
  amount_description?: string | null;
};

export function toNumberAmount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function isExpenseSkipTxForRefundOffset(row: Pick<RefundOffsetRowLike, "amount_type" | "transaction_type" | "amount_description">): boolean {
  const amountType = String(row.amount_type ?? "");
  const txType = String(row.transaction_type ?? "");
  const desc = String(row.amount_description ?? "");

  return (
    amountType.includes("PostageBilling") ||
    txType.includes("PostageBilling") ||
    desc.includes("PostageBilling") ||
    amountType.includes("adj_") ||
    txType.includes("adj_") ||
    desc.includes("adj_") ||
    amountType.includes("ServiceFee") ||
    txType.includes("ServiceFee") ||
    desc.includes("ServiceFee")
  );
}

export function isRefundTxType(raw: string | null | undefined): boolean {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return false;
  return t === "refund" || t.includes("refund") || t.includes("返金");
}

export function isRefundLikeRow(r: RefundOffsetRowLike): boolean {
  const tt = String(r.transaction_type ?? "");
  const at = String(r.amount_type ?? "");
  const ad = String(r.amount_description ?? "");
  return (
    isRefundTxType(tt) ||
    isRefundTxType(at) ||
    isRefundTxType(ad) ||
    (toNumberAmount(r.amount) < 0 && isRefundTxType(ad))
  );
}

export function isPositiveSaleLikeRow(r: RefundOffsetRowLike): boolean {
  if (toNumberAmount(r.amount) <= 0) return false;
  if (isRefundLikeRow(r)) return false;
  if (
    isExpenseSkipTxForRefundOffset({
      amount_type: r.amount_type,
      transaction_type: r.transaction_type,
      amount_description: r.amount_description,
    })
  ) {
    return false;
  }
  return true;
}

export function canRefundPositiveOffsetForRows(rows: RefundOffsetRowLike[]): boolean {
  if (!rows.length) return false;
  const hasRefund = rows.some((r) => isRefundLikeRow(r));
  const hasPositiveSale = rows.some((r) => isPositiveSaleLikeRow(r));
  return hasRefund && hasPositiveSale;
}
