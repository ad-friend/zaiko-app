# sales_transactions の idempotency_key バージョン（`SALES_TX_IDEM_VERSION`）

`lib/sales-transaction-idempotency.ts` の `SALES_TX_IDEM_VERSION` は、`idempotency_key` の SHA256 入力の先頭フィールドである。取込の正規化ルール（canonical）・区切り・金額丸め・`posted_date` の秒切り捨て・`dedupe_slot` の扱いなどを変えた場合は、**バージョン文字列を変えて既存行と新規行のキー空間を分ける**か、**全行を同じルールでバックフィルする**かのどちらかが必要になる。

## 推奨手順（バージョンを上げる）

1. アプリの `SALES_TX_IDEM_VERSION` を新値（例: `stx_idem_v2`）に変更する。
2. 本番 DB でバックアップを取る。
3. 既存行のキーを再計算する:
   - **アプリと同一ロジック**: `npm run backfill:sales-idem -- --apply`（`scripts/backfill-sales-transactions-canonical.ts`）。`--dry-run` で件数確認。
   - **SQL のみ**: `docs/migration_sales_transactions_idempotency_key.sql` の `UPDATE` を、digest 内のリテラルを新バージョンに差し替えたマイグレーションとして実行する（`dedupe_slot` 等の式は `computeSalesTransactionIdempotencyKey` と一致させること）。
4. 同一 `idempotency_key` が複数行に付いた場合は、**小さい `id` を残し他を `DELETE`** する（マイグレーション SQL に例あり）。

## バージョンを上げずに canonical だけ直す場合

キー計算に使う列の意味が変わらない（前後で同じキーになる）ならバージョン据え置きでよい。空白 trim などでキーが変わる行だけが対象になるため、`backfill` スクリプトの dry-run で差分を確認する。

## 参照

- `docs/migration_sales_transactions_idempotency_key.sql`
- `docs/health_sales_transactions_duplicate_risk.sql`
