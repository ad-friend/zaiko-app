This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Vercel Cron（`/api/cron/run`）

すべて **`Authorization: Bearer ${CRON_SECRET}`** ヘッダーが必須です（環境変数 `CRON_SECRET`）。

| jobKey | 用途 | 推奨頻度の目安 |
|--------|------|----------------|
| `orders_poll` | 直近10分の注文取得 | 高頻度（例: 毎分） |
| `finances_poll` | 東京「昨日」分の財務イベントをチャンク取得（`cron_continuation_state` で続き管理） | 例: 5分毎 |
| `listing_report_poll` | 出品詳細レポートの作成→ポーリング→DLを1ステップずつ | 例: 5〜10分毎 |
| `reconcile_poll` | 自動消込（1リクエストあたり最大12ラウンド） | 任意（例: 15分毎） |
| `finances_daily` | 前日分のダッシュボード通知5件の集計。`&reconcile=1` で日次消込（最大28ラウンド） | 1日1回 |

例（本番ホストに合わせて置き換え）:

- `GET https://<your-app>.vercel.app/api/cron/run?jobKey=orders_poll`
- `GET https://<your-app>.vercel.app/api/cron/run?jobKey=finances_poll`
- `GET https://<your-app>.vercel.app/api/cron/run?jobKey=listing_report_poll`
- `GET https://<your-app>.vercel.app/api/cron/run?jobKey=reconcile_poll`
- `GET https://<your-app>.vercel.app/api/cron/run?jobKey=finances_daily&reconcile=1`

DB: 分割実行には Supabase で [`docs/migration_cron_continuation_state.sql`](docs/migration_cron_continuation_state.sql) を実行してください。

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
