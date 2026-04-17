-- inbound_items.order_id の空文字を NULL に正規化する
-- 目的: 未割当の表現を NULL に寄せ、検索漏れ/分岐漏れを減らす
-- 実行: Supabase SQL エディタで1回だけ実行（必要なら事前にバックアップ）

BEGIN;

-- 空文字そのもの
UPDATE inbound_items
SET order_id = NULL
WHERE order_id = '';

-- 目に見えない空白だけのケース（念のため）
UPDATE inbound_items
SET order_id = NULL
WHERE order_id IS NOT NULL
  AND btrim(order_id) = '';

COMMIT;

