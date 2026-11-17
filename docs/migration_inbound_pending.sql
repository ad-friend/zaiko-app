-- 相談-13 段階1：入庫待ちリスト（納品書1枚＝1伝票）と、入庫待ちからの登録を1回の処理で行う関数
-- Supabase の SQL Editor で、このファイルを上から全部1回実行する。
--
-- 守ること
-- - 入庫待ち（inbound_pending）は RLS 有効・anon への方針なし。読み書きはサーバー側の service role だけ
--   （sales_traffic_daily などと同じ形）。
-- - 在庫の表（inbound_headers・inbound_items・products）に書くのは register_pending_inbound だけで、
--   人が入庫画面の登録ボタンを押したときに /api/inbound から呼ばれる。
--   （docs/rpc_manual_finance_refund_release.sql と同じ SECURITY DEFINER 関数の形）
-- - 今までの手入力の登録（pendingId なし）は何も変わらない。
--
-- 止めるとき（データは残す）：一番下の「止める」を見る。
-- 全体を1つのトランザクションで実行する。途中で失敗したら何も変わらない。

BEGIN;

-- 0. 前提の確認（足りなければここで止まり、何も変わらない）
DO $$
DECLARE
  v_missing text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (i.indkey)
    WHERE n.nspname = 'public' AND t.relname = 'products' AND a.attname = 'jan_code'
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 1 AND i.indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'products.jan_code に（条件なしの）一意の制約がありません。ここで止めます（何も変えていません）。';
  END IF;
  SELECT string_agg(need.t || '.' || need.c, '、') INTO v_missing
  FROM (VALUES
    ('products','jan_code'),('products','brand'),('products','product_name'),('products','model_number'),('products','asin'),
    ('suppliers','kana'),
    ('inbound_headers','id'),('inbound_headers','purchase_date'),('inbound_headers','supplier'),('inbound_headers','genre'),
    ('inbound_headers','total_purchase_amount'),('inbound_headers','shipping_cost'),('inbound_headers','discount_amount'),('inbound_headers','total_cost'),
    ('inbound_items','header_id'),('inbound_items','jan_code'),('inbound_items','asin'),('inbound_items','brand'),('inbound_items','product_name'),
    ('inbound_items','model_number'),('inbound_items','condition_type'),('inbound_items','base_price'),('inbound_items','is_fixed_price'),
    ('inbound_items','effective_unit_price'),('inbound_items','registered_at'),('inbound_items','item_kind'),('inbound_items','part_code')
  ) AS need(t, c)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns ic
    WHERE ic.table_schema = 'public' AND ic.table_name = need.t AND ic.column_name = need.c
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '次の列がありません：%。ここで止めます（何も変えていません）。', v_missing;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='inbound_headers' AND column_name='id') <> 'bigint' THEN
    RAISE EXCEPTION 'inbound_headers.id が bigint ではありません。ここで止めます（何も変えていません）。';
  END IF;
END $$;

-- 1. 入庫待ち
CREATE TABLE IF NOT EXISTS public.inbound_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_hash text NOT NULL,
  source_page integer NOT NULL CHECK (source_page > 0),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  supplier_key text,
  document_number text,
  order_number text,
  purchase_date date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT '単価待ち'
    CHECK (status IN ('単価待ち','出品待ち','そろった（入庫待ち）','登録済み')),
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_required boolean NOT NULL DEFAULT false,
  duplicate_cleared_at timestamptz, -- 人が「別の伝票です」と確かめた時刻（取込み直しても消さない）
  duplicate_cleared_key jsonb,      -- そのとき人が見た [仕入先, 注文番号, 伝票番号]。番号が変われば確かめ直す
  registered_header_id bigint UNIQUE REFERENCES public.inbound_headers(id),
  registered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_hash, source_page),
  CHECK ((status = '登録済み') = (registered_header_id IS NOT NULL)),
  CHECK ((registered_header_id IS NULL) = (registered_at IS NULL))
);
COMMENT ON TABLE public.inbound_pending IS '相談-13：入庫待ち（納品書1枚＝1伝票）。AIの取込は /api/inbound-pending（専用の合い言葉）だけ。在庫の表ではない';

CREATE INDEX IF NOT EXISTS inbound_pending_order_candidate
  ON public.inbound_pending (supplier_key, order_number);
CREATE INDEX IF NOT EXISTS inbound_pending_document_candidate
  ON public.inbound_pending (supplier_key, document_number);
CREATE INDEX IF NOT EXISTS inbound_pending_open
  ON public.inbound_pending (created_at) WHERE registered_header_id IS NULL;

