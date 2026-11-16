-- docs/migration_sale_events.sql
CREATE TABLE IF NOT EXISTS sale_events (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_events_date_order CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_events_label_start
  ON sale_events (label, start_date);

COMMENT ON TABLE sale_events IS
  'ダッシュボード画面から入力するセール日程。グラフの帯表示・表の列に使う。新しいログイン画面は追加しない（論点5）。読み取りは無認証のままだが、書き込みはサーバー側のAPI（サービスロールキー）経由に絞る（論点6・9章1件目）';

ALTER TABLE sale_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon select on sale_events"
  ON sale_events FOR SELECT TO anon USING (true);
-- INSERT/UPDATE/DELETEのポリシーは置かない。書き込みは sale-events API（サーバー側のサービスロールキー）のみ（指摘6対応・9章1件目）
