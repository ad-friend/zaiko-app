/**
 * SP-API OrderItem.QuantityOrdered を保存数量にする。
 * 0以下はキャンセル済み明細なので保存しない（null）。
 * 未設定や数値でない場合は、従来どおり 1 個として扱う。
 * 呼び出し側は元の明細並びの line_index を維持する（0件を除いて詰めない）。
 */
export function amazonOrderItemQuantity(raw: unknown): number | null {
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return null;
  return n;
}
