# sales_transactions: バックフィル（idem 揃え）とヘルス SQL

本番の「キー揃え」と「疑いがあるときだけの検査」の手順です。定期実行は不要とする前提です。

---

## 1. バックフィル（`npm run backfill:sales-idem`）

`transaction_type` / `amount_type` / `amount_description` を canonical（NFKC trim・空説明は null）に揃え、`idempotency_key` を `lib/sales-transaction-idempotency.ts` の現在ロジックで再計算します。

### 事前準備

- 作業端末にリポジトリを clone / pull 済みであること。
- プロジェクトルートに `.env.local` があり、少なくとも次が入っていること。
  - `NEXT_PUBLIC_SUPABASE_URL`
  - **`SUPABASE_SERVICE_ROLE_KEY`（推奨）** … RLS を避けて更新・削除できるようにするため。
  - サービスロールが使えない場合のみ `NEXT_PUBLIC_SUPABASE_ANON_KEY`（RLS 次第で失敗しうる）。

### 手順（必ず dry-run → apply）

1. **メンテ時間の確保**（大量行なら数分かかることがあります）。
2. **Supabase でバックアップ**（ポイントインタイム復旧可能ならその旨をメモ）。
3. リポジトリルートで依存関係を入れた状態で実行:

   ```bash
   npm install
   npm run backfill:sales-idem
   ```

   - これは **dry-run（既定）** です。DB は変更しません。
   - ログ末尾の `would_change=N` が **更新対象件数** の目安です。

4. **結果の判断**
   - `would_change=0` … 揃える必要なし。このまま終了でよいです。
   - `would_change>0` … 内容を確認したうえで apply へ。

5. **本番反映（問題なければ）**

   ```bash
   npm run backfill:sales-idem -- --apply
   ```

   - キー衝突時は **小さい `id` の行を残し**、重複側を削除してから更新する実装です（`scripts/backfill-sales-transactions-canonical.ts`）。
   - 大量データ向けにバッチサイズを変える場合:

   ```bash
   npm run backfill:sales-idem -- --apply --batch=800
   ```

6. **完了確認**
   - ログの `updated=` / `deleted_self=` を確認。
   - 必要なら下記「ヘルス SQL」のクエリ 1 を流し、`idempotency_key` 重複が 0 件であることを確認。

### 失敗したとき

- 認証・権限エラー: `.env.local` の URL / キー、特に **service_role** を確認。
- 想定外に `deleted_self` が多い: 事前に `docs/health_sales_transactions_duplicate_risk.sql` のクエリ 2 で疑わしい分裂がないか確認してから、改めて dry-run を取る。

### 関連ドキュメント

- バージョン文字列を変える場合: [sales_transactions_idempotency_versioning.md](./sales_transactions_idempotency_versioning.md)
- SQL のみで一括再キーする場合: [migration_sales_transactions_idempotency_key.sql](./migration_sales_transactions_idempotency_key.sql)（digest 内のバージョンリテラルとアプリを一致させること）
- 売上全削除と在庫の unsettle 例（コメントのみ・実行は手動編集後）: [runbook_sales_transactions_full_reset.sql](./runbook_sales_transactions_full_reset.sql)

---

## 2. ヘルス SQL（都度のみ）

ファイル: [health_sales_transactions_duplicate_risk.sql](./health_sales_transactions_duplicate_risk.sql)

### いつ流すか

- **移行直後**（idem 追加・バックフィル直後など）
- **データがおかしい疑いがあるとき**（二重計上・消込ずれの調査）
- **定期ジョブにはしない**方針でよい場合は、上記に限る

### 手順

1. Supabase の **SQL Editor** を開く。
2. `docs/health_sales_transactions_duplicate_risk.sql` の内容を貼り付け、**クエリごとに**実行する（またはコメントで区切って必要なブロックだけ実行）。
3. 結果の見方（概要）:
   - **クエリ 1**: 同一 `idempotency_key` が複数行 → 本来 0 件（一意制約があるため通常は出ないが、制約前データの名残の調査用）。
   - **クエリ 2**: 同一ビジネス指紋なのに `idempotency_key` が複数 → SKU 差・旧キー・取込経路差などの調査用。
   - **クエリ 3**: 同一 `amazon_event_hash` が複数行 → 手修正・旧ロジックの調査用。

4. 問題行があれば、原因調査のあと **正ソース方針**（[sales_transactions_source_policy.md](./sales_transactions_source_policy.md)）に沿って修正・再取込・バックフィルを検討する。

---

## 3. CSV チャンクの事前確認（任意）

DB に触れずに取込結果だけ見る場合:

- `POST /api/amazon-sales-import/preview`（ボディは本番取込 `POST /api/amazon-sales-import` と同じ）
- レスポンスの `suspicious_business_key_collisions` と `row_errors` を確認する。
