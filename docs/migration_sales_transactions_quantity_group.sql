-- sales_transactions: 補填の数量・グループ化・要確認フラグ
-- Supabase SQL エディタで実行してください。

ALTER TABLE sales_transactions
  ADD COLUMN IF NOT EXISTS item_quantity INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS finance_line_group_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS needs_quantity_review BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN sales_transactions.item_quantity IS '明細あたりの数量（分割後は通常1）';
COMMENT ON COLUMN sales_transactions.finance_line_group_id IS '同一補填アイテム由来の複数行を pending でまとめるキー';
COMMENT ON COLUMN sales_transactions.needs_quantity_review IS 'Amazon の Quantity・単価・合計が「確実」条件を満たさないとき true（要確認アラート）';

CREATE INDEX IF NOT EXISTS idx_sales_transactions_finance_line_group_id
  ON sales_transactions (finance_line_group_id)
  WHERE finance_line_group_id IS NOT NULL;
