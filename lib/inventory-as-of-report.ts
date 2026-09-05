/**
 * 指定日 23:59:59（東京）＝翌 0:00 exclusive 時点の棚卸用在庫集計。
 * - 存在: inbound_items.created_at < 翌0:00（月末在庫金額と同じ）
 * - 未決済: settled_at 未設定 or 翌0:00 以降（決済日＝売上確定日のみ）
 * - 廃棄系（exit_type / disposed）は常に除外
 * - パーツ在庫（item_kind=part）も含める。パーツマスタは対象外
 */
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION, isInventoryExitExcluded } from "@/lib/inbound-stock-status";
import { num } from "@/lib/dashboard-aggregates";
import type { InventoryAsOfPayload, InventoryAsOfProductRow } from "@/lib/dashboard-types";

const PAGE = 1000;
const JAN_NONE = "(JANなし)";

const ITEM_SELECT = `
  id,
  order_id,
  settled_at,
  exit_type,
  stock_status,
  registered_at,
  created_at,
  effective_unit_price,
  base_price,
  jan_code,
  brand,
  product_name,
  model_number,
  condition_type,
  item_kind,
  parent_item_id,
  inbound_headers (
    supplier,
    genre
  )
`;

function nonempty(s: string | null | undefined): boolean {
  return s != null && String(s).trim().length > 0;
}

function trimOrNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

function parseYmd(dateYmd: string): { y: number; mo: number; d: number; ymd: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d, ymd: `${m[1]}-${m[2]}-${m[3]}` };
}

/** YYYY-MM-DD → その日 00:00 JST の ISO */
export function asOfStartIsoFromDate(dateYmd: string): string | null {
  const parsed = parseYmd(dateYmd);
  if (!parsed) return null;
  const iso = new Date(`${parsed.ymd}T00:00:00+09:00`).toISOString();
  if (Number.isNaN(Date.parse(iso))) return null;
  return iso;
}

