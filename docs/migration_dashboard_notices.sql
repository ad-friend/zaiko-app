-- ダッシュボード用お知らせ（例: 注文CSVで重複行をマージした旨）
-- Supabase SQL エディタで実行してください。

CREATE TABLE IF NOT EXISTS dashboard_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_notices_undismissed
  ON dashboard_notices (created_at DESC)
  WHERE dismissed_at IS NULL;

COMMENT ON TABLE dashboard_notices IS 'ダッシュボード表示用。確認後 dismissed_at で非表示';

ALTER TABLE dashboard_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon all on dashboard_notices"
  ON dashboard_notices FOR ALL
  USING (true) WITH CHECK (true);
