-- Cron 分割用: 財務 API NextToken / 出品レポートの段階状態
-- Supabase SQL エディタで実行してください。

CREATE TABLE IF NOT EXISTS cron_continuation_state (
  state_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_continuation_state_updated
  ON cron_continuation_state (updated_at DESC);

COMMENT ON TABLE cron_continuation_state IS 'Vercel Cron の分割実行用（listFinancialEvents の NextToken、Reports の reportId 等）';

ALTER TABLE cron_continuation_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon all on cron_continuation_state"
  ON cron_continuation_state FOR ALL
  USING (true) WITH CHECK (true);
