-- 在庫一覧「進捗」全件ソート用（アプリ getInventoryStatusSortRank と同一優先順位）
-- 10=販売中, 20=引当済, 30=販売済, 40=返品検品待ち, 50=イレギュラー/廃棄

ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS inventory_progress_rank integer
  GENERATED ALWAYS AS (
    CASE
      WHEN NULLIF(TRIM(COALESCE(exit_type, '')), '') IS NOT NULL THEN 50
      WHEN lower(trim(COALESCE(stock_status, ''))) = 'disposed' THEN 50
      WHEN lower(trim(COALESCE(stock_status, ''))) = 'return_inspection' THEN 40
      WHEN NULLIF(TRIM(COALESCE(order_id, '')), '') IS NOT NULL
           AND settled_at IS NOT NULL THEN 30
      WHEN NULLIF(TRIM(COALESCE(order_id, '')), '') IS NOT NULL THEN 20
      ELSE 10
    END
  ) STORED;

COMMENT ON COLUMN inbound_items.inventory_progress_rank IS
  '在庫一覧「進捗」ソート用。TS getInventoryStatusSortRank と同一優先順位。';

CREATE INDEX IF NOT EXISTS idx_inbound_items_inventory_progress_rank_id
  ON inbound_items (inventory_progress_rank, id);
