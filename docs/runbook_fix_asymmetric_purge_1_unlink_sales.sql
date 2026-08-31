-- 本処理 1/2: 対象注文の売上をすべて未紐付に揃える
-- （古い stock_id / unit_cost をクリア。行は削除しない）
-- status 列がある場合のみ status もクリアしたいときは、下のコメントを外す

WITH target_orders AS (
  SELECT DISTINCT NULLIF(BTRIM(st.amazon_order_id), '') AS amazon_order_id
  FROM sales_transactions st
  WHERE st.stock_id IS NULL
    AND NULLIF(BTRIM(st.amazon_order_id), '') IS NOT NULL
    AND NULLIF(BTRIM(st.amazon_order_id), '') ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
    AND EXISTS (
      SELECT 1
      FROM amazon_orders ao
      WHERE ao.amazon_order_id = NULLIF(BTRIM(st.amazon_order_id), '')
    )
)
UPDATE sales_transactions st
SET
  stock_id = NULL,
  unit_cost = NULL
WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders);

-- status 列ありの場合の追加（任意）:
-- UPDATE sales_transactions st
-- SET status = NULL
-- WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (
--   SELECT DISTINCT NULLIF(BTRIM(x.amazon_order_id), '')
--   FROM sales_transactions x
--   WHERE x.stock_id IS NULL
--     AND NULLIF(BTRIM(x.amazon_order_id), '') ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
--     AND EXISTS (
--       SELECT 1 FROM amazon_orders ao
--       WHERE ao.amazon_order_id = NULLIF(BTRIM(x.amazon_order_id), '')
--     )
-- );
