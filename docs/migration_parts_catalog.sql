-- パーツマスタ（固定コード＋正式名称）と inbound_items.part_code
-- Supabase SQL エディタで実行してください。
-- ※ docs/migration_inbound_items_assembly.sql（item_kind）を先に適用済み想定。

CREATE TABLE IF NOT EXISTS parts_catalog (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE parts_catalog IS 'パーツマスタ。code は固定識別子（例: PS4-RIBBON-12P）。名称の正はここ。';
COMMENT ON COLUMN parts_catalog.code IS 'パーツコード（大文字英数・ハイフン推奨）。変更不可に近い運用';
COMMENT ON COLUMN parts_catalog.name IS '正式名称（入庫時に inbound_items.product_name へコピー）';

CREATE INDEX IF NOT EXISTS idx_parts_catalog_name ON parts_catalog (name);
CREATE INDEX IF NOT EXISTS idx_parts_catalog_brand ON parts_catalog (brand);

ALTER TABLE parts_catalog ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Allow anon all on parts_catalog'
  ) THEN
    CREATE POLICY "Allow anon all on parts_catalog"
      ON parts_catalog FOR ALL
      USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS part_code TEXT;

COMMENT ON COLUMN inbound_items.part_code IS 'パーツマスタ code。item_kind=part のとき設定。products には載せない';

CREATE INDEX IF NOT EXISTS idx_inbound_items_part_code
  ON inbound_items (part_code)
  WHERE part_code IS NOT NULL;
