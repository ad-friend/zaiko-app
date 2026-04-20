-- 返金（Refund）ワープ処理：在庫戻し + 財務消込を原子化（不足時は全ロールバック）
--
-- 使い方（Supabase SQL Editor で実行）:
-- 1) docs/migration_sales_transactions_status.sql を先に適用（status 列が無い場合）
-- 2) この関数を作成
--
-- 要件（最終仕様）:
-- - refund_qty はバックエンド（pending-finances）が正。ここでは再計算しない（p_refund_qty を使用）。
-- - toRelease が p_refund_qty 未満の場合は、在庫も財務も一切更新せず例外で中断（ロールバック）。
-- - new/used/junk の内訳は created_at DESC NULLS LAST, id DESC の順で先頭から割り当て。
-- - ブロック条件:
--   - NULLIF(BTRIM(order_id), '') IS NULL（フリー/空文字含む）
--   - return_amazon_order_id IS NOT NULL（返品メタあり）
--   - stock_status in ('return_inspection','disposed')
--   - exit_type = 'junk_return'
-- - 抽出時は NULLIF(BTRIM(order_id), '') IS NOT NULL（正しく order_id が入っているもの）に限定。
-- - 更新:
--   - 解除: order_id=NULL, settled_at=NULL
--   - return メタ: return_amazon_order_id=NULL, amazon_return_received_at=NULL, exit_type は new/used で NULL、junk で 'junk_return'
--   - new/used: stock_status='available', condition_type='new'|'used'
--   - junk: stock_status='disposed'

