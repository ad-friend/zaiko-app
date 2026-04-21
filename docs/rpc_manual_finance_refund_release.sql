-- 返金（Refund）ワープ処理：在庫戻し + 財務消込を原子化（不足時は全ロールバック）
--
-- 使い方（Supabase SQL Editor で実行）:
-- 1) docs/migration_sales_transactions_status.sql を先に適用（status 列が無い場合）
-- 2) この関数を作成（CREATE OR REPLACE）
--
-- 既存仕様（維持）:
-- - Refund ワープは return_inspection に送らず、available / disposed へ直接戻す
-- - 在庫不足時は例外で中断し、在庫も財務も更新しない（ロールバック）
--
-- 追加要件（整合性の完全性）:
-- - amazon_order_id が特定できない場合は例外で中断（ロールバック）
-- - ワープして order_id を外す場合でも、amazon_orders を returned に更新し STEP 3-2 不整合に落ちないようにする
-- - inbound_items の返品メタ（return_amazon_order_id / amazon_return_received_at）を保持（NULL クリアしない）

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
  v_order_id_hint text := nullif(btrim(coalesce(p_amazon_order_id, '')), '');
  v_order_id_used text := null;
  v_cand_ids bigint[] := '{}'::bigint[];
  v_order_inbound_ids bigint[] := '{}'::bigint[];
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

  -- 先に「使用する注文番号」を確定（ヒント優先、sales_transactions から一意に推定）
  if v_order_id_hint is not null then
    v_order_id_used := v_order_id_hint;
  else
    select
      case
        when count(distinct nullif(btrim(amazon_order_id), '')) = 1
          then min(nullif(btrim(amazon_order_id), ''))
        else null
      end
    from sales_transactions
    where id = any(p_sales_transaction_ids)
    into v_order_id_used;
  end if;

  -- 整合性必須：注文番号が特定できない場合は中断（ロールバック）
  if v_order_id_used is null then
    raise exception 'amazon_order_id を特定できません（ヒント未指定、かつ明細内で一意になりません）。処理を中断します。';
  end if;

  -- 候補 inbound_items.id を Union（stock_id 経路 + order_id 逆引き）
  -- ※Supabase環境での解釈揺れ回避のため、PL/pgSQL変数をサブクエリ内で直接参照しない
  select coalesce(array_agg(distinct st.stock_id::bigint), '{}'::bigint[])
  from sales_transactions st
  where st.id = any(p_sales_transaction_ids)
    and st.stock_id is not null
    and st.stock_id::bigint >= 1
  into v_cand_ids;

  -- 動的SQLで v_order_id_used の解釈揺れを完全回避
  execute
    'select coalesce(array_agg(distinct id::bigint), ''{}''::bigint[]) from inbound_items where nullif(btrim(order_id), '''') = $1'
    into v_order_inbound_ids
    using v_order_id_used;

  select coalesce(array_agg(distinct x), '{}'::bigint[])
  from unnest(array_cat(v_cand_ids, v_order_inbound_ids)) as x
  into v_cand_ids;

  -- スキップ集計（free / return-flagged）
  select count(*)
  from inbound_items ii
  where ii.id = any(v_cand_ids)
    and nullif(btrim(ii.order_id), '') is null
  into v_skip_free;

  select count(*)
  from inbound_items ii
  where ii.id = any(v_cand_ids)
    and nullif(btrim(ii.order_id), '') is not null
    and (
      nullif(btrim(ii.return_amazon_order_id), '') is not null
      or lower(coalesce(ii.stock_status, '')) in ('return_inspection', 'disposed')
      or lower(coalesce(ii.exit_type, '')) = 'junk_return'
    )
  into v_skip_flagged;

  -- 処理可能件数（ブロック除外 + order_id が入っている）
  select count(*)
  from inbound_items ii
  where ii.id = any(v_cand_ids)
    and nullif(btrim(ii.order_id), '') is not null
    and nullif(btrim(ii.return_amazon_order_id), '') is null
    and lower(coalesce(ii.stock_status, '')) not in ('return_inspection', 'disposed')
    and lower(coalesce(ii.exit_type, '')) <> 'junk_return'
  into v_available_count;

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
  cand_ids as (
    select distinct stock_id as inbound_item_id
    from tx
    where stock_id is not null and stock_id >= 1
    union
    select distinct ii.id as inbound_item_id
    from inbound_items ii
    where nullif(btrim(ii.order_id), '') = v_order_id_used
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
      return_amazon_order_id = v_order_id_used,
      amazon_return_received_at = coalesce(ii.amazon_return_received_at, now())
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
      return_amazon_order_id = v_order_id_used,
      amazon_return_received_at = coalesce(ii.amazon_return_received_at, now())
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
      return_amazon_order_id = v_order_id_used,
      amazon_return_received_at = coalesce(ii.amazon_return_received_at, now())
    where ii.id in (select id from ids_junk)
    returning ii.id
  ),
  upd_sales as (
    update sales_transactions st
    set status = 'reconciled'
    where st.id = any(p_sales_transaction_ids)
    returning st.id
  ),
  upd_orders as (
    update amazon_orders ao
    set
      reconciliation_status = 'returned',
      updated_at = now()
    where nullif(btrim(ao.amazon_order_id), '') = v_order_id_used
      and lower(coalesce(ao.reconciliation_status, '')) not in ('returned', 'canceled', 'cancelled')
    returning ao.id
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
    v_order_id_used
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

