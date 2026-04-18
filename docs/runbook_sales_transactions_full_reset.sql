-- =============================================================================
-- sales_transactions 全削除 + 在庫（inbound_items）の売上紐づけ解除 — 手動メンテ用
-- =============================================================================
-- 実行前に必ず Supabase のバックアップ（PITR 等）を確認すること。
-- アプリの本消込は [app/api/amazon/reconcile-sales/route.ts] が
--   sales_transactions に stock_id / unit_cost を付与し、
--   inbound_items に order_id・settled_at を付与する想定である。
-- ここでは「全売上を捨てて在庫の決済印も外す」ための最小例を示す。
-- 本番では WHERE で範囲を絞る・別環境で試すなど、必ずレビューしてから実行すること。
-- =============================================================================

-- 例: トランザクションでまとめて実行
-- BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 売上側: 在庫への参照を外す（DELETE の前でも可。FK が無い前提の UPDATE）
-- ---------------------------------------------------------------------------
-- UPDATE sales_transactions
-- SET stock_id = NULL, unit_cost = NULL
-- WHERE stock_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) 在庫側: 本消込で付いた settled_at を外す
-- ---------------------------------------------------------------------------
-- パターン A — 売上テーブルにまだ amazon_order_id が残っている間に、
--              その注文に紐づく inbound だけ unsettle する
-- UPDATE inbound_items ii
-- SET settled_at = NULL
-- FROM (
--   SELECT DISTINCT trim(amazon_order_id) AS oid
--   FROM sales_transactions
--   WHERE amazon_order_id IS NOT NULL AND trim(amazon_order_id) <> ''
-- ) s
-- WHERE trim(ii.order_id) = s.oid;

-- パターン B — 全在庫の settled_at を一括 NULL（影響最大。通常は非推奨）
-- UPDATE inbound_items SET settled_at = NULL WHERE settled_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) 売上テーブル全削除
-- ---------------------------------------------------------------------------
-- DELETE FROM sales_transactions;

-- 例: 問題なければ
-- COMMIT;
-- 取り消す場合は ROLLBACK;

-- =============================================================================
-- 再取込後: STEP2（在庫に order_id 付与）→ reconcile-sales 等を運用フローに従って再実行
-- 参照: docs/sales_transactions_source_policy.md
-- =============================================================================
