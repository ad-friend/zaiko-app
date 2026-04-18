# sales_transactions の正ソースと二重取込

## 正ソース（canonical）

- **Amazon 売上（本テーブルの主用途）**: Finances API（`listFinancialEvents`）のイベント展開結果を正とする。`transaction_type` / `amount_type` / `amount_description` / `amount` / `posted_date` は、アプリ側の **canonical**（`lib/canonical-sales-transaction.ts` と `upsertSalesTransactionRows` 通過後）で揃えたうえで `idempotency_key` を計算する。
- **CSV 取込**: 日付範囲別トランザクションレポート等は **残す**（運用・差分確認・API 未取得期間の補完）。列名ゆらぎは `lib/amazon-sales-csv-type-normalize.ts` → `lib/amazon-sales-import-engine.ts` で API 寄せの語彙に正規化する。DB に載せる `amount_description` は注文行の標準内訳について API と同じ表記にし、`idempotency_key` と整合させる（プレフィックスは非標準行のみ）。

## 二重取込の扱い

- **同一財務明細**は `idempotency_key` の一意 upsert で上書き・集約される。`amazon_event_hash` は行の出自・CSV マージ用であり、一意制約には使わない。
- **API と CSVの両方**から同じ明細が入る可能性がある場合、canonical と idem 入力が一致していれば **1 行に収束**する。表記がずれると別キーになり二重になるため、`docs/health_sales_transactions_duplicate_risk.sql` で疑わしい行を検出する。

## その他チャネル

- **other_orders / 手動チャネル**は別テーブル運用。`sales_transactions` に載せる場合は `amazon_event_hash`・`idempotency_key` の設計をその取込経路のドキュメントに従う（例: `app/api/other-sales-import`）。

## プレビュー

- CSV チャンクを DB に触れず検証する: `POST /api/amazon-sales-import/preview`（本番取込と同じ JSON ボディ）。
- 応答の `suspicious_business_key_collisions`・`row_errors`・**`skipped_rows`**（行単位。`code` 例: `UNKNOWN_FINANCIAL_PATTERN` / `NO_EXTRACTABLE_AMOUNTS` / `INVALID_ROW_OBJECT` 等）を確認する。

## チャンク内スキップ

- パース不能・日付不正・**注文付きで調整コードを特定できない行**などはスキップし、**同一チャンクの他行は従来どおり upsert** する。
- 本番 `POST /api/amazon-sales-import` もプレビューも、JSON に `skipped_rows`（最大 100 件）と互換用の `row_errors`（最大 50 件）を返す。
