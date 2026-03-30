-- sales_transactions に「処理済み除外」用 status を追加（任意）
-- 経費（PostageBilling / ServiceFee 等）を reconcile-sales で自動パスしたとき、
-- pending-finances（未処理一覧）に出さないためのフラグとして使用します。

ALTER TABLE sales_transactions
  ADD COLUMN IF NOT EXISTS status TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_transactions_status ON sales_transactions (status);

-- 例: 経費を除外済みにしたい場合
-- UPDATE sales_transactions SET status='reconciled'
-- WHERE stock_id IS NULL AND (amount_type ILIKE '%PostageBilling%' OR amount_type ILIKE '%ServiceFee%');

