-- 進捗ソート列に「補填済み」（order_id なし + settled_at あり）を追加
-- 既に migration_inbound_items_inventory_progress_rank.sql を実行済みの DB で、
-- 生成式を差し替える場合に Supabase SQL エディタで実行してください。
--
-- ランク: 10=販売中, 20=引当済, 25=補填済み, 30=販売済, 40=返品検品, 50=イレギュラー/廃棄
-- アプリ側は lib/inventory-status-display.ts の getInventoryStatusSortRank と揃えています。

DROP INDEX IF EXISTS idx_inbound_items_inventory_progress_rank_id;

ALTER TABLE inbound_items DROP COLUMN IF EXISTS inventory_progress_rank;

ALTER TABLE inbound_items
  ADD COLUMN inventory_progress_rank integer
  GENERATED ALWAYS AS (
    CASE
      WHEN NULLIF(TRIM(COALESCE(exit_type, '')), '') IS NOT NULL THEN 50
      WHEN lower(trim(COALESCE(stock_status, ''))) = 'disposed' THEN 50
      WHEN lower(trim(COALESCE(stock_status, ''))) = 'return_inspection' THEN 40
      WHEN NULLIF(TRIM(COALESCE(order_id, '')), '') IS NOT NULL
           AND settled_at IS NOT NULL THEN 30
      WHEN NULLIF(TRIM(COALESCE(order_id, '')), '') IS NOT NULL THEN 20
      WHEN settled_at IS NOT NULL THEN 25
      ELSE 10
    END
  ) STORED;

COMMENT ON COLUMN inbound_items.inventory_progress_rank IS
  '在庫一覧「進捗」ソート用。10=販売中,20=引当済,25=補填済み,30=販売済,40=返品検品,50=イレギュラー';

CREATE INDEX IF NOT EXISTS idx_inbound_items_inventory_progress_rank_id
  ON inbound_items (inventory_progress_rank, id);
