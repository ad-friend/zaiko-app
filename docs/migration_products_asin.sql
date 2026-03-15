-- 商品マスタをASIN・JANの辞書として活用するため、ASINカラムを追加
-- 実行: Supabase SQLエディタで実行してください。

ALTER TABLE products ADD COLUMN IF NOT EXISTS asin TEXT;
CREATE INDEX IF NOT EXISTS idx_products_asin ON products (asin) WHERE asin IS NOT NULL;
COMMENT ON COLUMN products.asin IS 'Amazon ASIN（JANと1:1の辞書として消込検索で利用）';
