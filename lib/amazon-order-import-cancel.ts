/**
 * 注文CSVのキャンセル判定。
 * 注文ステータスがキャンセルのときだけ、注文番号単位で全行をキャンセルする。
 * 明細ステータスだけがキャンセルの行は取り込みから外し、注文全体はキャンセルしない
 * （同一注文に出荷済み明細が残る再注文を巻き込まない）。
 */

const ORDER_STATUS_KEYS = ["orderStatus", "order-status", "order_status"] as const;
const ITEM_STATUS_KEYS = ["itemStatus", "item-status", "item_status"] as const;

export type AmazonOrderImportCancelAction = "none" | "order" | "item";

export function statusTextImpliesCancelled(raw: unknown): boolean {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower.includes("cancel")) return true;
  if (s.includes("キャンセル")) return true;
  return false;
}

function firstStatus(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value == null) continue;
    if (String(value).trim() === "") continue;
    return value;
  }
  return undefined;
}

export function classifyAmazonOrderImportCancel(
  row: Record<string, unknown>
): AmazonOrderImportCancelAction {
  if (statusTextImpliesCancelled(firstStatus(row, ORDER_STATUS_KEYS))) return "order";
  if (statusTextImpliesCancelled(firstStatus(row, ITEM_STATUS_KEYS))) return "item";
  return "none";
}