create or replace function public.manual_finance_refund_release(
  p_sales_transaction_ids bigint[],
  p_amazon_order_id text,
  p_refund_qty integer,
  p_disp_new integer,
  p_disp_used integer,
  p_disp_junk integer
)
returns table (
  updated_sales_tx_count integer,
  updated_inbound_count integer,
  updated_inbound_new integer,
  updated_inbound_used integer,
  updated_inbound_junk integer,
  skipped_total integer,
  skipped_already_free integer,
  skipped_return_flagged integer,
  refund_qty integer,
  order_id_used text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_refund_qty integer := greatest(coalesce(p_refund_qty, 0), 0);
  v_new integer := greatest(coalesce(p_disp_new, 0), 0);
  v_used integer := greatest(coalesce(p_disp_used, 0), 0);
  v_junk integer := greatest(coalesce(p_disp_junk, 0), 0);
  v_order_id text := nullif(btrim(coalesce(p_amazon_order_id, '')), '');
  v_available_count integer := 0;
  v_skip_free integer := 0;
  v_skip_flagged integer := 0;
begin
  if p_sales_transaction_ids is null or array_length(p_sales_transaction_ids, 1) is null or array_length(p_sales_transaction_ids, 1) = 0 then
    raise exception 'salesTransactionIds を1件以上指定してください。';
  end if;

  if v_refund_qty <= 0 then
    raise exception 'p_refund_qty は 1 以上である必要があります（refund_qty=0 はRPCを呼ばずに財務のみ消込してください）。';
  end if;

  if (v_new + v_used + v_junk) <> v_refund_qty then
    raise exception '内訳数量の合計が返金数量と一致しません（返金数: %, 合計: %）。', v_refund_qty, (v_new + v_used + v_junk);
  end if;

  with tx as (
    select
      id,
      nullif(btrim(amazon_order_id), '') as amazon_order_id,
      stock_id::bigint as stock_id
    from sales_transactions
    where id = any(p_sales_transaction_ids)
  ),
  tx_order as (
    select
      case
        when v_order_id is not null then v_order_id
        when (select count(distinct amazon_order_id) from tx where amazon_order_id is not null) = 1
          then (select min(amazon_order_id) from tx where amazon_order_id is not null)
        else null
      end as order_id_used
  ),
  cand_ids as (
    select distinct stock_id as inbound_item_id
    from tx
    where stock_id is not null and stock_id >= 1
    union
    select distinct ii.id as inbound_item_id
    from inbound_items ii
    join tx_order o on o.order_id_used is not null
    where nullif(btrim(ii.order_id), '') = o.order_id_used
  ),
  cand as (
    select
      ii.id,
      ii.created_at,
      nullif(btrim(ii.order_id), '') as order_id_norm,
      ii.return_amazon_order_id,
      ii.stock_status,
      ii.exit_type
    from inbound_items ii
    join cand_ids c on c.inbound_item_id = ii.id
  ),
  blocked as (
    select
      id,
      order_id_norm,
      return_amazon_order_id,
      stock_status,
      exit_type
    from cand
    where
      order_id_norm is null
      or nullif(btrim(return_amazon_order_id), '') is not null
      or lower(coalesce(stock_status, '')) in ('return_inspection', 'disposed')
      or lower(coalesce(exit_type, '')) = 'junk_return'
  ),
  eligible as (
    select
      c.id,
      c.created_at
    from cand c
    left join blocked b on b.id = c.id
    where b.id is null
      and c.order_id_norm is not null
  ),
  to_release as (
    select e.id
    from eligible e
    order by e.created_at desc nulls last, e.id desc
    limit v_refund_qty
  )
  select
    (select count(*) from eligible),
    (select count(*) from blocked where order_id_norm is null),
    (select count(*) from blocked) - (select count(*) from blocked where order_id_norm is null)
  into v_available_count, v_skip_free, v_skip_flagged;

  if v_available_count < v_refund_qty then
    raise exception '在庫データが不足しています（返金数: %, 処理可能在庫: %）。データのズレや二重処理の可能性があるため、在庫状況を確認してください。', v_refund_qty, v_available_count;
  end if;

  -- 配列化（割当のため）
  with tx as (
    select
      id,
      nullif(btrim(amazon_order_id), '') as amazon_order_id,
      stock_id::bigint as stock_id
    from sales_transactions
    where id = any(p_sales_transaction_ids)
  ),
  tx_order as (
    select
      case
        when v_order_id is not null then v_order_id
        when (select count(distinct amazon_order_id) from tx where amazon_order_id is not null) = 1
          then (select min(amazon_order_id) from tx where amazon_order_id is not null)
        else null
      end as order_id_used
  ),
  cand_ids as (
    select distinct stock_id as inbound_item_id
    from tx
    where stock_id is not null and stock_id >= 1
    union
    select distinct ii.id as inbound_item_id
    from inbound_items ii
    join tx_order o on o.order_id_used is not null
    where nullif(btrim(ii.order_id), '') = o.order_id_used
  ),
  cand as (
    select
      ii.id,
      ii.created_at,
      nullif(btrim(ii.order_id), '') as order_id_norm,
      ii.return_amazon_order_id,
      ii.stock_status,
      ii.exit_type
    from inbound_items ii
    join cand_ids c on c.inbound_item_id = ii.id
  ),
  blocked as (
    select id
    from cand
    where
      order_id_norm is null
      or nullif(btrim(return_amazon_order_id), '') is not null
      or lower(coalesce(stock_status, '')) in ('return_inspection', 'disposed')
      or lower(coalesce(exit_type, '')) = 'junk_return'
  ),
  eligible as (
    select
      c.id,
      c.created_at
    from cand c
    left join blocked b on b.id = c.id
    where b.id is null
      and c.order_id_norm is not null
  ),
  to_release as (
    select e.id,
      row_number() over (order by e.created_at desc nulls last, e.id desc) as rn
    from eligible e
    limit v_refund_qty
  ),
  ids_new as (
    select id from to_release where rn <= v_new
  ),
  ids_used as (
    select id from to_release where rn > v_new and rn <= (v_new + v_used)
  ),
  ids_junk as (
    select id from to_release where rn > (v_new + v_used)
  ),
  upd_new as (
    update inbound_items ii
    set
      order_id = null,
      settled_at = null,
      stock_status = 'available',
      condition_type = 'new',
      exit_type = null,
      return_amazon_order_id = null,
      amazon_return_received_at = null
    where ii.id in (select id from ids_new)
    returning ii.id
  ),
  upd_used as (
    update inbound_items ii
    set
      order_id = null,
      settled_at = null,
      stock_status = 'available',
      condition_type = 'used',
      exit_type = null,
      return_amazon_order_id = null,
      amazon_return_received_at = null
    where ii.id in (select id from ids_used)
    returning ii.id
  ),
  upd_junk as (
    update inbound_items ii
    set
      order_id = null,
      settled_at = null,
      stock_status = 'disposed',
      exit_type = 'junk_return',
      return_amazon_order_id = null,
      amazon_return_received_at = null
    where ii.id in (select id from ids_junk)
    returning ii.id
  ),
  upd_sales as (
    update sales_transactions st
    set status = 'reconciled'
    where st.id = any(p_sales_transaction_ids)
    returning st.id
  )
  select
    (select count(*) from upd_sales),
    (select count(*) from upd_new) + (select count(*) from upd_used) + (select count(*) from upd_junk),
    (select count(*) from upd_new),
    (select count(*) from upd_used),
    (select count(*) from upd_junk),
    (v_skip_free + v_skip_flagged),
    v_skip_free,
    v_skip_flagged,
    v_refund_qty,
    (select order_id_used from tx_order)
  into
    updated_sales_tx_count,
    updated_inbound_count,
    updated_inbound_new,
    updated_inbound_used,
    updated_inbound_junk,
    skipped_total,
    skipped_already_free,
    skipped_return_flagged,
    refund_qty,
    order_id_used;

  return;
end;
$$;

