-- other_orders: RLS ポリシー追加（CSV取込で 42501 が出たとき用）
-- Supabase ダッシュボード → SQL Editor で実行
--
-- エラー例:
--   new row violates row-level security policy for table "other_orders"
--   DBコード: 42501

ALTER TABLE other_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon all on other_orders" ON other_orders;
CREATE POLICY "Allow anon all on other_orders"
  ON other_orders FOR ALL
  USING (true) WITH CHECK (true);
