/* DRY RUN のみ。件数確認。変更しない。Amazon 形式の注文番号は skipped に出す。 */
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
skipped_orders AS (
  SELECT DISTINCT NULLIF(BTRIM(oo.order_id), '') AS order_id
  FROM other_orders oo
  WHERE NULLIF(BTRIM(oo.order_id), '') IS NOT NULL
    AND (
      NULLIF(BTRIM(oo.order_id), '') ~ '^[0-9]{3}-[0-9]{7}-[0-9]{7}$'
      OR EXISTS (
        SELECT 1
        FROM amazon_orders ao
        WHERE ao.amazon_order_id = NULLIF(BTRIM(oo.order_id), '')
      )
    )
),
linked_inbound AS (
  SELECT ii.id
  FROM inbound_items ii
  JOIN target_orders t ON NULLIF(BTRIM(ii.order_id), '') = t.order_id
)
SELECT
  (SELECT COUNT(*) FROM other_orders) AS other_orders_rows,
  (SELECT COUNT(DISTINCT NULLIF(BTRIM(order_id), '')) FROM other_orders
     WHERE NULLIF(BTRIM(order_id), '') IS NOT NULL) AS unique_other_order_ids,
  (SELECT COUNT(*) FROM target_orders) AS target_order_ids,
  (SELECT COUNT(*) FROM other_orders oo
     WHERE NULLIF(BTRIM(oo.order_id), '') IN (SELECT order_id FROM target_orders)
  ) AS other_orders_delete_rows,
  (SELECT COUNT(*) FROM skipped_orders) AS skipped_amazon_like_order_ids,
  (SELECT COUNT(*) FROM other_orders oo
     WHERE NULLIF(BTRIM(oo.order_id), '') IN (SELECT order_id FROM skipped_orders)
  ) AS skipped_other_orders_rows,
  (SELECT COUNT(*) FROM sales_transactions st
     WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT order_id FROM target_orders)
        OR (st.stock_id IS NOT NULL AND st.stock_id IN (SELECT id FROM linked_inbound))
  ) AS sales_transactions_delete_rows,
  (SELECT COUNT(*) FROM inbound_items ii
     WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT order_id FROM target_orders)
  ) AS inbound_items_reset_rows;
