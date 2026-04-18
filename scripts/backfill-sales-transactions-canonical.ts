/**
 * sales_transactions の transaction_type / amount_type / amount_description を
 * canonicalizeAmazonFinancialApiRow で揃え、idempotency_key を再計算する。
 *
 * 使い方（プロジェクトルート）:
 *   npx tsx scripts/backfill-sales-transactions-canonical.ts           # dry-run（既定）
 *   npx tsx scripts/backfill-sales-transactions-canonical.ts --apply  # 反映
 *
 * 環境変数: .env.local を読む（NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 推奨）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canonicalizeAmazonFinancialApiRow } from "../lib/canonical-sales-transaction";
import { computeSalesTransactionIdempotencyKey } from "../lib/sales-transaction-idempotency";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

type Row = {
  id: number;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: string | number;
  posted_date: string;
  dedupe_slot: number | null;
  idempotency_key: string;
};

function loadEnvLocal(): void {
  const p = path.join(root, ".env.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv: string[]): { apply: boolean; batch: number } {
  let apply = false;
  let batch = 400;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    const m = /^--batch=(\d+)$/.exec(a);
    if (m) batch = Math.max(1, Math.min(5000, parseInt(m[1], 10)));
  }
  return { apply, batch };
}

function rowNeedsUpdate(row: Row): { newKey: string; canon: ReturnType<typeof canonicalizeAmazonFinancialApiRow> } | null {
  const canon = canonicalizeAmazonFinancialApiRow({
    transaction_type: row.transaction_type,
    amount_type: row.amount_type,
    amount_description: row.amount_description,
  });
  const dedupe_slot = Math.max(0, Math.floor(Number(row.dedupe_slot) || 0));
  const newKey = computeSalesTransactionIdempotencyKey({
    amazon_order_id: row.amazon_order_id,
    sku: row.sku,
    transaction_type: canon.transaction_type,
    amount_type: canon.amount_type,
    amount_description: canon.amount_description,
    amount: Number(row.amount),
    posted_date: row.posted_date,
    dedupe_slot,
  });
  const descEq = (row.amount_description ?? null) === (canon.amount_description ?? null);
  const same =
    row.idempotency_key === newKey &&
    row.transaction_type === canon.transaction_type &&
    row.amount_type === canon.amount_type &&
    descEq;
  if (same) return null;
  return { newKey, canon };
}

async function processOne(supabase: SupabaseClient, row: Row, apply: boolean): Promise<"skip" | "dry_hit" | "updated" | "deleted_self"> {
  const plan = rowNeedsUpdate(row);
  if (!plan) return "skip";
  const { newKey, canon } = plan;

  if (!apply) return "dry_hit";

  const { data: hit, error: selErr } = await supabase
    .from("sales_transactions")
    .select("id")
    .eq("idempotency_key", newKey)
    .neq("id", row.id)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;

  const otherId = hit && typeof (hit as { id?: unknown }).id === "number" ? (hit as { id: number }).id : null;
  if (otherId != null) {
    if (otherId < row.id) {
      const { error: delErr } = await supabase.from("sales_transactions").delete().eq("id", row.id);
      if (delErr) throw delErr;
      return "deleted_self";
    }
    const { error: delO } = await supabase.from("sales_transactions").delete().eq("id", otherId);
    if (delO) throw delO;
  }

  const { error: updErr } = await supabase
    .from("sales_transactions")
    .update({
      transaction_type: canon.transaction_type,
      amount_type: canon.amount_type,
      amount_description: canon.amount_description,
      idempotency_key: newKey,
    })
    .eq("id", row.id);
  if (updErr) throw updErr;
  return "updated";
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { apply, batch } = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY（または ANON）を設定してください。");
    process.exit(1);
  }

  const supabase = createClient(url, key);
  let lastId = 0;
  let scanned = 0;
  let wouldChange = 0;
  let updated = 0;
  let deletedSelf = 0;

  console.log(`[backfill-sales-transactions-canonical] apply=${apply} batch=${batch}`);

  for (;;) {
    const { data, error } = await supabase
      .from("sales_transactions")
      .select(
        "id, amazon_order_id, sku, transaction_type, amount_type, amount_description, amount, posted_date, dedupe_slot, idempotency_key"
      )
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(batch);

    if (error) throw error;
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const r = await processOne(supabase, row, apply);
      if (r === "dry_hit") wouldChange += 1;
      if (r === "updated") updated += 1;
      if (r === "deleted_self") deletedSelf += 1;
    }

    lastId = rows[rows.length - 1]!.id;
    if (rows.length < batch) break;
  }

  console.log(
    `[backfill-sales-transactions-canonical] done scanned=${scanned} ${apply ? `updated=${updated} deleted_self=${deletedSelf}` : `would_change=${wouldChange}`}`
  );
  if (!apply && wouldChange > 0) {
    console.log("反映するには: npx tsx scripts/backfill-sales-transactions-canonical.ts --apply");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
