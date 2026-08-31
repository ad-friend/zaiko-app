/* 本処理 3/3: other_orders 削除。Amazon 形式の注文番号の行は残す。 */
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
DELETE FROM other_orders oo
WHERE NULLIF(BTRIM(oo.order_id), '') IN (SELECT order_id FROM target_orders);
