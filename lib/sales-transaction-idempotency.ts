import { createHash } from "crypto";

const SEP = "\u001f";

/**
 * 取込ロジック変更後も「同じ財務明細」で衝突するキー（upsert 用）。amazon_event_hash とは別に保持する。
 *
 * ## バージョンを上げるとき（運用）
 * 1. この定数を `stx_idem_v2` のように変更する（`computeSalesTransactionIdempotencyKey` の入力が変わるすべてのケース）。
 * 2. [docs/sales_transactions_idempotency_versioning.md](docs/sales_transactions_idempotency_versioning.md) に沿い、既存行の `idempotency_key` を再計算する
 *    （SQL の一括 UPDATE または `npm run backfill:sales-idem` の `--apply`）。
 * 3. `docs/migration_sales_transactions_idempotency_key.sql` 内のリテラル `'stx_idem_v1'` を参照している新規マイグレーションを書く場合は、同じバージョン文字列に合わせる。
 * 4. 再取込のみで揃える場合でも、旧キーが残ると重複行になるため、バックフィルまたは全削除→取込のどちらかを必ず決める。
 */
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

/**
 * 同一 upsert 内で同じ idempotency_key が複数あると Postgres が
 * 「ON CONFLICT DO UPDATE command cannot affect row a second time」(21000) で失敗する。
 * 先頭の行だけ残す（同一キーなら正規化済みペイロードも同一想定）。
 */
export function dedupeUpsertChunkByIdempotencyKey<T extends { idempotency_key: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.idempotency_key)) continue;
    seen.add(row.idempotency_key);
    out.push(row);
  }
  return out;
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
