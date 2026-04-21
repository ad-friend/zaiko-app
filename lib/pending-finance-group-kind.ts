import { isPrincipalTaxOffsetQuad, type PrincipalTaxQuadRowLike } from "@/lib/amazon-principal-tax-quad";

/**
 * 注文・返金の「金額調整」行（FeeAdjustment 等）。Seller 補填とは別扱いにする。
 * compact（NFKC 小文字・空白・アンダースコア・ハイフン除去済み）への部分一致。短語（promotion 単体等）は入れない。
 */
const ORDER_LIKE_ADJUSTMENT_FEE_EXCLUSIONS: readonly string[] = [
  "feeadjustment",
  "shippingadjustment",
  "shipmentadjustment",
  "taxadjustment",
  "promotionalrebate",
  "postageadjustment",
  "fulfillmentfeeadjustment",
  "commissionadjustment",
  "refundcommissionadjustment",
  "shippingchargeback",
  "giftwrapchargeback",
  "codfee",
  "marketplacefacilitatortax",
  "shippingdiscount",
  "fbaperorderfulfillmentfee",
  "fbaweightbasedfee",
  "fbastoragefee",
  "inboundtransportation",
  "removalorderfee",
  "returnshippingfee",
];

/** 複数フィールドを連結した compact hay（除外・単一フィールド判定で利用） */
export function financialHayCompactFromParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((x) => String(x ?? "").normalize("NFKC").trim().toLowerCase())
    .join("\n")
    .replace(/[\s_\-]+/g, "");
}

export function financialRowHayCompact(
  row: Pick<PrincipalTaxQuadRowLike, "transaction_type" | "amount_type" | "amount_description">
): string {
  return financialHayCompactFromParts([row.transaction_type, row.amount_type, row.amount_description]);
}

export function hayIsOrderLikeFeeAdjustmentExclusion(compactHay: string): boolean {
  if (!compactHay) return false;
  return ORDER_LIKE_ADJUSTMENT_FEE_EXCLUSIONS.some((p) => compactHay.includes(p));
}

/** transaction_type 比較用（NFKC・trim・lower） */
function normalizedTransactionTypeForAdjustment(raw: string | null | undefined): string {
  return String(raw ?? "").normalize("NFKC").trim().toLowerCase();
}

/**
 * Phase 1: SP-API / レポートで「この行は補填イベント」と確定できる transaction_type のみ。
 * 説明に Fee が含まれてもネガティブマッチに巻き込まれないよう、Phase 2 より先に評価する。
 * - adjustment: ListFinancialEvents 等の標準的な調整イベント種別
 * - seller_adjustment: 出品者起因の調整として使われる表記（実データで要確認・追加）
 * - 補填: 日本語トランザクションレポート等の種別列
 */
const DEFINITE_SELLER_ADJUSTMENT_TRANSACTION_TYPES = new Set<string>(["seller_adjustment", "補填"]);

function isPhase1DefiniteSellerAdjustmentTransactionType(txNorm: string): boolean {
  return txNorm.length > 0 && DEFINITE_SELLER_ADJUSTMENT_TRANSACTION_TYPES.has(txNorm);
}

function rowPhase1DefiniteSellerAdjustment(
  row: Pick<PrincipalTaxQuadRowLike, "transaction_type" | "amount_type" | "amount_description">
): boolean {
  return isPhase1DefiniteSellerAdjustmentTransactionType(normalizedTransactionTypeForAdjustment(row.transaction_type));
}

/** Phase 3: 連結 hay（小文字・NFKC、非 compact）上の部分一致 */
function hayMatchesAdjustmentPositiveSignals(hay: string): boolean {
  return (
    hay.includes("adjustment") ||
    hay.includes("adjust") ||
    hay.includes("調整") ||
    hay.includes("補填") ||
    hay.includes("goodwill") ||
    hay.includes("claim") ||
    hay.includes("クレーム")
  );
}

/**
 * 単一フィールド用の 3 段階判定（Phase1 → Phase2 compact のみ → Phase3）。
 * transaction_type 列だけを渡す想定（モーダル・CSV 種別列）。
 */
export function isAdjustmentTransactionTypeNormalized(raw: string | null | undefined): boolean {
  const t = normalizedTransactionTypeForAdjustment(raw);
  if (!t) return false;
  if (isPhase1DefiniteSellerAdjustmentTransactionType(t)) return true;
  const c = financialHayCompactFromParts([raw]);
  if (hayIsOrderLikeFeeAdjustmentExclusion(c)) return false;
  if (t.includes("調整") || t.includes("補填")) return true;
  if (c.includes("adjustment") || c.includes("adjust")) return true;
  if (t.includes("goodwill") || c.includes("goodwill")) return true;
  if (t.includes("クレーム") || t.includes("claim")) return true;
  if (t.includes("reimbursement") || c.includes("reimbursement") || t.includes("返金補填")) return true;
  return false;
}

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
    if (rowPhase1DefiniteSellerAdjustment(row)) {
      return true;
    }
    const compact = financialRowHayCompact(row);
    if (hayIsOrderLikeFeeAdjustmentExclusion(compact)) {
      continue;
    }
    const hay = [row.transaction_type, row.amount_type, row.amount_description ?? ""]
      .map((x) => String(x ?? "").normalize("NFKC").toLowerCase())
      .join("\n");
    if (hayMatchesAdjustmentPositiveSignals(hay)) {
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
