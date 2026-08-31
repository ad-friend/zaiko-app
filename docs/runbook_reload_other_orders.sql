/* =============================================================================
   他販路: other_orders 全件リセットして CSV 再取込 — 実行手順

   このファイルは実行しない。下の 0〜3 を 1 ファイルずつ、.sql を開いて全文コピーする。
   チャットやプレビューから貼るとコメントの -- が - になり syntax error になる。

   0) docs/runbook_reload_other_orders_0_dry_run.sql
   1) docs/runbook_reload_other_orders_1_delete_sales.sql
   2) docs/runbook_reload_other_orders_2_reset_inbound.sql
   3) docs/runbook_reload_other_orders_3_delete_orders.sql

   その後アプリ: 金額を直した CSV をアップロード → 在庫引当 → 売上本消込

   対象: other_orders の order_id のうち、amazon_orders に無く
         Amazon 注文番号形式 (000-0000000-0000000) でもないもの
   ============================================================================= */
