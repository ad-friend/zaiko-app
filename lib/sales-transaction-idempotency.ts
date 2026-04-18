import { createHash } from "crypto";

const SEP = "\u001f";

/** 取込ロジック変更後も「同じ財務明細」で衝突するキー（upsert 用）。amazon_event_hash とは別に保持する。 */
export const SALES_TX_IDEM_VERSION = "stx_idem_v1";

function normalizePostedForIdempotency(postedDate: string): string {
  const t = String(postedDate ?? "").trim();
  if (t.length >= 19 && t[4] === "-" && t[10] === "T") {
    return t.slice(0, 19);
  }
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19) : t;
}

/** migration の round(amount::numeric,2)::text と一致させる */
function amountForIdempotency(n: number): string {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

export type SalesTransactionIdempotencyInput = {
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  /** 同一ビジネスキー内の分割行（補填の数量分割など）。通常は 0 */
  dedupe_slot: number;
};

/**
 * sales_transactions の一意 upsert 用キー（SHA256 hex）。
 * docs/migration_sales_transactions_idempotency_key.sql の UPDATE と同じ区切り・正規化。
 */
export function computeSalesTransactionIdempotencyKey(p: SalesTransactionIdempotencyInput): string {
  const parts = [
    SALES_TX_IDEM_VERSION,
    (p.amazon_order_id ?? "").trim(),
    (p.sku ?? "").trim(),
    String(p.transaction_type ?? "").trim(),
    String(p.amount_type ?? "").trim(),
    (p.amount_description ?? "").trim(),
    amountForIdempotency(Number(p.amount)),
    normalizePostedForIdempotency(p.posted_date),
    String(Math.max(0, Math.floor(Number(p.dedupe_slot) || 0))),
  ];
  return createHash("sha256").update(parts.join(SEP), "utf8").digest("hex");
}

export function attachSalesTransactionIdempotency<
  T extends {
    amazon_order_id: string | null;
    sku: string | null;
    transaction_type: string;
    amount_type: string;
    amount_description: string | null;
    amount: number;
    posted_date: string;
    dedupe_slot?: number;
  },
>(row: T): T & { dedupe_slot: number; idempotency_key: string } {
  const dedupe_slot = row.dedupe_slot ?? 0;
  return {
    ...row,
    dedupe_slot,
    idempotency_key: computeSalesTransactionIdempotencyKey({ ...row, dedupe_slot }),
  };
}
