-- docs/migration_google_trends_daily.sql
CREATE TABLE IF NOT EXISTS google_trends_daily (
  date DATE NOT NULL,
  keyword TEXT NOT NULL DEFAULT 'Amazon',
  trend_value NUMERIC(6,2) NOT NULL,
  fetch_batch_id UUID NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, keyword)
);

CREATE INDEX IF NOT EXISTS idx_google_trends_daily_batch
  ON google_trends_daily (fetch_batch_id);

COMMENT ON TABLE google_trends_daily IS
  '週1回（月曜）、直近90日を1回のpytrends呼出しで取り直し、同じ fetch_batch_id で全日付を上書きする。90日以内は単一呼出しで日次粒度が返るため、2窓接合・倍率調整は行わない（根拠：fetch_trends.py 冒頭コメント、2026-11-12）。keyword は将来の複数キーワード対応用、現状はAmazon固定。書込みAPI（trends-import）は、受け取った配列が要求期間ぶん完全であることを検証したうえで1回のbatch upsert＋直後のprune DELETEを行う（指摘5対応）';

ALTER TABLE google_trends_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon select on google_trends_daily"
  ON google_trends_daily FOR SELECT TO anon USING (true);
-- INSERT/UPDATE/DELETEのポリシーは置かない。書き込みはtrends-import API（サーバー側のサービスロールキー）のみ（指摘6対応・9章1件目）
