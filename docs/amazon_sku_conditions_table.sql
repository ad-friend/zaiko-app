-- Amazon 出品詳細レポート（Active Listings）由来の SKU→コンディション辞書
CREATE TABLE IF NOT EXISTS amazon_sku_conditions (
  sku TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  asin TEXT,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_sku_conditions_last_updated ON amazon_sku_conditions (last_updated);

COMMENT ON TABLE amazon_sku_conditions IS 'セラーセントラル出品レポートから同期。item-condition 11=New それ以外=Used';
COMMENT ON COLUMN amazon_sku_conditions.sku IS 'seller-sku';
COMMENT ON COLUMN amazon_sku_conditions.condition_id IS 'New または Used';
COMMENT ON COLUMN amazon_sku_conditions.asin IS 'asin1';
COMMENT ON COLUMN amazon_sku_conditions.last_updated IS '最終同期時刻（古い行は定期削除対象）';
