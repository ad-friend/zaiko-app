-- =====================================================
-- Supabase SQLエディタで実行するテーブル作成SQL
-- 在庫管理アプリ用（入荷データ保存）
-- =====================================================

-- 入荷ヘッダー（1件の入荷伝票）
CREATE TABLE inbound_headers (
  id BIGSERIAL PRIMARY KEY,
  purchase_date DATE NOT NULL,
  supplier TEXT,
  genre TEXT,
  total_purchase_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 入荷明細（商品行：JANコード・商品名・価格・数量分の行・状態・登録日時）
CREATE TABLE inbound_items (
  id BIGSERIAL PRIMARY KEY,
  header_id BIGINT NOT NULL REFERENCES inbound_headers(id) ON DELETE CASCADE,
  jan_code TEXT,
  brand TEXT,
  product_name TEXT,
  model_number TEXT,
  condition_type TEXT,
  base_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_fixed_price BOOLEAN NOT NULL DEFAULT false,
  effective_unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inbound_items_header_id ON inbound_items(header_id);

-- Row Level Security（RLS）を有効化し、anonキーでAPIから挿入・参照できるようにする
ALTER TABLE inbound_headers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon all on inbound_headers"
  ON inbound_headers FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Allow anon all on inbound_items"
  ON inbound_items FOR ALL
  USING (true) WITH CHECK (true);
