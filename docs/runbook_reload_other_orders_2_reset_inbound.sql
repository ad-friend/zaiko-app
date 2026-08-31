/* 本処理 2/3: 在庫行は残し、order_id と settled_at だけ外す。 */
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
)
UPDATE inbound_items ii
SET
  order_id = NULL,
  settled_at = NULL
WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT order_id FROM target_orders);
