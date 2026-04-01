-- 返品検品待ちカード用: Amazon 注文番号（引当解除後も表示）と返品レポート上の受付/発生日時
-- Supabase SQL エディタで実行してください。

ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS return_amazon_order_id TEXT;

ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS amazon_return_received_at TIMESTAMPTZ;

COMMENT ON COLUMN inbound_items.return_amazon_order_id IS '返品取り込み時点の Amazon 注文番号（order_id 解除後も検品UI用に保持）';

COMMENT ON COLUMN inbound_items.amazon_return_received_at IS '返品レポート由来の返品受付/発生日時（レポート列から取得）';

CREATE INDEX IF NOT EXISTS idx_inbound_items_return_amazon_order_id ON inbound_items (return_amazon_order_id)
  WHERE return_amazon_order_id IS NOT NULL;