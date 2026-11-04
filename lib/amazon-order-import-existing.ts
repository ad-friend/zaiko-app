import type { SupabaseClient } from "@supabase/supabase-js";

const ORDER_ID_CHUNK = 80;
const PAGE_SIZE = 1000;

export type ExistingAmazonOrderRow = {
  id: number | string;
  amazon_order_id: string;
  sku: string;
  line_index?: number | null;
  reconciliation_status?: string | null;
};

function lineIndexOf(row: { line_index?: number | null }): number {
  const n = Number(row.line_index);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 注文IDを小分けにし、1000行で切れないよう続きを読む。
 * 1件でも読めなければ例外にし、呼び出し側は挿入しない。
 */
export async function fetchExistingAmazonOrders(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<ExistingAmazonOrderRow[]> {
  const ids = [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))];
  const rows: ExistingAmazonOrderRow[] = [];
  for (const orderChunk of chunk(ids, ORDER_ID_CHUNK)) {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("amazon_orders")
        .select("id, amazon_order_id, sku, line_index, reconciliation_status")
        .in("amazon_order_id", orderChunk)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        throw new Error(`既存の注文明細を読み取れませんでした: ${error.message}`);
      }
      const batch = (data ?? []) as ExistingAmazonOrderRow[];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }
  return rows;
}

/** CSVで残す行以外の、同じ注文番号+SKUの明細 id */
export function siblingIdsToDelete(
  existing: ExistingAmazonOrderRow[],
  kept: Array<{ amazon_order_id: string; sku: string; line_index?: number | null }>
): Array<number | string> {
  const keptLine = new Set(
    kept.map((r) => `${String(r.amazon_order_id).trim()}\t${String(r.sku).trim()}\t${lineIndexOf(r)}`)
  );
  const touched = new Set(kept.map((r) => `${String(r.amazon_order_id).trim()}\t${String(r.sku).trim()}`));
  const ids: Array<number | string> = [];
  for (const row of existing) {
    const skuKey = `${String(row.amazon_order_id).trim()}\t${String(row.sku).trim()}`;
    if (!touched.has(skuKey)) continue;
    const full = `${skuKey}\t${lineIndexOf(row)}`;
    if (!keptLine.has(full)) ids.push(row.id);
  }
  return ids;
}
