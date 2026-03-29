/**
 * amazon_orders.reconciliation_status の取り扱い（仮消込フロー）
 * - pending: 未処理
 * - reconciled: 在庫紐付け完了（旧 completed もDBに残り得る）
 * - manual_required: 手動確認
 * - canceled: キャンセル等
 * - returned: 返品レポート等で在庫巻き戻し済み
 */

/** 新規・再処理対象（自動消込APIが拾う） */
export const AMAZON_ORDER_STATUS_PENDING = "pending";

/** 仮消込成功（在庫と紐付け済み） */
export const AMAZON_ORDER_STATUS_RECONCILED = "reconciled";

/** 手動確認待ち */
export const AMAZON_ORDER_STATUS_MANUAL_REQUIRED = "manual_required";

/** キャンセル済み（インポート / SP 同期 / 手動） */
export const AMAZON_ORDER_STATUS_CANCELED = "canceled";

/** 返品レポート等で処理済み（在庫解放 + ステータス確定） */
export const AMAZON_ORDER_STATUS_RETURNED = "returned";

/** 注文同期 upsert 時、上書きしてはいけない（消込状態を維持） */
export function shouldPreserveReconciliationStatusOnSync(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim();
  return (
    s === AMAZON_ORDER_STATUS_RECONCILED ||
    s === "completed" ||
    s === AMAZON_ORDER_STATUS_MANUAL_REQUIRED ||
    s === AMAZON_ORDER_STATUS_CANCELED ||
    s === "cancelled" ||
    s === AMAZON_ORDER_STATUS_RETURNED
  );
}

type UpsertOrderRow = { amazon_order_id: string; sku: string; reconciliation_status?: string };

/** 既存 amazon_orders 行のステータスを見て、upsert 直前の reconciliation_status を決める */
export function applyPreservedReconciliationStatusForUpsert<
  T extends UpsertOrderRow,
>(
  rows: T[],
  existing: Array<{ amazon_order_id: string; sku: string; reconciliation_status: string | null }> | null | undefined
): void {
  const map = new Map<string, string>();
  for (const e of existing ?? []) {
    map.set(`${e.amazon_order_id}\t${e.sku}`, String(e.reconciliation_status ?? "").trim());
  }
  for (const r of rows) {
    const prev = map.get(`${r.amazon_order_id}\t${r.sku}`);
    if (shouldPreserveReconciliationStatusOnSync(prev)) {
      r.reconciliation_status = prev!;
    } else {
      r.reconciliation_status = AMAZON_ORDER_STATUS_PENDING;
    }
  }
}
