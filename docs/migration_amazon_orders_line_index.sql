-- 同一注文・同一SKUの複数明細行を区別する（fetch-orders の upsert で行が潰れないようにする）
-- Supabase SQL エディタで実行してください。既存行は line_index = 0 のまま1行として扱われます。
--
-- 注意: 旧 UNIQUE が制約名 amazon_orders_amazon_order_id_sku_key で残っている場合は
-- この DROP INDEX では消えません。続けて migration_amazon_orders_drop_order_sku_unique.sql を実行してください。

ALTER TABLE amazon_orders ADD COLUMN IF NOT EXISTS line_index INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_amazon_orders_order_id_sku;

CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_orders_order_sku_line
  ON amazon_orders (amazon_order_id, sku, line_index);

COMMENT ON COLUMN amazon_orders.line_index IS '同一注文内の明細行の並び（0始まり）。SP-API OrderItems の列順に一致。';
