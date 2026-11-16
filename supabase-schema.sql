-- =====================================================
-- Supabase SQLエディタで実行するテーブル作成SQL
-- 在庫管理アプリ用（入荷データ保存）
-- =====================================================

-- 入荷ヘッダー（1件の入荷伝票）
CREATE TABLE inbound_headers (
  id BIGSERIAL PRIMARY KEY,
  purchase_date DATE NOT NULL,
  supplier TEXT,
  genre TEXT,
  total_purchase_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 入荷明細（商品行：JANコード・商品名・価格・数量分の行・状態・登録日時）
CREATE TABLE inbound_items (
  id BIGSERIAL PRIMARY KEY,
  header_id BIGINT NOT NULL REFERENCES inbound_headers(id) ON DELETE CASCADE,
  jan_code TEXT,
  brand TEXT,
  product_name TEXT,
  model_number TEXT,
  condition_type TEXT,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_fixed_price BOOLEAN NOT NULL DEFAULT false,
  effective_unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inbound_items_header_id ON inbound_items(header_id);

-- Row Level Security（RLS）を有効化し、anonキーでAPIから挿入・参照できるようにする
ALTER TABLE inbound_headers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon all on inbound_headers"
  ON inbound_headers FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon all on inbound_items"
  ON inbound_items FOR ALL
  USING (true) WITH CHECK (true);

-- 仕入先マスタ（仕入先管理ページ用）
CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kana TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_kana ON suppliers (kana);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon all on suppliers"
  ON suppliers FOR ALL
  USING (true) WITH CHECK (true);

-- 入庫登録実行時刻（登録日として一覧表示）
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 在庫調整理由（破損・紛失・社内使用・接待）
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS exit_type TEXT;

-- Amazon 返品の検品待ち（引当除外用）。詳細は docs/migration_inbound_items_stock_status.sql
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS stock_status TEXT;

-- パーツ組み付け（親子ツリー）。詳細は docs/migration_inbound_items_assembly.sql
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS parent_item_id BIGINT REFERENCES inbound_items(id) ON DELETE SET NULL;
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS item_kind TEXT NOT NULL DEFAULT 'product';
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS part_code TEXT;

-- ダッシュボードお知らせ。詳細は docs/migration_dashboard_notices.sql
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
ALTER TABLE dashboard_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow anon all on dashboard_notices"
  ON dashboard_notices FOR ALL
  USING (true) WITH CHECK (true);

-- パーツマスタ。詳細は docs/migration_parts_catalog.sql
CREATE TABLE IF NOT EXISTS parts_catalog (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 相談-10: dashboard sales analysis
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
