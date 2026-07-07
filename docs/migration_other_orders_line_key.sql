-- other_orders: SKU なし時は JAN で明細を区別（同一注文・複数商品対応）
-- Supabase ダッシュボード → SQL Editor で実行
--
-- 事前確認（重複があれば先に整理）:
--   SELECT order_id, platform, sku, jan_code, COUNT(*)
--   FROM other_orders
--   GROUP BY order_id, platform, sku, jan_code
--   HAVING COUNT(*) > 1;

DROP INDEX IF EXISTS idx_other_orders_order_platform_sku;

CREATE UNIQUE INDEX IF NOT EXISTS idx_other_orders_order_platform_sku_jan
  ON other_orders (order_id, platform, sku, jan_code);

COMMENT ON INDEX idx_other_orders_order_platform_sku_jan IS
  '他販路注文明細の一意キー（SKU 空の場合は JAN で区別）';
