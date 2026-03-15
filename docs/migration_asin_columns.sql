-- JAN主軸の汎用在庫管理への移行: ASINカラム追加
-- 実行: Supabase SQLエディタで実行してください。
-- ※ 入庫API・注文取得APIの改修を利用する前に本マイグレーションを実行してください。

-- 1. inbound_items: JANと紐付いたAmazon ASINを保存（入庫時にCatalog APIで取得）
ALTER TABLE inbound_items ADD COLUMN IF NOT EXISTS asin TEXT;
COMMENT ON COLUMN inbound_items.asin IS 'Amazon Catalog APIでJANから取得したASIN（楽天等追加時は別カラムでplatform別IDを管理）';

-- 2. amazon_orders: 注文明細のASINを生データのまま保存（JAN変換は行わない）
ALTER TABLE amazon_orders ADD COLUMN IF NOT EXISTS asin TEXT;
COMMENT ON COLUMN amazon_orders.asin IS 'Amazon注文明細のASIN（生データ）。消込は注文asinと在庫asinの一致で行う';
