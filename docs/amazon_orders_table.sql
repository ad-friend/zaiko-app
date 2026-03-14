-- Amazon注文テーブル（消込用）
-- Supabase SQLエディタで実行してください。

CREATE TABLE IF NOT EXISTS amazon_orders (
  id BIGSERIAL PRIMARY KEY,
  amazon_order_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  quantity INTEGER NOT NULL DEFAULT 1,
  jan_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_orders_order_id ON amazon_orders (amazon_order_id);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_status ON amazon_orders (reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_sku ON amazon_orders (sku);

COMMENT ON TABLE amazon_orders IS 'Amazon注文（消込ステータス: pending, completed, manual_required）';

-- inbound_items に order_id がない場合は追加（既存プロジェクトでは既にある想定）
-- ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS order_id TEXT;
