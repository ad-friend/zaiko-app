-- 売上・手数料・返品・補填トランザクション（Finances API 取得分）
-- Supabase SQLエディタで実行してください。

CREATE TABLE IF NOT EXISTS sales_transactions (
  id BIGSERIAL PRIMARY KEY,
  amazon_order_id TEXT,
  sku TEXT,
  transaction_type TEXT NOT NULL,
  amount_type TEXT NOT NULL,
  amount_description TEXT,
  amount NUMERIC(14, 2) NOT NULL,
  posted_date TIMESTAMPTZ NOT NULL,
  amazon_event_hash TEXT NOT NULL,
  dedupe_slot INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  stock_id BIGINT,
  unit_cost NUMERIC(14, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_transactions_idempotency_key ON sales_transactions (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sales_transactions_event_hash ON sales_transactions (amazon_event_hash);
CREATE INDEX IF NOT EXISTS idx_sales_transactions_order_id ON sales_transactions (amazon_order_id);
CREATE INDEX IF NOT EXISTS idx_sales_transactions_posted_date ON sales_transactions (posted_date);
CREATE INDEX IF NOT EXISTS idx_sales_transactions_stock_id ON sales_transactions (stock_id);

COMMENT ON TABLE sales_transactions IS 'Amazon Finances API から取得した売上・手数料・返品・補填データ（重複は idempotency_key で防止。amazon_event_hash はAPI由来の行識別用）。stock_id は本消込で inbound_items.id を紐付け';

-- 既存テーブルにカラムを後から追加する場合:
-- ALTER TABLE sales_transactions ADD COLUMN IF NOT EXISTS stock_id BIGINT;
-- ALTER TABLE sales_transactions ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14, 2);
