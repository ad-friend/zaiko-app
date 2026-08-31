-- 本処理 2/2: 対象注文の在庫は行を残し、settled_at だけ NULL
-- order_id は残す（STEP2の引当を維持 → 本消込だけで再結合）

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
UPDATE inbound_items ii
SET settled_at = NULL
WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders);
