/**
 * 財務取込パイプラインの配線スモーク（DB・SP-API 不要）。
 * CI またはデプロイ前に: node scripts/check-finance-pipeline.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function mustInclude(rel, needles, label) {
  const s = read(rel);
  for (const n of needles) {
    if (!s.includes(n)) {
      console.error(`[check-finance-pipeline] FAIL ${label}: missing "${n}" in ${rel}`);
      process.exit(1);
    }
  }
}

mustInclude(
  "lib/amazon-financial-events.ts",
  [
    "upsertSalesTransactionRows",
    "flattenAdjustmentEvents",
    "adj_event",
    "item_quantity: 1",
    "finance_line_group_id: null",
    "needs_quantity_review: false",
    "onConflict: \"idempotency_key\"",
  ],
  "amazon-financial-events"
);

mustInclude("app/api/amazon/fetch-finances/route.ts", ["upsertSalesTransactionRows"], "fetch-finances");

mustInclude("app/api/amazon-sales-import/route.ts", ["onConflict: \"idempotency_key\""], "amazon-sales-import");

mustInclude(
  "app/api/amazon-sales-import/preview/route.ts",
  ["buildAmazonSalesCsvImportFromBody", "findSuspiciousBusinessKeyCollisions"],
  "amazon-sales-import-preview"
);

mustInclude(
  "app/api/amazon/pending-finances/route.ts",
  ["finance_line_group_id", "needs_quantity_review"],
  "pending-finances"
);

mustInclude(
  "app/api/amazon/manual-finance-adjustment-settle/route.ts",
  ["allocations", "salesTransactionId", "stockId"],
  "manual-finance-adjustment-settle"
);

mustInclude("components/ManualFinanceProcessModal.tsx", ["allocations", "manual-finance-adjustment-settle"], "ManualFinanceProcessModal");

console.log("[check-finance-pipeline] OK");
