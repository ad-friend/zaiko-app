/** 他販路CSV・引当で使う JAN 正規化（12桁→先頭0付き13桁） */

export function extractJanDigits(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * 数字のみ抽出し、12桁なら先頭0で13桁化。13桁ならそのまま。それ以外は null。
 */
export function normalizeOtherPlatformJan(raw: string | null | undefined): string | null {
  const digits = extractJanDigits(raw);
  if (!digits) return null;
  if (digits.length === 13) return digits;
  if (digits.length === 12) return digits.padStart(13, "0");
  return null;
}

/** inbound_items 照合用（13桁正規形 + 先頭0なし12桁） */
export function otherPlatformJanLookupVariants(raw: string | null | undefined): string[] {
  const normalized = normalizeOtherPlatformJan(raw);
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  if (normalized.length === 13 && normalized.startsWith("0")) {
    variants.add(normalized.slice(1));
  }
  return [...variants];
}
