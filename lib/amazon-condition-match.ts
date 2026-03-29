/**
 * Amazon 注文 condition_id と inbound_items.condition_type の照合（大小文字・表記揺れ・見えない空白を吸収）
 */
export type NormalizedListingCondition = "new" | "used";

/** 全角スペース・BOM・ゼロ幅文字を除き trim + lower */
function preprocessConditionInput(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 注文・在庫共通の new / used 判定。used 系を先に判定し、曖昧さを減らす。
 */
function classifyListingCondition(raw: string): NormalizedListingCondition | null {
  if (!raw) return null;

  if (
    raw.includes("中古") ||
    raw.includes("used") ||
    raw.includes("refurb") ||
    raw.includes("renewed") ||
    raw.includes("pre-owned") ||
    raw.includes("preowned") ||
    raw.includes("再生") ||
    (raw.includes("アウトレット") && (raw.includes("中古") || raw.includes("used")))
  ) {
    return "used";
  }

  if (raw.includes("新品") || raw.includes("未使用") || raw.includes("未開封")) {
    return "new";
  }

  if (raw === "new" || raw.startsWith("newitem") || raw.startsWith("new_item") || raw.startsWith("new-")) {
    return "new";
  }

  if (raw.startsWith("new")) {
    return "new";
  }

  if (raw.includes("new") && !raw.includes("used")) {
    return "new";
  }

  return null;
}

/** 在庫側: 上記に加え、部分一致ルールを少し広げる */
function classifyStockCondition(raw: string): NormalizedListingCondition | null {
  const base = classifyListingCondition(raw);
  if (base) return base;

  if (raw.includes("新品") && !raw.includes("中古")) {
    return "new";
  }
  if (raw.includes("中古")) {
    return "used";
  }
  if (raw.includes("new") && !raw.includes("used")) {
    return "new";
  }
  if (raw.includes("used")) {
    return "used";
  }

  return null;
}

export function normalizeOrderCondition(conditionId: string | null | undefined): NormalizedListingCondition | null {
  const raw = preprocessConditionInput(conditionId);
  return classifyListingCondition(raw);
}

export function normalizeStockCondition(conditionType: string | null | undefined): NormalizedListingCondition | null {
  const raw = preprocessConditionInput(conditionType);
  return classifyStockCondition(raw);
}
