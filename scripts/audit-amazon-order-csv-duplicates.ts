/**
 * 2026-07-24 以降に、注文CSVが既存明細へ line_index 0 を重ねた疑いを洗い出す。
 * 既定は読み取りのみ。--apply で重複行の削除と、必要数を超える在庫紐付けの解除を行う。
 *
 *   npx tsx scripts/audit-amazon-order-csv-duplicates.ts
 *   npx tsx scripts/audit-amazon-order-csv-duplicates.ts --apply
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const CUTOFF_MS = Date.parse("2026-07-24T00:00:00+09:00");
const STALE_GAP_MS = 60 * 60 * 1000;

type OrderRow = {
  id: number | string;
  amazon_order_id: string;
  sku: string;
  line_index: number;
  quantity: number;
  reconciliation_status: string;
  jan_code: string | null;
  created_at: string;
  updated_at: string;
};

type InboundRow = {
  id: number | string;
  order_id: string;
  jan_code: string | null;
  settled_at: string | null;
  created_at: string | null;
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ms(iso: string | null | undefined): number {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function skuKey(orderId: string, sku: string): string {
  return `${orderId}\t${sku}`;
}

async function fetchAllOrders(supabase: SupabaseClient): Promise<OrderRow[]> {
  const pageSize = 1000;
  const rows: OrderRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, line_index, quantity, reconciliation_status, jan_code, created_at, updated_at")
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

/** 同じ注文+SKUで line_index 0 とそれ以外の更新時刻が1時間以上ずれ、新しい方が7月24日以降 */
export function isCsvOverlayGroup(rows: OrderRow[]): boolean {
  if (rows.length < 2) return false;
  const line0 = rows.filter((r) => Number(r.line_index) === 0);
  const others = rows.filter((r) => Number(r.line_index) !== 0);
  if (line0.length === 0 || others.length === 0) return false;
  const line0At = Math.max(...line0.map((r) => ms(r.updated_at)));
  const othersAt = Math.max(...others.map((r) => ms(r.updated_at)));
  if (Math.abs(line0At - othersAt) < STALE_GAP_MS) return false;
  return Math.max(line0At, othersAt) >= CUTOFF_MS;
}

/** 後から足された line_index 0 は捨て、既存行を更新しただけならその行を残す */
export function keptRows(rows: OrderRow[]): OrderRow[] {
  const line0 = rows.filter((r) => Number(r.line_index) === 0);
  const others = rows.filter((r) => Number(r.line_index) !== 0);
  const line0At = Math.max(...line0.map((r) => ms(r.updated_at)));
  const othersAt = Math.max(...others.map((r) => ms(r.updated_at)));
  const line0Ids = line0.map((r) => Number(r.id));
  const otherIds = others.map((r) => Number(r.id));
  const idsNumeric = line0Ids.every(Number.isFinite) && otherIds.every(Number.isFinite);
  const line0IsNewerInsert =
    idsNumeric && line0.length === 1 && line0Ids[0] > Math.max(...otherIds) && line0At >= othersAt;
  if (line0At + STALE_GAP_MS <= othersAt || line0IsNewerInsert) return others;
  return [line0.slice().sort((a, b) => ms(b.updated_at) - ms(a.updated_at))[0]];
}

