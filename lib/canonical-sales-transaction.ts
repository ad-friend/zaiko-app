/**
 * Amazon 売上（sales_transactions）の canonical 表現。
 * - CSV: [lib/amazon-sales-csv-type-normalize.ts] に集約した別名→API 寄せ
 * - Finances API: ここで trim / 空説明の null 化など最小正規化（ルール追加はこのファイルへ）
 * - DB 保存時の amount_description（注文行は API と同じ語彙、プレフィックスなし）
 */

export type AmazonSalesCanonicalSource = "amazon_api" | "amazon_csv";

/** Finances 取込行（amazon-financial-events の SalesTransactionRow と同形） */
export type AmazonFinancialSalesRow = {
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  amazon_event_hash: string;
  dedupe_slot?: number;
  item_quantity?: number;
  finance_line_group_id?: string | null;
  needs_quantity_review?: boolean;
};

export {
  normalizeCsvFinancialTypesForSalesImport,
  normalizeTransactionType,
  type NormalizeCsvFinancialTypesInput,
} from "@/lib/amazon-sales-csv-type-normalize";

function nfkcTrim(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKC")
    .trim();
}

/** Finances API 行の string 正規化（キー計算・DB 保存の前に必ず通す） */
export function canonicalizeAmazonFinancialApiRow(row: {
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
}): { transaction_type: string; amount_type: string; amount_description: string | null } {
  const transaction_type = nfkcTrim(row.transaction_type);
  const amount_type = nfkcTrim(row.amount_type);
  const ad = nfkcTrim(row.amount_description);
  return {
    transaction_type,
    amount_type,
    amount_description: ad === "" ? null : ad,
  };
}

/** Finances API（flattenShipmentEvents）と同じ amount_description 語彙。idempotency 整合のため CSV 用プレフィックスは付けない */
const ORDER_LINE_DESCRIPTIONS_API_ALIGNED = new Set([
  "Principal",
  "Tax",
  "Commission",
  "FBA Per Unit Fulfillment Fee",
  "Other",
]);

/**
 * mergeMap 由来の論理 amount_description を、DB に書く最終文字列にする。
 * Order/Refund の標準 Charge/Fee 内訳はプレフィックスなし。それ以外は監査用プレフィックス。
 */
export function formatAmountDescriptionForAmazonSalesDb(
  transactionType: string,
  amountType: string,
  logicalDescription: string | null
): string | null {
  if (logicalDescription == null) return null;
  const s = String(logicalDescription).trim();
  if (!s) return null;
  if (s.startsWith("Transaction report CSV")) return s;
  const orderLike = transactionType === "Order" || transactionType === "Refund";
  const stdChargeFee =
    amountType === "Charge" ||
    amountType === "Fee" ||
    amountType === "ChargeAdjustment" ||
    amountType === "FeeAdjustment";
  if (orderLike && stdChargeFee && ORDER_LINE_DESCRIPTIONS_API_ALIGNED.has(s)) {
    return s;
  }
  return `Transaction report CSV — ${s}`;
}

/** upsert 直前: API 行に canonical を適用（amazon_event_hash は変更しない） */
export function applyCanonicalToSalesTransactionRowForApi<T extends AmazonFinancialSalesRow>(row: T): T {
  const c = canonicalizeAmazonFinancialApiRow({
    transaction_type: row.transaction_type,
    amount_type: row.amount_type,
    amount_description: row.amount_description,
  });
  return { ...row, ...c };
}
