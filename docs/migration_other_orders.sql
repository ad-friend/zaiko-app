-- other_orders: 他販路 Amazon 同等消込用マイグレーション
-- 実行場所: Supabase ダッシュボード → SQL Editor
-- プロジェクト: .env.local の NEXT_PUBLIC_SUPABASE_URL に対応する Supabase プロジェクト
--
-- 事前確認:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'other_orders' ORDER BY ordinal_position;

-- -----------------------------------------------------------------------------
-- パートA: テーブルが無い場合のみ
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS other_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              TEXT NOT NULL,
  platform              TEXT NOT NULL,
  sell_price            INTEGER NOT NULL DEFAULT 0,
  jan_code              TEXT,
  stock_id              INTEGER,
  status                TEXT NOT NULL DEFAULT 'pending',
  sku                   TEXT NOT NULL DEFAULT '',
  quantity              INTEGER NOT NULL DEFAULT 1,
  condition_id          TEXT NOT NULL DEFAULT 'New',
  reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  order_date            TIMESTAMPTZ,
  posted_date           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- パートB: 既存テーブルに列を追加（テーブルがある場合はここからで可）
-- -----------------------------------------------------------------------------
ALTER TABLE other_orders
  ADD COLUMN IF NOT EXISTS sku                   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS quantity              INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS condition_id          TEXT NOT NULL DEFAULT 'New',
  ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS order_date            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_date           TIMESTAMPTZ;

-- 旧 status → reconciliation_status（既存行）
UPDATE other_orders
SET reconciliation_status = CASE
  WHEN status = 'completed'       THEN 'reconciled'
  WHEN status = 'manual_required' THEN 'manual_required'
  ELSE 'pending'
END
WHERE reconciliation_status IS NULL
   OR reconciliation_status = 'pending';

UPDATE other_orders SET sell_price = 0 WHERE sell_price IS NULL;

-- -----------------------------------------------------------------------------
-- パートC: インデックス
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_other_orders_order_platform;

CREATE UNIQUE INDEX IF NOT EXISTS idx_other_orders_order_platform_sku
  ON other_orders (order_id, platform, sku);

CREATE INDEX IF NOT EXISTS idx_other_orders_reconciliation_status
  ON other_orders (reconciliation_status);

CREATE INDEX IF NOT EXISTS idx_other_orders_platform
  ON other_orders (platform);

CREATE INDEX IF NOT EXISTS idx_other_orders_order_id
  ON other_orders (order_id);

-- -----------------------------------------------------------------------------
-- パートD: コメント
-- -----------------------------------------------------------------------------
COMMENT ON TABLE other_orders IS
  '他販路注文（在庫引当・売上消込）。reconciliation_status: pending / reconciled / manual_required';

COMMENT ON COLUMN other_orders.sku IS '出品SKU（sku_mappings.platform と一致させる）';
COMMENT ON COLUMN other_orders.quantity IS '注文数量';
COMMENT ON COLUMN other_orders.condition_id IS 'コンディション（New / Used 等）';
COMMENT ON COLUMN other_orders.reconciliation_status IS '在庫引当ステータス（amazon_orders と同義）';
COMMENT ON COLUMN other_orders.order_date IS '注文日時';
COMMENT ON COLUMN other_orders.posted_date IS '決済日時（本消込 settled_at の元）';
