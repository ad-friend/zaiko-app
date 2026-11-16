-- docs/migration_sales_traffic_daily.sql
CREATE TABLE IF NOT EXISTS sales_traffic_daily (
  date DATE PRIMARY KEY,
  sessions INTEGER NOT NULL,
  page_views INTEGER NOT NULL,
  buy_box_percentage NUMERIC(6,3) NOT NULL,
  unit_session_percentage NUMERIC(6,3) NOT NULL,
  ordered_product_sales NUMERIC(14,2) NOT NULL,
  total_order_items INTEGER NOT NULL,
  units_ordered INTEGER NOT NULL,
  source_report_id TEXT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sales_traffic_daily IS
  'SP-API GET_SALES_AND_TRAFFIC_REPORT（dateGranularity=DAY, asinGranularity=CHILD, JPのみ）の店全体集計。date はレポートのdate文字列をそのまま保存（JSTとの対応はU-date1として未確認）。既存の決済ベース売上（lib/dashboard-aggregates.ts）とは基準が異なる注文ベースの値であり、画面では区別して表示する';

ALTER TABLE sales_traffic_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon select on sales_traffic_daily"
  ON sales_traffic_daily FOR SELECT TO anon USING (true);
-- INSERT/UPDATE/DELETEのポリシーは置かない。書き込みはサーバー側のサービスロールキーのみ（指摘6対応・9章1件目）
