/** other_orders.reconciliation_status（amazon_orders と同義） */
export const OTHER_ORDER_STATUS_PENDING = "pending";
export const OTHER_ORDER_STATUS_RECONCILED = "reconciled";
export const OTHER_ORDER_STATUS_MANUAL_REQUIRED = "manual_required";

export function shouldPreserveOtherOrderReconciliationStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim();
  return s === OTHER_ORDER_STATUS_RECONCILED || s === OTHER_ORDER_STATUS_MANUAL_REQUIRED || s === "completed";
}
