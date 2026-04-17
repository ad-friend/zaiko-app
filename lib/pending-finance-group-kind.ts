import { isPrincipalTaxOffsetQuad, type PrincipalTaxQuadRowLike } from "@/lib/amazon-principal-tax-quad";

export type PendingFinanceGroupKind =
  | "offset_principal_tax"
  | "adjustment_like"
  | "order"
  | "refund"
  | "other";

export type PendingFinanceDetailLike = PrincipalTaxQuadRowLike & {
  id?: number;
  posted_date?: string;
  transaction_type?: string;
};

export function isAdjustmentLike(details: PendingFinanceDetailLike[]): boolean {
  for (const row of details) {
    const hay = [row.transaction_type, row.amount_type, row.amount_description ?? ""]
      .map((x) => String(x ?? "").normalize("NFKC").toLowerCase())
      .join("\n");
    if (
      hay.includes("adjustment") ||
      hay.includes("adjust") ||
      hay.includes("補填") ||
      hay.includes("goodwill") ||
      hay.includes("claim") ||
      hay.includes("クレーム")
    ) {
      return true;
    }
  }
  return false;
}

export function representativeRow(details: PendingFinanceDetailLike[]): PendingFinanceDetailLike {
  return [...details].sort((a, b) => {
    const da = String(a.posted_date ?? "");
    const db = String(b.posted_date ?? "");
    if (da !== db) return da.localeCompare(db);
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  })[0];
}

function classifyByTransactionType(ttRaw: string | null | undefined): "order" | "refund" | "other" {
  const t = String(ttRaw ?? "").trim().toLowerCase();
  if (!t) return "other";
  if (t === "order" || t.includes("order") || t.includes("注文")) return "order";
  if (t === "refund" || t.includes("refund") || t.includes("返金")) return "refund";
  return "other";
}

export function classifyPendingFinanceGroup(details: PendingFinanceDetailLike[]): PendingFinanceGroupKind {
  if (!details.length) return "other";
  if (isAdjustmentLike(details)) return "adjustment_like";
  if (isPrincipalTaxOffsetQuad(details)) return "offset_principal_tax";
  const rep = representativeRow(details);
  return classifyByTransactionType(rep.transaction_type);
}

/** モーダル分岐用: 分類と同じ基準の代表 transaction_type（最古明細） */
export function getRepresentativeTransactionType(details: PendingFinanceDetailLike[]): string {
  return String(representativeRow(details).transaction_type ?? "Unknown");
}

export function displayLabelForPendingFinanceKind(
  kind: PendingFinanceGroupKind,
  fallbackTransactionType: string
): string {
  switch (kind) {
    case "offset_principal_tax":
      return "相殺";
    case "adjustment_like":
      return "補填";
    case "order":
      return "Order";
    case "refund":
      return "Refund";
    default:
      return fallbackTransactionType || "その他";
  }
}
