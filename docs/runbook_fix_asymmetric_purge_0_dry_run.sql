-- DRY RUN のみ。件数確認用（変更なし）
-- 対象: 残存注文のうち、未紐付売上がある注文

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
SELECT
  (SELECT COUNT(*) FROM target_orders) AS target_unique_orders,
  (SELECT COUNT(*) FROM sales_transactions st
    WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
  ) AS sales_rows_for_target_orders,
  (SELECT COUNT(*) FROM sales_transactions st
    WHERE NULLIF(BTRIM(st.amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders)
      AND st.stock_id IS NOT NULL
  ) AS sales_rows_still_linked,
  (SELECT COUNT(*) FROM inbound_items ii
    WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders)
  ) AS inbound_rows_with_order_id,
  (SELECT COUNT(*) FROM inbound_items ii
    WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders)
      AND ii.settled_at IS NOT NULL
  ) AS inbound_rows_with_settled_at;
