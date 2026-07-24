-- 本処理 3/3: 注文削除
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
DELETE FROM amazon_orders ao
WHERE ao.created_at >= (SELECT ts FROM cutoff)
  AND NULLIF(BTRIM(ao.amazon_order_id), '') IS NOT NULL
  AND ao.amazon_order_id IN (SELECT amazon_order_id FROM target_orders);
