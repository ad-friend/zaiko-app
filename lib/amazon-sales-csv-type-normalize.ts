/**
 * Amazon トランザクション CSV（日本語レポート等）を Finances API 取り込みと揃えるための正規化。
 * - transaction_type: 調整系 → "Adjustment"
 * - amount_type: SP-API の AdjustmentType に近い UPPER_SNAKE（推定不能時は "Adjustment"）
 * - amount_description: 補填行は API と同様 null（idempotency_key の衝突を避ける）
 */

import { isAdjustmentTransactionTypeNormalized } from "@/lib/pending-finance-group-kind";

function nfkc(s: string): string {
  return String(s ?? "").normalize("NFKC").trim();
}

/** CSV 種別列の Order/Refund 判定（amazon-sales-import 従来ロジック） */
export function normalizeTransactionType(rawType: string): "Order" | "Refund" | string {
  const t = rawType.normalize("NFKC").trim();
  if (!t) return "Order";
  const lower = t.toLowerCase();
  if (lower === "refund" || lower.includes("refund") || t === "返金" || t.includes("返金")) return "Refund";
  if (lower === "order" || lower.includes("order") || t === "注文" || t.includes("注文")) return "Order";
  return t;
}

function isAdjustmentLikeTransactionType(raw: string): boolean {
  const t = nfkc(raw);
  if (!t) return false;
  if (t === "Order" || t === "Refund") return false;
  return isAdjustmentTransactionTypeNormalized(raw);
}

function isStandardOrderLineAmountType(amountType: string, amountDescription: string): boolean {
  const at = nfkc(amountType);
  if (at === "Charge" || at === "Fee" || at === "ChargeAdjustment" || at === "FeeAdjustment") return true;
  const desc = nfkc(amountDescription);
  return (
    desc === "Principal" ||
    desc === "Tax" ||
    desc === "Commission" ||
    desc === "FBA Per Unit Fulfillment Fee" ||
    desc === "Other"
  );
}

/**
 * 説明・種別列から SP-API AdjustmentType 風のコードを推定（ヒットしなければ null）。
 * Finances API の amount_type は AdjustmentType 文字列そのまま。CSV だけ generic "Adjustment"
 * だと idempotency が分岐するため、辞書で寄せる。
 */
export function inferAdjustmentAmountType(haystack: string): string | null {
  const h = haystack.normalize("NFKC");
  const lower = h.toLowerCase();

  for (const part of h.split("|").map((s) => s.trim()).filter(Boolean)) {
    if (/^[A-Z][A-Z0-9_]{3,79}$/.test(part)) return part;
  }

  const rules: Array<{ re: RegExp; code: string }> = [
    {
      re:
        /WAREHOUSE[_\s]?DAMAGE|倉庫.*破損|破損.*倉庫|fba.*破損|FBA在庫.*破損|在庫の破損|在庫破損|フルフィルメント.*破損|フルフィルメントセンター.*破損|保管中.*破損|fc.*破損|fulfillment.*damage|inventory.*damage|damaged.*(warehouse|fulfillment|inventory)/i,
      code: "WAREHOUSE_DAMAGE",
    },
    {
      re:
        /WAREHOUSE[_\s]?LOST|倉庫.*紛失|紛失.*倉庫|lost.*warehouse|FBA在庫.*紛失|在庫の紛失|在庫紛失|フルフィルメント.*紛失|inventory.*lost|lost.*(inventory|fulfillment)/i,
      code: "WAREHOUSE_LOST",
    },
    { re: /INBOUND[_\s]?CARRIER[_\s]?DAMAGE|搬入.*破損|納品.*破損|キャリア.*破損|運送.*破損/i, code: "INBOUND_CARRIER_DAMAGE" },
    { re: /CARRIER[_\s]?DAMAGED[_\s]?DISCARD/i, code: "CARRIER_DAMAGED_DISCARD" },
    {
      re: /MISSING[_\s]?FROM[_\s]?INVENTORY|在庫.*不足|棚卸.*調整|棚卸し.*調整|inventory.*adjustment|missing.*inventory/i,
      code: "MISSING_FROM_INVENTORY",
    },
    { re: /LOST[_\s]?OUTBOUND|出荷.*紛失/i, code: "LOST_OUTBOUND" },
    { re: /LOST[_\s]?INBOUND|納品.*紛失/i, code: "LOST_INBOUND" },
    { re: /INCORRECT[_\s]?FEES|手数料.*誤|referral.*error/i, code: "INCORRECT_FEES_ITEM" },
    { re: /EXCESSIVE[_\s]?LIABILITY/i, code: "EXCESSIVE_LIABILITY" },
    {
      re: /CUSTOMER[_\s]?SERVICE[_\s]?ISSUE|カスタマーサービス|カスタマー.*サービス|customer service issue/i,
      code: "CUSTOMER_SERVICE_ISSUE",
    },
    { re: /REVERSAL[_\s]?REIMBURSEMENT|相殺.*補填/i, code: "REVERSAL_REIMBURSEMENT" },
    { re: /REMOVAL[_\s]?ORDER|在庫.*削除|返送オーダ|removal.*order/i, code: "REMOVAL_ORDER" },
    { re: /COUPON[_\s]?REDEMPTION|クーポン/i, code: "COUPON_REDEMPTION_FEE" },
    { re: /A[_\s]?TO[_\s]?Z[_\s]?GUARANTEE|AツーZ|a[-\s]?to[-\s]?z/i, code: "A_TO_Z_GUARANTEE" },
    { re: /CHARGEBACK[_\s]?REFUND|チャージバック/i, code: "CHARGEBACK_REFUND" },
    { re: /Shipping[_\s]?services|配送サービス/i, code: "Shipping services" },
    { re: /COMPENSATED[_\s]?CLAWBACK|補填.*取り消し|clawback/i, code: "COMPENSATED_CLAWBACK" },
    {
      re: /WEIGHT[_\s]?AND[_\s]?DIMENSIONS[_\s]?CHANGE|重量.*寸法|寸法.*変更|weight.*dimension/i,
      code: "WEIGHT_AND_DIMENSIONS_CHANGE",
    },
    { re: /FREE[_\s]?REPLACEMENT[_\s]?REFUND[_\s]?ITEMS|無償交換/i, code: "FREE_REPLACEMENT_REFUND_ITEMS" },
    { re: /LIQUIDATIONS[_\s]?ADJUSTMENTS|リキデーション|liquidations?.?adjust/i, code: "LIQUIDATIONS_ADJUSTMENTS" },
    { re: /REIMBURSEMENT[_\s]?FOR[_\s]?RETURN[_\s]?SHIPPING|返品.*送料.*補填/i, code: "REIMBURSEMENT_FOR_RETURN_SHIPPING" },
  ];

  for (const { re, code } of rules) {
    if (re.test(h) || re.test(lower)) return code;
  }

  const snake = nfkc(haystack);
  if (/^[A-Z][A-Z0-9_]*$/.test(snake) && snake.length >= 4 && snake.length <= 80) {
    return snake;
  }

  return null;
}

