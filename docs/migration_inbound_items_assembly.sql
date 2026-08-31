-- パーツ組み付け（親子ツリー）用: inbound_items.parent_item_id / item_kind
-- Supabase SQL エディタで実行してください。
-- 既存行は DEFAULT により product + parent NULL（現行と同じ挙動）。

ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS parent_item_id BIGINT REFERENCES inbound_items(id) ON DELETE SET NULL;

ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS item_kind TEXT NOT NULL DEFAULT 'product';

COMMENT ON COLUMN inbound_items.parent_item_id IS '組み付け先の親在庫ID。NULL=単体で存在（引当対象）。子は単体引当・有効在庫カウントから除外';
COMMENT ON COLUMN inbound_items.item_kind IS 'product=通常商品（本体・コントローラ等） / part=パーツ（基板内部等）。一覧分け用。DEFAULT product';

-- 自己参照のため、既存FKに加え検索用インデックス
CREATE INDEX IF NOT EXISTS idx_inbound_items_parent_item_id
  ON inbound_items (parent_item_id)
  WHERE parent_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_items_item_kind
  ON inbound_items (item_kind)
  WHERE item_kind IS DISTINCT FROM 'product';

-- 不正値のゆるいチェック（既存アプリは product / part のみ使用）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inbound_items_item_kind_check'
  ) THEN
    ALTER TABLE inbound_items
      ADD CONSTRAINT inbound_items_item_kind_check
      CHECK (item_kind IN ('product', 'part'));
  END IF;
END $$;