ALTER TABLE public.inbound_pending ENABLE ROW LEVEL SECURITY;
-- anon / authenticated への方針は置かない（読み書きは service role だけ）。

-- 1b. 取込（AI・PC）：書き込みと重複の確認を1回の処理で行う。
--     同じ仕入先の取込・「別の伝票です」は順番に1件ずつ処理する（同時に来ても古い確認結果で上書きしない）。
--     重複の疑い＝同じ仕入先で、注文番号か伝票番号のどちらかが同じ別の書類がある（登録済みも含む。日付は見ない）。
--     分納（1注文に納品書が2枚）は本当に別の伝票なので、止めて人が「別の伝票です」で外す。
--     SECURITY INVOKER：service role（RLS を通らない）で呼ぶ。anon で呼んでも RLS で書けない。
CREATE OR REPLACE FUNCTION public.import_inbound_pending(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  c_dup constant text := '重複の疑い（同じ仕入先で注文番号か伝票番号が同じ書類が別にある）';
  v_hash text := lower(btrim(coalesce(p->>'sourceHash', '')));
  v_page integer := coalesce(nullif(p->>'sourcePage', '')::integer, 1);
  v_supplier text := nullif(btrim(coalesce(p->>'supplierKey', '')), '');
  v_order text := nullif(btrim(coalesce(p->>'orderNumber', '')), '');
  v_doc text := nullif(btrim(coalesce(p->>'documentNumber', '')), '');
  v_key jsonb;
  v_row public.inbound_pending%ROWTYPE;
  v_exists boolean;
  v_dup boolean := false;
  v_review boolean := coalesce((p->>'reviewRequired')::boolean, false);
  v_blockers jsonb;
  v_id uuid;
BEGIN
  IF v_hash !~ '^[0-9a-f]{64}$' OR v_page < 1 THEN
    RAISE EXCEPTION '書類の番号（sourceHash・sourcePage）が正しくありません。';
  END IF;
  v_key := jsonb_build_array(v_supplier, v_order, v_doc);

  -- 同じ仕入先（仕入先が分からなければ同じ書類）の処理を順番にする。トランザクションの終わりまで持つ
  PERFORM pg_advisory_xact_lock(hashtext('inbound_pending:' || coalesce(v_supplier, v_hash)));

  SELECT * INTO v_row FROM public.inbound_pending
  WHERE source_hash = v_hash AND source_page = v_page
  FOR UPDATE;
  v_exists := FOUND;

  IF v_exists AND v_row.registered_header_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'registered', true, 'id', v_row.id, 'headerId', v_row.registered_header_id);
  END IF;

  IF v_supplier IS NOT NULL AND (v_order IS NOT NULL OR v_doc IS NOT NULL) THEN
    SELECT EXISTS (
      SELECT 1 FROM public.inbound_pending o
      WHERE o.supplier_key = v_supplier
        AND (NOT v_exists OR o.id <> v_row.id)
        AND ((v_order IS NOT NULL AND o.order_number = v_order) OR (v_doc IS NOT NULL AND o.document_number = v_doc))
    ) INTO v_dup;
  END IF;

  -- 人が同じ番号の組み合わせで「別の伝票です」と確かめていれば、止めない
  IF v_exists AND v_row.duplicate_cleared_key IS NOT DISTINCT FROM v_key AND v_row.duplicate_cleared_at IS NOT NULL THEN
    v_dup := false;
    v_review := false;
  END IF;

  SELECT coalesce(jsonb_agg(b), '[]'::jsonb) INTO v_blockers
  FROM jsonb_array_elements(coalesce(p->'blockers', '[]'::jsonb)) b
  WHERE b #>> '{}' <> c_dup;
  IF v_dup THEN
    v_review := true;
    v_blockers := v_blockers || to_jsonb(c_dup);
  END IF;

  IF v_exists THEN
    UPDATE public.inbound_pending SET
      source_refs = coalesce(p->'sourceRefs', '[]'::jsonb),
      supplier_key = v_supplier,
      document_number = v_doc,
      order_number = v_order,
      purchase_date = nullif(p->>'purchaseDate', '')::date,
      payload = coalesce(p->'payload', '{}'::jsonb),
      status = p->>'status',
      blockers = v_blockers,
      review_required = v_review,
      updated_at = now()
    WHERE id = v_row.id;
    v_id := v_row.id;
  ELSE
    INSERT INTO public.inbound_pending (
      source_hash, source_page, source_refs, supplier_key, document_number, order_number, purchase_date,
      payload, status, blockers, review_required
    ) VALUES (
      v_hash, v_page, coalesce(p->'sourceRefs', '[]'::jsonb), v_supplier, v_doc, v_order,
      nullif(p->>'purchaseDate', '')::date, coalesce(p->'payload', '{}'::jsonb), p->>'status', v_blockers, v_review
    )
    RETURNING id INTO v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'created', NOT v_exists, 'reviewRequired', v_review);