export type NormalizeCsvFinancialTypesInput = {
  amazon_order_id: string | null;
  /** CSV 種別列（トランザクションの種類 等） */
  rawTransactionType: string;
  /**
   * 明細の amount_type 相当（注文内訳行では Charge/Fee）。
   * オーダー無し行では多くが種別列と同一。
   */
  amountType: string;
  /** 内訳ラベル（Principal 等）。未使用なら空 */
  amountDescription: string;
  /** CSV の説明・メモ列（任意） */
  descriptionColumn: string;
};

/**
 * CSV 1 明細分の transaction_type / amount_type / amount_description を API 寄せで揃える。
 * 注文の Principal/Tax/Fee 行は種別列が「調整」でも潰さない。
 */
export function normalizeCsvFinancialTypesForSalesImport(input: NormalizeCsvFinancialTypesInput): {
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
} {
  const orderId = (input.amazon_order_id ?? "").trim();
  const rawTypeCol = nfkc(input.rawTransactionType);
  const amtType = nfkc(input.amountType);
  const amtDesc = nfkc(input.amountDescription);
  const descCol = nfkc(input.descriptionColumn);

  if (orderId && isStandardOrderLineAmountType(amtType, amtDesc)) {
    const tx0 = normalizeTransactionType(input.rawTransactionType || "Order");
    const transaction_type = tx0 === "Refund" ? "Refund" : "Order";
    return {
      transaction_type,
      amount_type: amtType,
      amount_description: amtDesc || null,
    };
  }

  const txFromCol = normalizeTransactionType(input.rawTransactionType || (orderId ? "Order" : "Adjustment"));
  const txAdj = isAdjustmentLikeTransactionType(txFromCol);
  const amtAdj =
    isAdjustmentLikeTransactionType(amtType) || amtType === "" || (txAdj && amtType === txFromCol);

  if (!txAdj && !amtAdj) {
    const amount_description =
      amtDesc ||
      (descCol ? `Transaction report CSV — ${descCol}` : null) ||
      (!orderId ? `Transaction report CSV — ${txFromCol}` : null);
    return {
      transaction_type: txFromCol || "Order",
      amount_type: amtType || txFromCol || "Order",
      amount_description,
    };
  }

  const hay = [rawTypeCol, amtType, amtDesc, descCol].filter(Boolean).join(" | ");
  const inferred = inferAdjustmentAmountType(hay);
  return {
    transaction_type: "Adjustment",
    amount_type: inferred ?? "Adjustment",
    amount_description: null,
  };
}
