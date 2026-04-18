-- sales_transactions: 重複・疑わしいパターンのヘルスチェック（必要時に Supabase SQL で実行）
-- 定期ジョブにはしない想定。運用判断・リリース前・データ移行後などに都度実行。

-- 1) 同一 idempotency_key が複数行（一意制約違反のはずなので通常は 0 件）
SELECT idempotency_key, COUNT(*) AS cnt, MIN(id) AS min_id, MAX(id) AS max_id
FROM sales_transactions
GROUP BY idempotency_key
HAVING COUNT(*) > 1
ORDER BY cnt DESC;

-- 2) 同一 amazon_order_id + 秒までの posted_date + amount + amount_description + transaction_type で idempotency_key が複数
--    （SKU 差・dedupe_slot・旧キーなどで「同じビジネス指紋」が分裂している疑い）
SELECT
  trim(coalesce(amazon_order_id, '')) AS amazon_order_id,
  to_char(date_trunc('second', posted_date AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS') AS posted_second_utc,
  round(amount::numeric, 2) AS amount_2dp,
  trim(coalesce(amount_description, '')) AS amount_description,
  trim(transaction_type) AS transaction_type,
  COUNT(DISTINCT idempotency_key) AS distinct_idem_keys,
  COUNT(*) AS row_count,
  array_agg(DISTINCT trim(coalesce(sku, ''))) AS skus
FROM sales_transactions
WHERE trim(coalesce(amazon_order_id, '')) <> ''
GROUP BY 1, 2, 3, 4, 5
HAVING COUNT(DISTINCT idempotency_key) > 1
ORDER BY row_count DESC
LIMIT 200;

-- 3) 同一 amazon_event_hash が複数行（CSV/API の設計上は通常 1 行想定。手修正や旧ロジックの名残の調査用）
SELECT amazon_event_hash, COUNT(*) AS cnt
FROM sales_transactions
GROUP BY amazon_event_hash
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 100;
