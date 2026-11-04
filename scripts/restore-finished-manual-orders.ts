/**
 * 在庫の本消込と売上消込が済んでいるのに manual_required の注文を洗い出す。
 * 既定は読み取りのみ。--apply で reconciliation_status を reconciled に戻す。
 *
 *   npx tsx scripts/restore-finished-manual-orders.ts
 *   npx tsx scripts/restore-finished-manual-orders.ts --apply
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  isStockAndSalesAlreadyFinished,
  requiredSettledRootCount,
} from "../lib/amazon-order-reconciliation-status";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

type OrderRow = {
  id: string;
  amazon_order_id: string;
  sku: string;
  quantity: number;
  reconciliation_status: string;
  updated_at: string;
};

type SalesRow = { amazon_order_id: string; status: string | null };

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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchManualOrders(supabase: SupabaseClient): Promise<OrderRow[]> {
  const pageSize = 1000;
  const rows: OrderRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, quantity, reconciliation_status, updated_at")
      .eq("reconciliation_status", "manual_required")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as OrderRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchOrderLines(supabase: SupabaseClient, orderIds: string[]): Promise<OrderRow[]> {
  const rows: OrderRow[] = [];
  for (const ids of chunk(orderIds, 80)) {
    const { data, error } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, quantity, reconciliation_status, updated_at")
      .in("amazon_order_id", ids);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as OrderRow[]));
  }
  return rows;
}

async function fetchSettledRoots(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Array<{ order_id: string }>> {
  const rows: Array<{ order_id: string }> = [];
  for (const ids of chunk(orderIds, 80)) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("inbound_items")
        .select("order_id")
        .in("order_id", ids)
        .not("settled_at", "is", null)
        .is("parent_item_id", null)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as Array<{ order_id: string }>;
      rows.push(...batch);
      if (batch.length < 1000) break;
      from += 1000;
    }
  }
  return rows;
}

async function fetchSales(supabase: SupabaseClient, orderIds: string[]): Promise<SalesRow[]> {
  const rows: SalesRow[] = [];
  for (const ids of chunk(orderIds, 80)) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("sales_transactions")
        .select("amazon_order_id, status")
        .in("amazon_order_id", ids)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as SalesRow[];
      rows.push(...batch);
      if (batch.length < 1000) break;
      from += 1000;
    }
  }
  return rows;
}

async function fetchMappings(
  supabase: SupabaseClient,
  skus: string[]
): Promise<Array<{ sku: string; quantity: number }>> {
  const rows: Array<{ sku: string; quantity: number }> = [];
  for (const ids of chunk(skus, 80)) {
    const { data, error } = await supabase
      .from("sku_mappings")
      .select("sku, quantity")
      .eq("platform", "Amazon")
      .in("sku", ids);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Array<{ sku: string; quantity: number }>));
  }
  return rows;
}

async function main() {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase の接続情報がありません。");
  const supabase = createClient(url, key);

  const manual = await fetchManualOrders(supabase);
  const orderIds = [...new Set(manual.map((row) => row.amazon_order_id))];
  const skus = [...new Set(manual.map((row) => String(row.sku ?? "").trim()).filter(Boolean))];
  const [lines, settled, sales, mappings] = await Promise.all([
    fetchOrderLines(supabase, orderIds),
    fetchSettledRoots(supabase, orderIds),
    fetchSales(supabase, orderIds),
    fetchMappings(supabase, skus),
  ]);

  const linesByOrder = new Map<string, OrderRow[]>();
  for (const line of lines) {
    const list = linesByOrder.get(line.amazon_order_id) ?? [];
    list.push(line);
    linesByOrder.set(line.amazon_order_id, list);
  }
  const settledCount = new Map<string, number>();
  for (const row of settled) {
    settledCount.set(row.order_id, (settledCount.get(row.order_id) ?? 0) + 1);
  }
  const salesByOrder = new Map<string, Array<string | null>>();
  for (const row of sales) {
    const list = salesByOrder.get(row.amazon_order_id) ?? [];
    list.push(row.status);
    salesByOrder.set(row.amazon_order_id, list);
  }

  const restoreIds: string[] = [];
  const reasons = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const note = (reason: string, orderId: string) => {
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const list = examples.get(reason) ?? [];
    if (list.length < 5) list.push(orderId);
    examples.set(reason, list);
  };

  for (const orderId of orderIds) {
    const orderLines = linesByOrder.get(orderId) ?? [];
    const need = requiredSettledRootCount(orderLines, mappings);
    const linked = settledCount.get(orderId) ?? 0;
    const statuses = salesByOrder.get(orderId) ?? [];
    if (!isStockAndSalesAlreadyFinished(linked, need, statuses)) {
      note(linked < need ? "stock_short" : statuses.length === 0 ? "no_sales" : "sales_open", orderId);
      continue;
    }
    note("restore", orderId);
    for (const line of orderLines) {
      if (line.reconciliation_status === "manual_required") restoreIds.push(line.id);
    }
  }

  const target = "250-6450642-2028661";
  const targetLines = linesByOrder.get(target) ?? manual.filter((row) => row.amazon_order_id === target);
  console.log(
    JSON.stringify(
      {
        manual_rows: manual.length,
        manual_orders: orderIds.length,
        reasons: Object.fromEntries(reasons),
        examples: Object.fromEntries(examples),
        restore_rows: restoreIds.length,
        target: {
          lines: targetLines,
          settled: settledCount.get(target) ?? 0,
          sales: salesByOrder.get(target) ?? [],
          will_restore: targetLines.some((line) => restoreIds.includes(line.id)),
        },
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log("dry-run");
    return;
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const ids of chunk(restoreIds, 100)) {
    const { data, error } = await supabase
      .from("amazon_orders")
      .update({ reconciliation_status: "reconciled", updated_at: nowIso })
      .in("id", ids)
      .eq("reconciliation_status", "manual_required")
      .select("id");
    if (error) throw new Error(error.message);
    updated += data?.length ?? 0;
  }
  console.log(JSON.stringify({ updated }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