async function main() {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY（または ANON）を設定してください。");
    process.exit(1);
  }
  const supabase = createClient(url, key);
  const orders = await fetchAllOrders(supabase);
  const groups = new Map<string, OrderRow[]>();
  for (const row of orders) {
    const key = skuKey(String(row.amazon_order_id), String(row.sku));
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const multi = [...groups.values()].filter((g) => g.length > 1);
  const overlays = multi.filter(isCsvOverlayGroup);

  const { data: notices, error: noticeErr } = await supabase
    .from("dashboard_notices")
    .select("id, payload, created_at")
    .eq("notice_type", "amazon_order_import_duplicate_lines")
    .gte("created_at", "2026-07-23T15:00:00.000Z")
    .order("created_at", { ascending: true });
  if (noticeErr) console.error("notices:", noticeErr.message);

  const dropIds = new Set<string>();
  const affectedOrders = new Set<string>();
  const overlaySkusByOrder = new Map<string, Set<string>>();
  for (const group of overlays) {
    const keep = keptRows(group);
    const keepIds = new Set(keep.map((r) => String(r.id)));
    for (const row of group) {
      if (!keepIds.has(String(row.id))) dropIds.add(String(row.id));
    }
    const orderId = String(group[0].amazon_order_id);
    affectedOrders.add(orderId);
    const skus = overlaySkusByOrder.get(orderId) ?? new Set<string>();
    skus.add(String(group[0].sku));
    overlaySkusByOrder.set(orderId, skus);
  }

  const orderIds = [...affectedOrders];
  const inbound: InboundRow[] = [];
  for (const ids of chunk(orderIds, 50)) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("inbound_items")
        .select("id, order_id, jan_code, settled_at, created_at")
        .in("order_id", ids)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as InboundRow[];
      inbound.push(...batch);
      if (batch.length < 1000) break;
      from += 1000;
    }
  }
  const inboundByOrder = new Map<string, InboundRow[]>();
  for (const row of inbound) {
    const list = inboundByOrder.get(String(row.order_id)) ?? [];
    list.push(row);
    inboundByOrder.set(String(row.order_id), list);
  }

  const skuList = [
    ...new Set(
      orders.filter((r) => affectedOrders.has(String(r.amazon_order_id))).map((r) => String(r.sku))
    ),
  ];
  const mappingQty = new Map<string, Array<{ jan_code: string; quantity: number }>>();
  for (const skus of chunk(skuList, 80)) {
    if (!skus.length) break;
    const { data, error } = await supabase
      .from("sku_mappings")
      .select("sku, jan_code, quantity")
      .eq("platform", "Amazon")
      .in("sku", skus);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const sku = String((row as { sku: string }).sku);
      const list = mappingQty.get(sku) ?? [];
      list.push({
        jan_code: String((row as { jan_code: string }).jan_code ?? "").trim(),
        quantity: Math.max(1, Number((row as { quantity?: number }).quantity) || 1),
      });
      mappingQty.set(sku, list);
    }
  }

  function jansFor(row: OrderRow): Array<{ jan_code: string; quantity: number }> {
    const maps = mappingQty.get(String(row.sku));
    const qty = Math.max(1, Number(row.quantity) || 1);
    if (maps?.length) {
      return maps.filter((m) => m.jan_code).map((m) => ({ jan_code: m.jan_code, quantity: m.quantity * qty }));
    }
    const jan = String(row.jan_code ?? "").trim();
    return jan ? [{ jan_code: jan, quantity: qty }] : [];
  }

  const unlinkIds: Array<number | string> = [];
  const samples: unknown[] = [];
  for (const orderId of orderIds) {
    const remaining = orders.filter(
      (r) => String(r.amazon_order_id) === orderId && !dropIds.has(String(r.id))
    );
    const overlaySkus = overlaySkusByOrder.get(orderId) ?? new Set<string>();
    const overlayJans = new Set<string>();
    for (const row of orders) {
      if (String(row.amazon_order_id) !== orderId || !overlaySkus.has(String(row.sku))) continue;
      for (const part of jansFor(row)) overlayJans.add(part.jan_code);
    }
    const needByJan = new Map<string, number>();
    for (const row of remaining) {
      for (const part of jansFor(row)) {
        needByJan.set(part.jan_code, (needByJan.get(part.jan_code) ?? 0) + part.quantity);
      }
    }
    const linked = (inboundByOrder.get(orderId) ?? []).slice();
    const extra: InboundRow[] = [];
    for (const jan of overlayJans) {
      const items = linked
        .filter((r) => String(r.jan_code ?? "").trim() === jan)
        .sort((a, b) => ms(a.created_at) - ms(b.created_at) || Number(a.id) - Number(b.id));
      const need = needByJan.get(jan) ?? 0;
      if (items.length > need) extra.push(...items.slice(need));
    }
    unlinkIds.push(...extra.map((r) => r.id));
    if (samples.length < 20) {
      const groupRows = orders.filter(
        (r) => String(r.amazon_order_id) === orderId && overlaySkus.has(String(r.sku))
      );
      samples.push({
        amazon_order_id: orderId,
        rows: groupRows.map((r) => ({
          id: r.id,
          sku: r.sku,
          line_index: r.line_index,
          quantity: r.quantity,
          status: r.reconciliation_status,
          updated_at: r.updated_at,
          drop: dropIds.has(String(r.id)),
        })),
        linked: linked.length,
        unlink: extra.map((r) => ({ id: r.id, jan_code: r.jan_code, settled_at: r.settled_at })),
      });
    }
  }

  const noticeSummary = (notices ?? []).map((n) => {
    const p = (n as { payload?: { duplicate_lines_merged?: number; amazon_order_id_count?: number } }).payload ?? {};
    return {
      created_at: (n as { created_at: string }).created_at,
      duplicate_lines_merged: p.duplicate_lines_merged ?? null,
      amazon_order_id_count: p.amazon_order_id_count ?? null,
    };
  });

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        orders_scanned: orders.length,
        multi_sku_groups: multi.length,
        csv_overlay_groups: overlays.length,
        legitimate_multi_left_alone: multi.length - overlays.length,
        order_rows_to_delete: dropIds.size,
        inbound_to_unlink: unlinkIds.length,
        duplicate_line_notices_since_july24: noticeSummary,
        samples,
      },
      null,
      2
    )
  );

  if (!apply) return;

  for (const ids of chunk([...dropIds], 100)) {
    const { error } = await supabase.from("amazon_orders").delete().in("id", ids);
    if (error) throw new Error(`delete orders: ${error.message}`);
  }
  for (const ids of chunk(unlinkIds, 100)) {
    const { error } = await supabase
      .from("inbound_items")
      .update({ order_id: null, settled_at: null })
      .in("id", ids);
    if (error) throw new Error(`unlink inbound: ${error.message}`);
  }
  console.log(
    JSON.stringify({ applied: true, deleted_order_rows: dropIds.size, unlinked_inbound: unlinkIds.length })
  );
}

const isDirect = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/audit-amazon-order-csv-duplicates.ts");
if (isDirect) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
