-- =============================================================================
-- 再取込・再消込用リセット: 2026-01-15 以降の sales_transactions 削除 + 在庫リセット
-- =============================================================================
-- RDBMS: PostgreSQL（Supabase 想定）
--
-- 方針:
--   1) inbound_items: settled_at / 返品メタ / exit_type / stock_status のみリセット
--   2) order_id は絶対に変更しない（NULL にしない）。再消込で order_id を参照するため。
--   3) sales_transactions: posted_date >= 境目の行を物理 DELETE
--
-- 実行順: まず「検証用 SELECT」のみ実行 → 件数・サンプルを確認 → トランザクション部を実行。
-- 実行前: バックアップ（PITR 等）を確認すること。
--
-- 参照: docs/sales_transactions_table.sql
--       docs/migration_inbound_items_stock_status.sql（stock_status: null/available が引当対象）
--       docs/migration_inbound_items_return_meta.sql（return_* 列が無い DB では該当 SET を外す）
--       app/api/amazon/reconcile-sales/route.ts
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ★ 境目（検証 SELECT とトランザクション内で必ず同じ値に揃える）
-- ---------------------------------------------------------------------------
-- UTC で 2026-01-15 00:00:00 以降を対象:
--   TIMESTAMPTZ '2026-01-15 00:00:00+00'
-- 日本日付の 2026-01-15 0 時（JST）を対象にする場合の例:
--   TIMESTAMPTZ '2026-01-15 00:00:00+09'


-- =============================================================================
-- 検証用 SELECT（トランザクション外で実行）
-- =============================================================================
-- 各クエリの cutoff CTE のリテラルを、下のトランザクション内 _cutoff と同じ値に揃えること。

-- 1) DELETE 対象となる売上件数
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00' AS ts
  -- JST 例: SELECT TIMESTAMPTZ '2026-01-15 00:00:00+09' AS ts
)
SELECT COUNT(*) AS delete_target_sales_rows
FROM sales_transactions st
CROSS JOIN cutoff c
WHERE st.posted_date >= c.ts;

-- 2) UPDATE 対象となる在庫行数（stock_id 経由で紐づく inbound_items.id の重複排除）
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00' AS ts
)
SELECT COUNT(DISTINCT st.stock_id) AS update_target_inbound_distinct_ids
FROM sales_transactions st
CROSS JOIN cutoff c
WHERE st.posted_date >= c.ts
  AND st.stock_id IS NOT NULL;

-- 3) 削除対象売上のサンプル（先頭 50 件）
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00' AS ts
)
SELECT st.id, st.amazon_order_id, st.sku, st.transaction_type, st.amount_type,
       st.amount, st.posted_date, st.stock_id, st.unit_cost
FROM sales_transactions st
CROSS JOIN cutoff c
WHERE st.posted_date >= c.ts
ORDER BY st.posted_date, st.id
LIMIT 50;

-- 4) UPDATE 対象在庫のサンプル（リセット後は settled_at / stock_status が NULL 系になる想定）
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00' AS ts
)
SELECT ii.id, ii.order_id, ii.settled_at, ii.stock_status,
       ii.return_amazon_order_id, ii.amazon_return_received_at, ii.exit_type
FROM inbound_items ii
WHERE ii.id IN (
  SELECT st.stock_id
  FROM sales_transactions st
  CROSS JOIN cutoff c
  WHERE st.posted_date >= c.ts
    AND st.stock_id IS NOT NULL
)
ORDER BY ii.id
LIMIT 50;


-- =============================================================================
-- 本処理: BEGIN → UPDATE → DELETE → COMMIT
-- =============================================================================
-- 検証用とは別セッションの場合、BEGIN 直後の CREATE TEMP で境目を再定義すること。

BEGIN;

CREATE TEMP TABLE _cutoff (ts TIMESTAMPTZ) ON COMMIT DROP AS
SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00'::TIMESTAMPTZ AS ts;
-- JST 例:
-- CREATE TEMP TABLE _cutoff (ts TIMESTAMPTZ) ON COMMIT DROP AS
-- SELECT TIMESTAMPTZ '2026-01-15 00:00:00+09'::TIMESTAMPTZ AS ts;

-- 1) 在庫リセット（order_id は SET に含めない＝維持）
--    return_* 列が無い DB では return_amazon_order_id / amazon_return_received_at の行を削除
UPDATE inbound_items ii
SET
  settled_at = NULL,
  return_amazon_order_id = NULL,
  amazon_return_received_at = NULL,
  exit_type = NULL,
  stock_status = NULL
WHERE ii.id IN (
  SELECT st.stock_id
  FROM sales_transactions st
  CROSS JOIN _cutoff c
  WHERE st.posted_date >= c.ts
    AND st.stock_id IS NOT NULL
);

-- 2) 売上の物理削除
DELETE FROM sales_transactions st
USING _cutoff c
WHERE st.posted_date >= c.ts;

COMMIT;
-- 問題があれば COMMIT の代わりに ROLLBACK;


-- =============================================================================
-- （任意・注記）同一注文で reconcile-sales が付けた settled_at の「兄弟行」
-- =============================================================================
-- reconcile-sales は order_id 単位で全明細に settled_at を一括設定する。
-- 削除対象の売上に stock_id が付いた行が無くても、同一 order_id の別 inbound 行に
-- settled_at だけ残ることがある。その場合は検証 SELECT で件数を確認し、必要なら
-- 次のような UPDATE を「同一注文の売上がすべて境目以降だけ」等の条件で別途検討する。
-- order_id は NULL にしないこと。
--
-- 例（危険度が高いため本番では必ず別 SELECT で対象 inbound id を確定してから）:
--
-- WITH cutoff AS (SELECT TIMESTAMPTZ '2026-01-15 00:00:00+00' AS ts),
-- doomed_orders AS (
--   SELECT DISTINCT NULLIF(BTRIM(st.amazon_order_id), '') AS oid
--   FROM sales_transactions st
--   CROSS JOIN cutoff c
--   WHERE st.posted_date >= c.ts
--     AND NULLIF(BTRIM(st.amazon_order_id), '') IS NOT NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM sales_transactions st2
--       CROSS JOIN cutoff c2
--       WHERE NULLIF(BTRIM(st2.amazon_order_id), '') = NULLIF(BTRIM(st.amazon_order_id), '')
--         AND st2.posted_date < c2.ts
--     )
-- )
-- UPDATE inbound_items ii
-- SET
--   settled_at = NULL,
--   return_amazon_order_id = NULL,
--   amazon_return_received_at = NULL,
--   exit_type = NULL,
--   stock_status = NULL
-- WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT oid FROM doomed_orders);
--
-- 上記は「境目より前の posted_date を同一注文に残さない注文」の在庫だけを揃える例。
-- 同一注文に境目前の売上が残る場合は対象外になる（誤って settled_at を消さない）。
