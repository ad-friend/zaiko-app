-- sales_transactions: hash 変更と無関係に「同じ明細」で upsert 衝突する idempotency_key
-- Supabase SQL エディタで実行（本番前にバックアップ推奨）。
-- digest 先頭の 'stx_idem_v1' は lib/sales-transaction-idempotency.ts の SALES_TX_IDEM_VERSION と一致させること。
-- バージョン変更手順: docs/sales_transactions_idempotency_versioning.md
-- pgcrypto が無い場合は Supabase の Database → Extensions で pgcrypto を有効化してください。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE sales_transactions
  ADD COLUMN IF NOT EXISTS dedupe_slot INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL;

-- lib/sales-transaction-idempotency.ts の computeSalesTransactionIdempotencyKey と同じ区切り（U+001F）
UPDATE sales_transactions
SET
  idempotency_key = encode(
    digest(
      convert_to(
        'stx_idem_v1'
          || E'\x1f' || trim(coalesce(amazon_order_id, ''))
          || E'\x1f' || trim(coalesce(sku, ''))
          || E'\x1f' || trim(transaction_type)
          || E'\x1f' || trim(amount_type)
          || E'\x1f' || trim(coalesce(amount_description, ''))
          || E'\x1f' || trim(round(amount::numeric, 2)::text)
          || E'\x1f' || to_char(date_trunc('second', posted_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS')
          || E'\x1f' || trim(coalesce(dedupe_slot::text, '0')),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
WHERE idempotency_key IS NULL;

-- 同一 idempotency_key の重複は id が小さい行を残す
DELETE FROM sales_transactions a
USING sales_transactions b
WHERE a.idempotency_key = b.idempotency_key
  AND a.id > b.id;

ALTER TABLE sales_transactions
  ALTER COLUMN idempotency_key SET NOT NULL;

DROP INDEX IF EXISTS idx_sales_transactions_event_hash;

CREATE INDEX IF NOT EXISTS idx_sales_transactions_event_hash ON sales_transactions (amazon_event_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_transactions_idempotency_key
  ON sales_transactions (idempotency_key);

COMMENT ON COLUMN sales_transactions.idempotency_key IS '同一財務明細の upsert 衝突キー（amazon_event_hash 変更の影響を受けない）';
COMMENT ON COLUMN sales_transactions.dedupe_slot IS '同一ビジネスキー内の分割行インデックス（補填の数量分割など）。通常 0';
