-- DRY RUN サンプル（先頭20注文）。0 の件数確認と別実行可
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
SELECT amazon_order_id
FROM target_orders
ORDER BY amazon_order_id
LIMIT 20;
