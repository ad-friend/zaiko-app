-- SKUマッピングテーブル（ECサイトSKU と システムJAN の紐付け）
-- セット品（1 SKU に複数 JAN）対応のため、sku 単体の UNIQUE は設けず、
-- (sku, jan_code) の複合ユニーク制約とする。

CREATE TABLE IF NOT EXISTS sku_mappings (
  id         BIGSERIAL PRIMARY KEY,
  sku        TEXT      NOT NULL,
  title      TEXT,
  platform   TEXT      NOT NULL,
  jan_code   TEXT      NOT NULL,
  quantity   INTEGER   NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sku, jan_code)
);

-- title カラムを後から追加する場合（既存DB用）:
-- ALTER TABLE sku_mappings ADD COLUMN IF NOT EXISTS title TEXT;

-- 検索用インデックス（任意）
CREATE INDEX IF NOT EXISTS idx_sku_mappings_sku ON sku_mappings (sku);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_platform ON sku_mappings (platform);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_jan_code ON sku_mappings (jan_code);

COMMENT ON TABLE sku_mappings IS 'ECサイトSKUとシステムJANの紐付けマスター（セット品対応）';
