/**
 * 指定日時（JST 0:00）時点の棚卸用在庫集計（商品＝JAN単位）
 * - 対象: 仕入日（inbound_headers.purchase_date）が基準日より前
 * - 現在在庫数: 販売中＋引当済（決済待ち）＝ settled_at 未設定 or 基準以降
 * - 未決済在庫: 引当済（決済待ち）＝ 注文日＜基準 かつ 決済日なし／基準以降
 * - 実在庫: 現在在庫数 − 未決済在庫
 *
 * Amazon の注文日は CSV 取込時に amazon_orders.created_at へ保存された値を使用する。
 * 他販路は other_orders.order_date。
 */
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";
import { num } from "@/lib/dashboard-aggregates";
import type { InventoryAsOfPayload, InventoryAsOfProductRow } from "@/lib/dashboard-types";

const PAGE = 1000;
const ORDER_ID_BATCH = 80;
const JAN_NONE = "(JANなし)";

function nonempty(s: string | null | undefined): boolean {
  return s != null && String(s).trim().length > 0;
}

function trimOrNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

/** YYYY-MM-DD → その日 00:00 JST の ISO（決済・注文日の比較用） */
export function asOfStartIsoFromDate(dateYmd: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`).toISOString();
  if (Number.isNaN(Date.parse(iso))) return null;
  return iso;
}

export function todayYmdTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type InboundScanRow = {
  id: number;
  order_id: string | null;
  settled_at: string | null;
  exit_type: string | null;
  registered_at: string | null;
  effective_unit_price: number | null;
  jan_code: string | null;
  brand: string | null;
  product_name: string | null;
  model_number: string | null;
};

function isUnsettledAsOf(row: InboundScanRow, asOfIso: string): boolean {
  const settledAt = row.settled_at;
  if (settledAt != null && settledAt < asOfIso) return false;
  const exitType = row.exit_type;
  const registeredAt = row.registered_at;
  if (exitType != null && registeredAt != null && registeredAt < asOfIso) return false;
  if (exitType != null && registeredAt == null) return false;
  return true;
}

/** 仕入日が基準日より前のヘッダ ID を全件取得 */
async function loadHeaderIdsBeforePurchaseDate(asOfDateYmd: string): Promise<number[]> {
  const headerIds: number[] = [];
  let hFrom = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_headers")
      .select("id")
      .lt("purchase_date", asOfDateYmd)
      .order("id", { ascending: true })
      .range(hFrom, hFrom + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const h of data) {
      const hid = Number(h.id);
      if (Number.isFinite(hid)) headerIds.push(hid);
    }
    if (data.length < PAGE) break;
    hFrom += PAGE;
  }
  return headerIds;
}

async function loadOrderDateMap(orderIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!orderIds.length) return map;

  for (let i = 0; i < orderIds.length; i += ORDER_ID_BATCH) {
    const batch = orderIds.slice(i, i + ORDER_ID_BATCH);

    const { data: amazonRows, error: amazonErr } = await supabase
      .from("amazon_orders")
      .select("amazon_order_id, created_at")
      .in("amazon_order_id", batch);
    if (amazonErr) throw amazonErr;
    for (const r of amazonRows ?? []) {
      const oid = String(r.amazon_order_id ?? "").trim();
      const ca = r.created_at != null ? String(r.created_at) : "";
      if (!oid || !ca) continue;
      const prev = map.get(oid);
      if (!prev || ca < prev) map.set(oid, ca);
    }

    const { data: otherRows, error: otherErr } = await supabase
      .from("other_orders")
      .select("order_id, order_date")
      .in("order_id", batch);
    if (otherErr) throw otherErr;
    for (const r of otherRows ?? []) {
      const oid = String(r.order_id ?? "").trim();
      const od = r.order_date != null ? String(r.order_date) : "";
      if (!oid || !od) continue;
      const prev = map.get(oid);
      if (!prev || od < prev) map.set(oid, od);
    }
  }

  return map;
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
  const asOfIso = asOfStartIsoFromDate(asOfDateYmd);
  if (!asOfIso) {
    throw new Error("asOf は YYYY-MM-DD 形式で指定してください。");
  }

  const headerIds = await loadHeaderIdsBeforePurchaseDate(asOfDateYmd);
  const unsettledRows: InboundScanRow[] = [];

  for (let i = 0; i < headerIds.length; i += ORDER_ID_BATCH) {
    const chunk = headerIds.slice(i, i + ORDER_ID_BATCH);
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("inbound_items")
        .select(
          "id, order_id, settled_at, exit_type, registered_at, effective_unit_price, jan_code, brand, product_name, model_number"
        )
        .in("header_id", chunk)
        .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data as InboundScanRow[]) {
        if (isUnsettledAsOf(row, asOfIso)) unsettledRows.push(row);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }

  const orderIds = [
    ...new Set(
      unsettledRows
        .map((r) => (nonempty(r.order_id) ? String(r.order_id).trim() : ""))
        .filter(Boolean)
    ),
  ];
  const orderDateById = await loadOrderDateMap(orderIds);

  let unsettledCount = 0;
  let unsettledAmount = 0;
  let allocatedCount = 0;
  let allocatedAmount = 0;
  let allocatedOrderDateUnknown = 0;
  const byJan = new Map<string, ProductAgg>();

  for (const row of unsettledRows) {
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

    const oid = nonempty(row.order_id) ? String(row.order_id).trim() : "";
    if (!oid) continue;

    const orderDate = orderDateById.get(oid) ?? null;
    if (!orderDate) {
      allocatedOrderDateUnknown += 1;
      continue;
    }

    if (orderDate < asOfIso) {
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

  const onSaleCount = unsettledCount - allocatedCount - allocatedOrderDateUnknown;

  return {
    asOfDate: asOfDateYmd,
    asOfIso,
    label: `${asOfDateYmd.replace(/-/g, "/")} 0:00（東京）時点（仕入日基準）`,
    unsettled: { count: unsettledCount, totalAmount: unsettledAmount },
    allocatedPending: { count: allocatedCount, totalAmount: allocatedAmount },
    onSale: { count: Math.max(0, onSaleCount) },
    allocatedOrderDateUnknown,
    productRows,
  };
}
