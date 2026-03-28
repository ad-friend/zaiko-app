/**
 * Amazon 注文 condition_id と inbound_items.condition_type の照合（大小文字・表記揺れ吸収）
 */
export type NormalizedListingCondition = "new" | "used";

export function normalizeOrderCondition(conditionId: string | null | undefined): NormalizedListingCondition | null {
  const raw = String(conditionId ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "new" || raw === "新品" || raw.startsWith("new")) return "new";
  if (raw === "used" || raw === "中古" || raw.startsWith("used")) return "used";
  return null;
}

export function normalizeStockCondition(conditionType: string | null | undefined): NormalizedListingCondition | null {
  const raw = String(conditionType ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "new" || raw === "新品") return "new";
  if (raw === "used" || raw === "中古") return "used";
  if (raw.includes("新品") && !raw.includes("中古")) return "new";
  if (raw.includes("中古")) return "used";
  if (raw.includes("new") && !raw.includes("used")) return "new";
  if (raw.includes("used")) return "used";
  return null;
}
