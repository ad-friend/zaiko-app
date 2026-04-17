-- sales_transactions に社内メモ（手動処理の追記用）
-- Supabase SQL エディタで実行

ALTER TABLE sales_transactions
  ADD COLUMN IF NOT EXISTS internal_note TEXT;

COMMENT ON COLUMN sales_transactions.internal_note IS
  '手動財務処理などの社内メモ（JANや関連注文番号の追記など）。売上明細の会計値は変更しない。';
