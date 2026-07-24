-- DRY RUN のみ。件数確認用。
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
SELECT
  (SELECT COUNT(*) FROM amazon_orders ao CROSS JOIN cutoff c
    WHERE ao.created_at >= c.ts
      AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL) AS amazon_orders_rows,
  (SELECT COUNT(*) FROM target_orders) AS unique_amazon_order_ids,
  (SELECT COUNT(*) FROM sales_transactions st
    CROSS JOIN cutoff c
    WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
       OR (st.stock_id IS NOT NULL AND st.stock_id IN (SELECT id FROM linked_inbound))
       OR (
         st.posted_date >= c.ts
         AND (
           NULLIF(BTRIM(st.amazon_order_id), '') IS NULL
           OR NULLIF(BTRIM(st.amazon_order_id), '') ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
           OR NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
         )
       )
  ) AS sales_transactions_delete_rows,
  (SELECT COUNT(*) FROM inbound_items ii
    WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders)
       OR NULLIF(BTRIM(ii.return_amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
  ) AS inbound_items_reset_rows;
