-- docs/migration_sales_traffic_asin_totals.sql
CREATE TABLE IF NOT EXISTS sales_traffic_asin_totals (
  asin TEXT NOT NULL,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  units_ordered INTEGER NOT NULL,
  ordered_sales NUMERIC(14,2) NOT NULL,
  fetch_batch_id UUID NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asin, window_start, window_end)
);

CREATE INDEX IF NOT EXISTS idx_sales_traffic_asin_totals_window
  ON sales_traffic_asin_totals (window_end DESC, units_ordered DESC);

COMMENT ON TABLE sales_traffic_asin_totals IS
  '週1回（月曜）、直近90日ウィンドウでSP-APIから再取得するASIN別合計。「主力の在庫切れ数」の対象30 ASINを window_end が最新の行から units_ordered 降順で選ぶ。同じ(window_start,window_end)への書込みは必ず1回のbatch upsert（1SQL文）＋直後のprune DELETEの対で行い、不完全な途中状態を公開しない（指摘4対応、2章参照）';

ALTER TABLE sales_traffic_asin_totals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon select on sales_traffic_asin_totals"
  ON sales_traffic_asin_totals FOR SELECT TO anon USING (true);
-- INSERT/UPDATE/DELETEのポリシーは置かない＝anonキーでは書き込めない。書き込みはサーバー側のサービスロールキー（RLSを経由しない）からのみ行う（指摘6対応・9章1件目）