END;
$$;

-- 1c. 人が「別の伝票です」と確かめたとき（取込と同じ順番待ちに入る）
--     p_expected：人が画面で見た {supplierKey, orderNumber, documentNumber}。
--     行を押さえたあとで今の番号と同じときだけ外す。違えば conflict を返す（画面で読み直して確かめ直す）。
CREATE OR REPLACE FUNCTION public.clear_inbound_pending_duplicate(p_id uuid, p_expected jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_lock text;
  v_row public.inbound_pending%ROWTYPE;
  v_seen jsonb;
BEGIN
  IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
    RAISE EXCEPTION '画面で見た番号（p_expected）がありません。';
  END IF;
  v_seen := jsonb_build_array(
    nullif(btrim(coalesce(p_expected->>'supplierKey', '')), ''),
    nullif(btrim(coalesce(p_expected->>'orderNumber', '')), ''),
    nullif(btrim(coalesce(p_expected->>'documentNumber', '')), ''));

  SELECT coalesce(supplier_key, source_hash) INTO v_lock FROM public.inbound_pending WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'notFound', true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inbound_pending:' || v_lock));
  SELECT * INTO v_row FROM public.inbound_pending WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'notFound', true);
  END IF;
  IF v_row.registered_header_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'registered', true);
  END IF;
  -- 人が見た番号と今の番号が違えば外さない
  IF jsonb_build_array(v_row.supplier_key, v_row.order_number, v_row.document_number) IS DISTINCT FROM v_seen THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true);
  END IF;
  UPDATE public.inbound_pending SET
    review_required = false,
    blockers = (SELECT coalesce(jsonb_agg(b), '[]'::jsonb) FROM jsonb_array_elements(v_row.blockers) b
                WHERE (b #>> '{}') NOT LIKE '重複の疑い%'),
    duplicate_cleared_at = now(),
    duplicate_cleared_key = v_seen,
    updated_at = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- service role が使う権限（Supabase では既定で付いているが、念のため明示する。role がない環境では飛ばす）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.inbound_pending TO service_role;
    GRANT EXECUTE ON FUNCTION public.import_inbound_pending(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.clear_inbound_pending_duplicate(uuid, jsonb) TO service_role;
  END IF;
END $$;

-- 2. 入庫伝票に「どの書類から来たか」を残す列（手入力の伝票は空のまま）
ALTER TABLE public.inbound_headers ADD COLUMN IF NOT EXISTS order_number text;
ALTER TABLE public.inbound_headers ADD COLUMN IF NOT EXISTS source_reference jsonb;
ALTER TABLE public.inbound_headers ADD COLUMN IF NOT EXISTS pending_id uuid REFERENCES public.inbound_pending(id);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_headers_pending_once
  ON public.inbound_headers (pending_id) WHERE pending_id IS NOT NULL;

-- 3. 入庫待ちからの登録（伝票・明細・商品マスター・登録済みの印を1回で。どこかで失敗したら全部戻る）
--    p_header：purchaseDate, supplier, genre, totalPurchase, shipping, discount, totalCost, orderNumber
--    p_items ：数量分に展開済みの行（今の /api/inbound の items と同じ形）
CREATE OR REPLACE FUNCTION public.register_pending_inbound(
  p_pending_id uuid,
  p_header jsonb,
  p_items jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pending public.inbound_pending%ROWTYPE;
  v_header_id bigint;
  v_supplier text := btrim(coalesce(p_header->>'supplier', ''));
  v_now timestamptz := now();
  v_total numeric;
  v_shipping numeric;
  v_discount numeric;
  v_total_cost numeric;
  v_sum_effective numeric;
  v_sum_base numeric;
  v_has_distribute boolean;
  v_count integer;
BEGIN
  IF p_pending_id IS NULL THEN
    RAISE EXCEPTION '入庫待ちの番号がありません。';
  END IF;

  SELECT * INTO v_pending FROM public.inbound_pending WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '入庫待ちが見つかりません。';
  END IF;

  -- 登録済みなら、もう一度登録せず同じ伝票番号を返す（二度押し・再送でも増えない）
  IF v_pending.registered_header_id IS NOT NULL THEN
    RETURN v_pending.registered_header_id;
  END IF;

  IF v_pending.review_required THEN
    RAISE EXCEPTION 'この入庫待ちは重複の疑いがあり、確認が済むまで登録できません。';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION '商品が1つもありません。';
  END IF;
  IF nullif(p_header->>'purchaseDate', '') IS NULL THEN
    RAISE EXCEPTION '仕入日がありません。';
  END IF;
  IF v_supplier = '' OR NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.kana = v_supplier) THEN
    RAISE EXCEPTION '仕入先「%」が仕入先マスターにありません。', v_supplier;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
    WHERE coalesce(e->>'itemKind', 'product') <> 'part' AND nullif(btrim(e->>'jan'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'JANのない商品があります。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
    WHERE coalesce(e->>'itemKind', 'product') = 'part' AND nullif(btrim(e->>'partCode'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'パーツコードのない行があります。';
  END IF;

  -- 金額の確認（画面の確認だけに頼らない）。数字でない値はここで型の誤りとして止まる。
  v_total := (p_header->>'totalPurchase')::numeric;
  v_shipping := coalesce(nullif(p_header->>'shipping', '')::numeric, 0);
  v_discount := coalesce(nullif(p_header->>'discount', '')::numeric, 0);
  v_total_cost := (p_header->>'totalCost')::numeric;
  -- 0以上・1兆円未満（NaN・無限大はこの範囲に入らないので弾かれる）
  IF v_total IS NULL OR v_total_cost IS NULL
     OR NOT (v_total >= 0 AND v_total < 1e12) OR NOT (v_shipping >= 0 AND v_shipping < 1e12)
     OR NOT (v_discount >= 0 AND v_discount < 1e12) OR NOT (v_total_cost >= 0 AND v_total_cost < 1e12) THEN
    RAISE EXCEPTION '仕入総額・送料・割引・総コストが正しくありません（0以上の数字）。';
  END IF;
  IF v_total_cost <> v_total + v_shipping - v_discount THEN
    RAISE EXCEPTION '総コストが「仕入総額＋送料−割引」と合いません。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) e
    WHERE (e->>'basePrice') IS NULL OR (e->>'effectiveUnitPrice') IS NULL
       OR NOT ((e->>'basePrice')::numeric > 0 AND (e->>'basePrice')::numeric < 1e12)
       OR NOT ((e->>'effectiveUnitPrice')::numeric > 0 AND (e->>'effectiveUnitPrice')::numeric < 1e12)
  ) THEN
    RAISE EXCEPTION '単価（基準価格）か実効単価が空・0以下の行があります。';
  END IF;
  SELECT count(*), sum((e->>'effectiveUnitPrice')::numeric), sum((e->>'basePrice')::numeric),
         bool_or(coalesce((e->>'fixedUnitPrice')::boolean, false))
    INTO v_count, v_sum_effective, v_sum_base, v_has_distribute
  FROM jsonb_array_elements(p_items) e;
  -- 実効単価の合計＝総コスト（按分のあるなしにかかわらず）。按分なしなら、さらに単価の合計＝仕入総額。
  -- どちらも1行1円までのずれは許す（画面の計算は小数のまま送るため）
  IF abs(v_sum_effective - v_total_cost) > v_count THEN
    RAISE EXCEPTION '実効単価の合計（%）が総コスト（%）と合いません。', round(v_sum_effective), v_total_cost;
  END IF;
  IF NOT v_has_distribute AND abs(v_sum_base - v_total) > v_count THEN
    RAISE EXCEPTION '商品の単価の合計（%）が仕入総額（%）と合いません。', round(v_sum_base), v_total;
  END IF;

  INSERT INTO public.inbound_headers (
    purchase_date, supplier, genre, total_purchase_amount, shipping_cost, discount_amount, total_cost,
    order_number, source_reference, pending_id
  ) VALUES (
    (p_header->>'purchaseDate')::date,
    v_supplier,
    p_header->>'genre',
    v_total,
    v_shipping,
    v_discount,
    v_total_cost,
    coalesce(nullif(btrim(p_header->>'orderNumber'), ''), v_pending.order_number),
    v_pending.source_refs,
    p_pending_id
  )
  RETURNING id INTO v_header_id;

  -- 明細（今の /api/inbound の行の作り方に合わせる）
  INSERT INTO public.inbound_items (
    header_id, jan_code, asin, brand, product_name, model_number, condition_type,
    base_price, is_fixed_price, effective_unit_price, registered_at, item_kind, part_code
  )
  SELECT
    v_header_id,
    CASE WHEN e->>'itemKind' = 'part' THEN nullif(btrim(e->>'jan'), '') ELSE btrim(e->>'jan') END,
    CASE WHEN e->>'itemKind' = 'part' THEN NULL
         WHEN length(btrim(coalesce(e->>'asin', ''))) >= 10 THEN btrim(e->>'asin') END,
    nullif(e->>'brand', ''),
    e->>'productName',
    CASE WHEN e->>'itemKind' = 'part'
         THEN coalesce(nullif(e->>'modelNumber', ''), upper(btrim(e->>'partCode')))
         ELSE e->>'modelNumber' END,
    coalesce(nullif(e->>'condition', ''), CASE WHEN e->>'itemKind' = 'part' THEN 'used' ELSE 'new' END),
    coalesce(nullif(e->>'basePrice', '')::numeric, 0),
    coalesce((e->>'fixedUnitPrice')::boolean, false),
    coalesce(nullif(e->>'effectiveUnitPrice', '')::numeric, 0),
    v_now,
    CASE WHEN e->>'itemKind' = 'part' THEN 'part' ELSE 'product' END,
    CASE WHEN e->>'itemKind' = 'part' THEN upper(btrim(e->>'partCode')) END
  FROM jsonb_array_elements(p_items) e;

  -- 商品マスター（通常商品だけ。ASIN は空で上書きしない）
  INSERT INTO public.products (jan_code, brand, product_name, model_number, asin)
  SELECT DISTINCT ON (btrim(e->>'jan'))
    btrim(e->>'jan'),
    nullif(btrim(coalesce(e->>'brand', '')), ''),
    btrim(e->>'productName'),
    nullif(btrim(coalesce(e->>'modelNumber', '')), ''),
    CASE WHEN length(btrim(coalesce(e->>'asin', ''))) >= 10 THEN btrim(e->>'asin') END
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(e, n)
  WHERE coalesce(e->>'itemKind', 'product') <> 'part'
    AND nullif(btrim(e->>'jan'), '') IS NOT NULL
    AND nullif(btrim(coalesce(e->>'productName', '')), '') IS NOT NULL
  ORDER BY btrim(e->>'jan'), n DESC
  ON CONFLICT (jan_code) DO UPDATE SET
    brand = excluded.brand,
    product_name = excluded.product_name,
    model_number = excluded.model_number,
    asin = coalesce(excluded.asin, public.products.asin);

  UPDATE public.inbound_pending
  SET status = '登録済み', registered_header_id = v_header_id, registered_at = v_now, updated_at = v_now
  WHERE id = p_pending_id;

  RETURN v_header_id;
END;
$$;

COMMENT ON FUNCTION public.register_pending_inbound(uuid, jsonb, jsonb) IS
  '相談-13：入庫待ちから人が登録ボタンで登録する。伝票・明細・商品マスター・登録済みの印を1回の処理で。登録済みなら同じ伝票番号を返す';

COMMIT;

-- =====================================================
-- 確かめる（読むだけ）
-- SELECT count(*) FROM public.inbound_pending;                         -- 0 件のはず
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='inbound_headers' AND column_name IN ('order_number','source_reference','pending_id');
-- SELECT proname FROM pg_proc WHERE proname IN ('register_pending_inbound','import_inbound_pending','clear_inbound_pending_duplicate');  -- 3つ
--
-- =====================================================
-- 止める（データは残す。手入力の登録は今までどおり）
-- 1) 取込を止める：Vercel の環境変数 INBOUND_IMPORT_SECRET を消して再デプロイ（取込は 500 で何もしない）
-- 2) 画面を戻す：在庫アプリを相談-13 の前のコミットに戻して push（一覧・呼び出しが消える）
-- 3) 入庫待ちからの登録を止める：
-- DROP FUNCTION IF EXISTS public.register_pending_inbound(uuid, jsonb, jsonb);
--
-- 完全に戻す（入庫待ちから1件も登録していないときだけ。先に 1)〜3) を済ませ、
-- 入庫待ちの中身を控えてから：SELECT * FROM public.inbound_pending; の結果を CSV で保存）
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.register_pending_inbound(uuid, jsonb, jsonb);
-- DROP FUNCTION IF EXISTS public.import_inbound_pending(jsonb);
-- DROP FUNCTION IF EXISTS public.clear_inbound_pending_duplicate(uuid, jsonb);
-- DROP INDEX IF EXISTS public.inbound_headers_pending_once;
-- ALTER TABLE public.inbound_headers DROP COLUMN IF EXISTS pending_id;
-- ALTER TABLE public.inbound_headers DROP COLUMN IF EXISTS source_reference;
-- ALTER TABLE public.inbound_headers DROP COLUMN IF EXISTS order_number;
-- DROP TABLE IF EXISTS public.inbound_pending;
-- COMMIT;
