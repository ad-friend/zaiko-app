-- =============================================================================
-- sales_transactions 全件削除 + 在庫の「決済済み」解除 — 手動メンテ用 runbook
-- =============================================================================
-- 実行前に必ず Supabase のバックアップ（PITR 等）を確認すること。
--
-- 【方針（推奨）】
--   - sales_transactions は「列だけ直す」ではなく **行をすべて削除** する。
--     旧 idempotency / 説明文の尾を残さないため。stock_id だけ NULL 等の部分更新は主手順に含めない。
--   - inbound_items は **settled_at を NULL** に戻し、**order_id は消さない**
--     （注文レポートとの紐づけ・再本消込のため。reconcile-sales は order_id で在庫を引く）。
-- 本番では別環境で試す・WHERE で範囲を絞るなど、必ずレビューしてから実行すること。
--
-- アプリ参照: app/api/amazon/reconcile-sales/route.ts
-- =============================================================================

-- 例: トランザクションでまとめて実行
-- BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 在庫側: settled_at のみ解除（order_id は触らない）
-- ---------------------------------------------------------------------------
-- 推奨: 売上を全捨てして本消込からやり直す場合、在庫の「決済印」だけ外す。
--
-- パターン A — settled_at が付いている行だけ対象（やや安全）
-- UPDATE inbound_items
-- SET settled_at = NULL
-- WHERE settled_at IS NOT NULL;

-- パターン B — さらに order_id や倉庫で絞る場合の例（列名・条件は環境に合わせて編集）
-- UPDATE inbound_items
-- SET settled_at = NULL
-- WHERE settled_at IS NOT NULL
--   AND order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) 売上: テーブルを空にする（主手順）
-- ---------------------------------------------------------------------------
-- DELETE FROM sales_transactions;
--
-- 代替: TRUNCATE は高速だが、他テーブルから FK 参照があると RESTRICT で失敗する。
--       参照が無ければ例: TRUNCATE TABLE sales_transactions RESTART IDENTITY;
--       アプリは idempotency_key 主なので id の連番リセットは必須ではない。

-- ---------------------------------------------------------------------------
-- （参考）売上を消す「前」に、注文単位で inbound だけ unsettle したい場合
-- ---------------------------------------------------------------------------
-- sales_transactions から注文一覧を読んでから DELETE する順が必要。
-- 例（コメントのみ）:
-- UPDATE inbound_items ii
-- SET settled_at = NULL
-- FROM (
--   SELECT DISTINCT trim(amazon_order_id) AS oid
--   FROM sales_transactions
--   WHERE amazon_order_id IS NOT NULL AND trim(amazon_order_id) <> ''
-- ) s
-- WHERE trim(ii.order_id) = s.oid;
-- その後:
-- DELETE FROM sales_transactions;

-- 例: 問題なければ
-- COMMIT;
-- 取り消す場合は ROLLBACK;

-- =============================================================================
-- 再取込後: CSV（プレビュー→取り込み）や fetch-finances 等で sales を再構築し、
-- reconcile-sales を運用フローに従って再実行する。
-- 参照: docs/sales_transactions_source_policy.md
--       docs/runbook_sales_transactions_backfill_and_health.md
-- =============================================================================
