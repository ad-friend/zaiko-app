-- 2026-11-26 相談-13：入庫待ちに「未着」（注文したがまだ届いていない）を足す。
-- 仕入れ専用の店（ピーサイドキック・藝夢堂・WD・SanDisk）の注文から PC が作る。届くまで登録できない（アプリの /api/inbound で止める）。
-- 変えるのは status の CHECK と、未着の登録を止める見張り（トリガー）1つだけ。表・列・既存の関数・ほかの行は変えない。何度流しても同じ結果になる。

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.inbound_pending'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%単価待ち%' AND pg_get_constraintdef(oid) NOT LIKE '%registered_header_id%'
  LOOP
    EXECUTE format('ALTER TABLE public.inbound_pending DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.inbound_pending
  ADD CONSTRAINT inbound_pending_status_check
  CHECK (status IN ('未着', '単価待ち', '出品待ち', 'そろった（入庫待ち）', '登録済み'));

-- 未着の行は、どの道からも登録できないようにする（登録の関数が registered_header_id を入れるときに止める。Codex 11/26）
CREATE OR REPLACE FUNCTION public.inbound_pending_block_mitchaku()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = '未着' AND NEW.registered_header_id IS NOT NULL THEN
    RAISE EXCEPTION 'まだ届いていない注文（未着）は登録できません。';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_inbound_pending_block_mitchaku ON public.inbound_pending;
CREATE TRIGGER trg_inbound_pending_block_mitchaku
  BEFORE UPDATE ON public.inbound_pending
  FOR EACH ROW EXECUTE FUNCTION public.inbound_pending_block_mitchaku();

-- 確かめ（1行出れば OK。'未着' が入っていること）
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.inbound_pending'::regclass AND conname = 'inbound_pending_status_check';

-- 戻すとき（未着の行がないことを確かめてから）：
-- DROP TRIGGER IF EXISTS trg_inbound_pending_block_mitchaku ON public.inbound_pending;
-- DROP FUNCTION IF EXISTS public.inbound_pending_block_mitchaku();
-- DELETE FROM public.inbound_pending WHERE status = '未着' AND registered_header_id IS NULL;
-- ALTER TABLE public.inbound_pending DROP CONSTRAINT inbound_pending_status_check;
-- ALTER TABLE public.inbound_pending ADD CONSTRAINT inbound_pending_status_check
--   CHECK (status IN ('単価待ち', '出品待ち', 'そろった（入庫待ち）', '登録済み'));
