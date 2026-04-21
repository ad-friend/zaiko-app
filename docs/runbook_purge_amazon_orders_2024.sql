-- =============================================================================
-- 2024年の Amazon 注文データ削除 + 在庫引当解除（安全にトランザクションで実行）
-- 対象期間: 2024-01-01 〜 2024-12-31（amazon_orders.created_at 基準）
--
-- 方針:
--  1) 対象注文ID集合を CTE で固定
--  2) FK/参照エラー回避のため、子データ（sales_transactions）を先に削除
--  3) 在庫（inbound_items）の order_id 等を NULL に戻し、状態を初期へリセット
--  4) 注文本体（amazon_orders）を削除
--
-- 実行前:
--  - Supabase のバックアップ（PITR等）確認を推奨
--  - まず「DRY RUN（件数確認）」の SELECT だけ実行して影響範囲を確認
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 対象注文（2024年 created_at）を固定
-- ---------------------------------------------------------------------------
WITH target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  WHERE ao.created_at >= '2024-01-01T00:00:00Z'
    AND ao.created_at <  '2025-01-01T00:00:00Z'
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
),
linked_inbound AS (
  SELECT ii.id
  FROM inbound_items ii
  JOIN target_orders t
    ON NULLIF(BTRIM(ii.order_id), '') = t.amazon_order_id
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM amazon_orders ao
      WHERE ao.created_at >= '2024-01-01T00:00:00Z'
        AND ao.created_at <  '2025-01-01T00:00:00Z'
        AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
        AND ao.amazon_order_id IN (SELECT amazon_order_id FROM target_orders)
    ) AS amazon_orders_rows,
    (SELECT COUNT(*) FROM sales_transactions st
      WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
    ) AS sales_transactions_by_order_id,
    (SELECT COUNT(*) FROM sales_transactions st
      WHERE st.stock_id IS NOT NULL
        AND st.stock_id IN (SELECT id FROM linked_inbound)
    ) AS sales_transactions_by_stock_id,
    (SELECT COUNT(*) FROM inbound_items ii
      WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders)
    ) AS inbound_items_linked
)
SELECT * FROM counts;

-- ---------------------------------------------------------------------------
-- 1) 子データ削除: sales_transactions（FK/参照エラー回避のため先に削除）
-- ---------------------------------------------------------------------------
WITH target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  WHERE ao.created_at >= '2024-01-01T00:00:00Z'
    AND ao.created_at <  '2025-01-01T00:00:00Z'
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
),
linked_inbound AS (
  SELECT ii.id
  FROM inbound_items ii
  JOIN target_orders t
    ON NULLIF(BTRIM(ii.order_id), '') = t.amazon_order_id
)
DELETE FROM sales_transactions st
WHERE (
    NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
  )
   OR (
    st.stock_id IS NOT NULL
    AND st.stock_id IN (SELECT id FROM linked_inbound)
  );

-- ---------------------------------------------------------------------------
-- 2) 在庫: 引当解除 + 状態を初期へ
--   - order_id: NULL（引当解除）
--   - settled_at: NULL（決済済み解除）
--   - stock_status: NULL（初期値に戻す。NULL/available が引当対象）
--   - return_* メタ: NULL（検品待ちカード情報のクリア）
--   - exit_type: NULL（誤紐付け由来の調整状態も初期へ）
-- ---------------------------------------------------------------------------
WITH target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  WHERE ao.created_at >= '2024-01-01T00:00:00Z'
    AND ao.created_at <  '2025-01-01T00:00:00Z'
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
)
UPDATE inbound_items ii
SET
  order_id = NULL,
  settled_at = NULL,
  stock_status = NULL,
  return_amazon_order_id = NULL,
  amazon_return_received_at = NULL,
  exit_type = NULL
WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders);

-- ---------------------------------------------------------------------------
-- 3) 注文: 本体削除（created_at 条件も付けて範囲外の誤削除を防止）
-- ---------------------------------------------------------------------------
WITH target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  WHERE ao.created_at >= '2024-01-01T00:00:00Z'
    AND ao.created_at <  '2025-01-01T00:00:00Z'
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
)
DELETE FROM amazon_orders ao
WHERE ao.created_at >= '2024-01-01T00:00:00Z'
  AND ao.created_at <  '2025-01-01T00:00:00Z'
  AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
  AND ao.amazon_order_id IN (SELECT amazon_order_id FROM target_orders);

COMMIT;

-- 取り消す場合:
-- ROLLBACK;

