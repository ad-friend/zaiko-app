-- Amazon 返品の検品待ちフロー用: inbound_items.stock_status
-- Supabase SQL エディタで実行してください。

ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS stock_status TEXT;

COMMENT ON COLUMN inbound_items.stock_status IS '在庫ライフサイクル: null/available=販売可能引当対象, return_inspection=返品検品待ち（引当除外）';

CREATE INDEX IF NOT EXISTS idx_inbound_items_stock_status ON inbound_items (stock_status)
  WHERE stock_status IS NOT NULL;
