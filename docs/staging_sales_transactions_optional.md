# ステージングテーブル（任意）

大量 CSV の検証や、本番 `sales_transactions` に触れる前の突合を行う場合のみ、`sales_transactions` と同型（または必要列のみ）の **`sales_transactions_staging`** を別テーブルで用意する運用が取りうる。

アプリ本体の取込 API は staging を使わない。採用する場合は、staging への `COPY` / 検証 SQL → 問題なければ本番へ `INSERT ... ON CONFLICT` またはバッチ移行、の手順を Runbook に明記する。
