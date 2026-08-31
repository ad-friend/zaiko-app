/* 本処理 1/3: 他販路対象注文の売上を削除。Amazon 注文番号は対象外。 */
WITH target_orders AS (
  SELECT DISTINCT NULLIF(BTRIM(oo.order_id), '') AS order_id
  FROM other_orders oo
  WHERE NULLIF(BTRIM(oo.order_id), '') IS NOT NULL
    AND NULLIF(BTRIM(oo.order_id), '') !~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
    AND NOT EXISTS (
      SELECT 1
      FROM amazon_orders ao
      WHERE ao.amazon_order_id = NULLIF(BTRIM(oo.order_id), '')
    )
),
linked_inbound AS (
  SELECT ii.id
  FROM inbound_items ii
  JOIN target_orders t ON NULLIF(BTRIM(ii.order_id), '') = t.order_id
)
DELETE FROM sales_transactions st
WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT order_id FROM target_orders)
   OR (st.stock_id IS NOT NULL AND st.stock_id IN (SELECT id FROM linked_inbound));