/** YYYY-MM-DD → 翌日 00:00 JST の ISO（指定日 23:59:59 時点の exclusive 境界） */
export function asOfEndExclusiveIsoFromDate(dateYmd: string): string | null {
  const startIso = asOfStartIsoFromDate(dateYmd);
  if (!startIso) return null;
  const start = new Date(startIso);
  const ymdCheck = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(start);
  if (ymdCheck !== dateYmd.trim()) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export function todayYmdTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type UnsettledAsOfItem = {
  id: number;
  order_id: string | null;
  settled_at: string | null;
  registered_at: string | null;
  created_at: string | null;
  effective_unit_price: number | null;
  base_price: number | null;
  jan_code: string | null;
  brand: string | null;
  product_name: string | null;
  model_number: string | null;
  condition_type: string | null;
  item_kind: string | null;
  parent_item_id: number | null;
  supplier: string | null;
  genre: string | null;
};

function headerFromJoin(raw: unknown): { supplier: string | null; genre: string | null } {
  const h = Array.isArray(raw) ? raw[0] : raw;
  if (!h || typeof h !== "object") return { supplier: null, genre: null };
  const rec = h as { supplier?: unknown; genre?: unknown };
  return {
    supplier: rec.supplier != null ? String(rec.supplier) : null,
    genre: rec.genre != null ? String(rec.genre) : null,
  };
}

function mapScanRow(row: Record<string, unknown>): UnsettledAsOfItem {
  const header = headerFromJoin(row.inbound_headers);
  return {
    id: Number(row.id),
    order_id: nonempty(row.order_id as string | null) ? String(row.order_id).trim() : null,
    settled_at: row.settled_at != null ? String(row.settled_at) : null,
    registered_at: row.registered_at != null ? String(row.registered_at) : null,
    created_at: row.created_at != null ? String(row.created_at) : null,
    effective_unit_price: row.effective_unit_price != null ? Number(row.effective_unit_price) : null,
    base_price: row.base_price != null ? Number(row.base_price) : null,
    jan_code: trimOrNull(row.jan_code as string | null),
    brand: trimOrNull(row.brand as string | null),
    product_name: trimOrNull(row.product_name as string | null),
    model_number: trimOrNull(row.model_number as string | null),
    condition_type: trimOrNull(row.condition_type as string | null),
    item_kind: trimOrNull(row.item_kind as string | null) ?? "product",
    parent_item_id: row.parent_item_id != null ? Number(row.parent_item_id) : null,
    supplier: header.supplier,
    genre: header.genre,
  };
}

function isUnsettledAsOf(row: { settled_at: string | null }, endExclusiveIso: string): boolean {
  const settledAt = row.settled_at;
  if (settledAt != null && settledAt < endExclusiveIso) return false;
  return true;
}

/** 月末在庫金額と同じ行集合（未決済・廃棄除外・パーツ含む） */
export async function scanUnsettledItemsAsOf(asOfDateYmd: string): Promise<{
  asOfDate: string;
  endExclusiveIso: string;
  rows: UnsettledAsOfItem[];
}> {
  const endExclusiveIso = asOfEndExclusiveIsoFromDate(asOfDateYmd);
  if (!endExclusiveIso) {
    throw new Error("asOf は YYYY-MM-DD 形式で指定してください。");
  }

  const rows: UnsettledAsOfItem[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select(ITEM_SELECT)
      .lt("created_at", endExclusiveIso)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const raw of data as Record<string, unknown>[]) {
      if (isInventoryExitExcluded(raw)) continue;
      const row = mapScanRow(raw);
      if (!isUnsettledAsOf(row, endExclusiveIso)) continue;
      rows.push(row);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return { asOfDate: asOfDateYmd.trim(), endExclusiveIso, rows };
}

type ProductAgg = {
  jan_code: string;
  brand: string | null;
  product_name: string | null;
  model_number: string | null;
  currentCount: number;
  pendingCount: number;
};

function preferNonempty(current: string | null, next: string | null | undefined): string | null {
  if (nonempty(current)) return current;
  return trimOrNull(next);
}

export async function aggregateInventoryAsOf(asOfDateYmd: string): Promise<InventoryAsOfPayload> {
  const { asOfDate, endExclusiveIso, rows } = await scanUnsettledItemsAsOf(asOfDateYmd);

  let unsettledCount = 0;
  let unsettledAmount = 0;
  let allocatedCount = 0;
  let allocatedAmount = 0;
  const byJan = new Map<string, ProductAgg>();

  for (const row of rows) {
    unsettledCount += 1;
    unsettledAmount += num(row.effective_unit_price);

    const janKey = nonempty(row.jan_code) ? String(row.jan_code).trim() : JAN_NONE;
    let agg = byJan.get(janKey);
    if (!agg) {
      agg = {
        jan_code: janKey,
        brand: trimOrNull(row.brand),
        product_name: trimOrNull(row.product_name),
        model_number: trimOrNull(row.model_number),
        currentCount: 0,
        pendingCount: 0,
      };
      byJan.set(janKey, agg);
    } else {
      agg.brand = preferNonempty(agg.brand, row.brand);
      agg.product_name = preferNonempty(agg.product_name, row.product_name);
      agg.model_number = preferNonempty(agg.model_number, row.model_number);
    }
    agg.currentCount += 1;

    if (nonempty(row.order_id)) {
      allocatedCount += 1;
      allocatedAmount += num(row.effective_unit_price);
      agg.pendingCount += 1;
    }
  }

  const productRows: InventoryAsOfProductRow[] = [...byJan.values()]
    .map((agg) => ({
      jan_code: agg.jan_code,
      brand: agg.brand,
      product_name: agg.product_name,
      model_number: agg.model_number,
      currentCount: agg.currentCount,
      pendingCount: agg.pendingCount,
      physicalCount: agg.currentCount - agg.pendingCount,
    }))
    .sort((a, b) => {
      if (a.jan_code === JAN_NONE && b.jan_code !== JAN_NONE) return 1;
      if (b.jan_code === JAN_NONE && a.jan_code !== JAN_NONE) return -1;
      return a.jan_code.localeCompare(b.jan_code, "ja");
    });

  const displayDate = asOfDate.replace(/-/g, "/");
  return {
    asOfDate,
    asOfIso: endExclusiveIso,
    label: `${displayDate} 23:59:59（東京）時点（決済日基準）`,
    unsettled: { count: unsettledCount, totalAmount: unsettledAmount },
    allocatedPending: { count: allocatedCount, totalAmount: allocatedAmount },
    onSale: { count: Math.max(0, unsettledCount - allocatedCount) },
    productRows,
  };
}

function conditionLabel(c: string | null | undefined): string {
  if (c === "new") return "新品";
  if (c === "used") return "中古";
  return c ?? "";
}

function progressLabel(orderId: string | null): string {
  return nonempty(orderId) ? "引当済（決済待ち）" : "販売中";
}

function formatRegisteredDate(iso: string | null, fallbackIso: string | null): string {
  const src = iso || fallbackIso;
  if (!src) return "";
  return new Date(src)
    .toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, "-");
}

function escapeCsv(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function loadSupplierNameByKana(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data, error } = await supabase.from("suppliers").select("name, kana");
  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) return map;
    throw error;
  }
  for (const row of data ?? []) {
    const kana = String(row.kana ?? "").trim();
    const name = String(row.name ?? "").trim();
    if (kana && name) map.set(kana, name);
  }
  return map;
}

function resolveSupplierName(stored: string | null, byKana: Map<string, string>): string {
  if (!stored || !stored.trim()) return "—";
  return byKana.get(stored) ?? stored;
}

export async function buildUnsettledItemsCsv(asOfDateYmd: string): Promise<{
  filename: string;
  csv: string;
}> {
  const { asOfDate, rows } = await scanUnsettledItemsAsOf(asOfDateYmd);
  const supplierByKana = await loadSupplierNameByKana();
  const header = [
    "id",
    "jan_code",
    "brand",
    "product_name",
    "model_number",
    "supplier",
    "genre",
    "base_price",
    "effective_unit_price",
    "created_at",
    "registered_at",
    "status",
    "progress",
    "item_kind",
  ].join(",");
  const lines = rows.map((r) =>
    [
      r.id,
      r.jan_code ?? "",
      r.brand ?? "",
      r.product_name ?? "",
      r.model_number ?? "",
      resolveSupplierName(r.supplier, supplierByKana),
      r.genre ?? "",
      r.base_price ?? "",
      r.effective_unit_price ?? "",
      r.created_at ?? "",
      formatRegisteredDate(r.registered_at, r.created_at),
      conditionLabel(r.condition_type),
      progressLabel(r.order_id),
      r.item_kind ?? "product",
    ]
      .map(escapeCsv)
      .join(",")
  );
  const csv = "\uFEFF" + [header, ...lines].join("\r\n");
  return {
    filename: `inventory_as_of_items_${asOfDate.replace(/-/g, "")}.csv`,
    csv,
  };
}
