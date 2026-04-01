-- 定期実行ジョブの履歴（成功/失敗/件数/エラー）を保存する
-- Supabase SQL エディタで実行してください。

CREATE TABLE IF NOT EXISTS cron_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key TEXT NOT NULL,
  status TEXT NOT NULL, -- running | success | error
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT NULL,
  error_message TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_key_started
  ON cron_jobs (job_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_started
  ON cron_jobs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_status
  ON cron_jobs (status);

COMMENT ON TABLE cron_jobs IS 'Vercel Cron 等で実行したジョブ履歴。started_at 基準で定期的に削除する';

ALTER TABLE cron_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon all on cron_jobs"
  ON cron_jobs FOR ALL
  USING (true) WITH CHECK (true);

-- 90日保持の削除例（Cron 内でも実行する想定）
-- DELETE FROM cron_jobs WHERE started_at < NOW() - INTERVAL '90 days';
