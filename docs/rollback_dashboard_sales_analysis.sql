-- docs/rollback_dashboard_sales_analysis.sql
DROP INDEX IF EXISTS idx_amazon_orders_asin;
DROP INDEX IF EXISTS idx_inbound_items_asin;
DROP TABLE IF EXISTS sale_events;
DROP TABLE IF EXISTS google_trends_daily;
DROP TABLE IF EXISTS sales_traffic_asin_totals;
DROP TABLE IF EXISTS sales_traffic_daily;
