/**
 * 指定日時（JST 0:00）時点の棚卸用在庫集計
 * - 未決済在庫: 入庫済みかつ settled_at が未設定 or 基準時刻以降
 * - 引当済（決済待ち）: 注文日が基準時刻より前、かつ決済日が未設定 or 基準時刻以降
 *
 * Amazon の注文日は CSV 取込時に amazon_orders.created_at へ保存された値を使用する。
 * 他販路は other_orders.order_date。
 */
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";
import { num } from "@/lib/dashboard-aggregates";
import type { InventoryAsOfPayload, InventoryAsOfRow } from "@/lib/dashboard-types";

const PAGE = 1000;
const ORDER_ID_BATCH = 80;

function nonempty(s: string | null | undefined): boolean {
  return s != null && String(s).trim().length > 0;
}

/** YYYY-MM-DD → その日 00:00 JST の ISO（その瞬間「時点」） */
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
  created_at: string | null;
  effective_unit_price: number | null;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  asin: string | null;
};

function isUnsettledAsOf(row: InboundScanRow, asOfIso: string): boolean {
  if (row.created_at != null && row.created_at >= asOfIso) return false;
  const settledAt = row.settled_at;
  if (settledAt != null && settledAt < asOfIso) return false;
  const exitType = row.exit_type;
  const registeredAt = row.registered_at;
  if (exitType != null && registeredAt != null && registeredAt < asOfIso) return false;
  if (exitType != null && registeredAt == null) return false;
  return true;
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

export async function aggregateInventoryAsOf(asOfDateYmd: string): Promise<InventoryAsOfPayload> {
  const asOfIso = asOfStartIsoFromDate(asOfDateYmd);
  if (!asOfIso) {
    throw new Error("asOf は YYYY-MM-DD 形式で指定してください。");
  }

  const unsettledRows: InboundScanRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select(
        "id, order_id, settled_at, exit_type, registered_at, created_at, effective_unit_price, jan_code, brand, model_number, asin"
      )
      .lt("created_at", asOfIso)
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
  const allocatedRows: InventoryAsOfRow[] = [];
  const unknownOrderDateRows: InventoryAsOfRow[] = [];

  for (const row of unsettledRows) {
    unsettledCount += 1;
    unsettledAmount += num(row.effective_unit_price);

    const oid = nonempty(row.order_id) ? String(row.order_id).trim() : "";
    if (!oid) continue;

    const orderDate = orderDateById.get(oid) ?? null;
    const base: InventoryAsOfRow = {
      id: row.id,
      order_id: oid,
      order_date: orderDate,
      settled_at: row.settled_at,
      jan_code: row.jan_code,
      brand: row.brand,
      model_number: row.model_number,
      asin: row.asin,
      effective_unit_price: num(row.effective_unit_price),
    };

    if (!orderDate) {
      allocatedOrderDateUnknown += 1;
      unknownOrderDateRows.push(base);
      continue;
    }

    if (orderDate < asOfIso) {
      allocatedCount += 1;
      allocatedAmount += num(row.effective_unit_price);
      allocatedRows.push(base);
    }
  }

  allocatedRows.sort((a, b) => {
    const da = a.order_date ?? "";
    const db = b.order_date ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.id - b.id;
  });

  const onSaleCount = unsettledCount - allocatedCount - allocatedOrderDateUnknown;

  return {
    asOfDate: asOfDateYmd,
    asOfIso,
    label: `${asOfDateYmd.replace(/-/g, "/")} 0:00（東京）時点`,
    unsettled: { count: unsettledCount, totalAmount: unsettledAmount },
    allocatedPending: { count: allocatedCount, totalAmount: allocatedAmount },
    onSale: { count: Math.max(0, onSaleCount) },
    allocatedOrderDateUnknown,
    allocatedRows,
    unknownOrderDateRows,
  };
}
