-- 本処理 1/3: 売上削除
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-06-30 00:00:00+09' AS ts
),
target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  CROSS JOIN cutoff c
  WHERE ao.created_at >= c.ts
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
),
linked_inbound AS (
  SELECT ii.id
  FROM inbound_items ii
  JOIN target_orders t ON (
    NULLIF(BTRIM(ii.order_id), '') = t.amazon_order_id
    OR NULLIF(BTRIM(ii.return_amazon_order_id), '') = t.amazon_order_id
  )
)
DELETE FROM sales_transactions st
WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
   OR (st.stock_id IS NOT NULL AND st.stock_id IN (SELECT id FROM linked_inbound))
   OR (
     st.posted_date >= (SELECT ts FROM cutoff)
     AND (
       NULLIF(BTRIM(st.amazon_order_id), '') IS NULL
       OR NULLIF(BTRIM(st.amazon_order_id), '') ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
       OR NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
     )
   );
