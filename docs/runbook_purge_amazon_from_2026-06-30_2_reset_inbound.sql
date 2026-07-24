-- 本処理 2/3: 在庫セルのみリセット（行は削除しない）
WITH cutoff AS (
  SELECT TIMESTAMPTZ '2026-06-30 00:00:00+09' AS ts
),
target_orders AS (
  SELECT DISTINCT ao.amazon_order_id
  FROM amazon_orders ao
  CROSS JOIN cutoff c
  WHERE ao.created_at >= c.ts
    AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
)
UPDATE inbound_items ii
SET
  order_id = NULL,
  settled_at = NULL,
  stock_status = NULL,
  return_amazon_order_id = NULL,
  amazon_return_received_at = NULL,
  exit_type = NULL
WHERE NULLIF(BTRIM(ii.order_id), '') IN (SELECT amazon_order_id FROM target_orders)
   OR NULLIF(BTRIM(ii.return_amazon_order_id), '') IN (SELECT amazon_order_id FROM target_orders);
