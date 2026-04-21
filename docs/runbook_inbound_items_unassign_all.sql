-- =============================================================================
-- inbound_items の引当を全解除（再度の自動消込を前提）
--
-- 目的:
--  - inbound_items.order_id が入っている行を全件「未引当」に戻す
--  - ユーザー要件により、強め初期化として以下も NULL に戻す:
--      settled_at / stock_status / return_amazon_order_id / amazon_return_received_at / exit_type
--
-- 実行前:
--  - Supabase のバックアップ（PITR等）確認を推奨
--  - まず DRY RUN（件数確認）の SELECT 結果を見て影響範囲を把握
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- DRY RUN: 影響件数の確認（更新はまだ行わない）
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(order_id), '') IS NOT NULL) AS inbound_items_to_unassign,
  COUNT(*) FILTER (WHERE settled_at IS NOT NULL) AS inbound_items_with_settled_at,
  COUNT(*) FILTER (WHERE stock_status IS NOT NULL) AS inbound_items_with_stock_status,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(return_amazon_order_id), '') IS NOT NULL) AS inbound_items_with_return_meta,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(exit_type), '') IS NOT NULL) AS inbound_items_with_exit_type
FROM inbound_items;

-- ---------------------------------------------------------------------------
-- 引当解除 + 初期化（強め）
-- ---------------------------------------------------------------------------
UPDATE inbound_items
SET
  order_id = NULL,
  settled_at = NULL,
  stock_status = NULL,
  return_amazon_order_id = NULL,
  amazon_return_received_at = NULL,
  exit_type = NULL
WHERE NULLIF(BTRIM(order_id), '') IS NOT NULL;

COMMIT;

-- 取り消す場合:
-- ROLLBACK;

-- =============================================================================
-- 調整ポイント（維持したい列がある場合）
-- =============================================================================
-- - 返品フロー（検品待ち）を維持したい:
--     stock_status / return_amazon_order_id / amazon_return_received_at を UPDATE から外す
-- - 在庫調整（破損・紛失等）を維持したい:
--     exit_type を UPDATE から外す
-- - 「決済済み（settled_at）」だけは残したい:
--     settled_at を UPDATE から外す（ただし再消込時に整合しない可能性あり）
-- =============================================================================

