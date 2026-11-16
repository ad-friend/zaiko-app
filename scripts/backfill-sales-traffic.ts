import { runSalesTrafficPoll } from "../lib/sales-traffic-sync";
// .env類を読まない。実行時の環境変数を窓口が設定する。反映了承後の初回手動実行専用。
async function main() {
  try {
    const result = await runSalesTrafficPoll(true);
    console.log(result.summary);
    if (result.metrics.pending) process.exitCode = 2; // 保存済みstateを次回呼出し／朝cronで再開
  } catch { console.error("売上トラフィックのバックフィルに失敗しました"); process.exitCode = 1; }
}
void main();
