-- docs/migration_sales_analysis_perf_indexes.sql（任意）
CREATE INDEX IF NOT EXISTS idx_inbound_items_asin ON inbound_items (asin);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_asin ON amazon_orders (asin);
