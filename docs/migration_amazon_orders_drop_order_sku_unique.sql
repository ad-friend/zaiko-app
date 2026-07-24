-- CSV 一括インポートが ON CONFLICT (amazon_order_id, sku, line_index) なのに、
-- 旧 UNIQUE (amazon_order_id, sku) が残っていると、既存行の line_index が 0 以外のとき
-- INSERT 扱いになり 23505 (amazon_orders_amazon_order_id_sku_key) になる。
-- Supabase SQL エディタで実行してください。

-- テーブル制約として残っている場合
ALTER TABLE amazon_orders DROP CONSTRAINT IF EXISTS amazon_orders_amazon_order_id_sku_key;

-- UNIQUE INDEX として残っている場合（名前ゆれを両方落とす）
DROP INDEX IF EXISTS amazon_orders_amazon_order_id_sku_key;
DROP INDEX IF EXISTS idx_amazon_orders_order_id_sku;

-- 意図する一意性: 注文 + SKU + 明細行
CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_orders_order_sku_line
  ON amazon_orders (amazon_order_id, sku, line_index);
