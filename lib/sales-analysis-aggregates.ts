import type { SupabaseClient } from "@supabase/supabase-js";
import type { AsinTotal, InboundRecord, OrderRecord, SaleEvent, SaleEventInput, SalesAnalysis, TrafficDaily, TrendDaily, WeekMetrics, WeeklySummary } from "./sales-analysis-types";

const DAY = 86400000;
export const SALES_NOTE = 'Amazon注文ベース（SP-API）の値。既存の「当月の数字」（決済・財務明細ベース）とは基準が異なります';
export function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function shiftDate(date: string, days: number) { return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10); }
export function tokyoDate(now = new Date()) { return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
export function dateRange(start: string, end: string) {
  if (!isDate(start) || !isDate(end) || start > end) return [];
  return Array.from({ length: Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1 }, (_, i) => shiftDate(start, i));
}
export function validateSaleEvent(value: unknown): SaleEventInput {
  const v = value as Partial<SaleEventInput> | null;
  if (!v || typeof v.label !== "string" || !v.label.trim() || v.label.length > 200 || !isDate(v.start_date) || !isDate(v.end_date) || v.start_date > v.end_date || (v.note != null && (typeof v.note !== "string" || v.note.length > 2000))) throw new Error("セール日程の入力が不正です");
  return { label: v.label.trim(), start_date: v.start_date, end_date: v.end_date, note: v.note ?? null };
}
export async function writeSaleEvent(db: SupabaseClient, value: unknown, id?: string) {
  const input = validateSaleEvent(value);
  const table = db.from("sale_events");
  const query = id === undefined ? table.insert(input) : table.update({ ...input, updated_at: new Date().toISOString() }).eq("id", id);
  return await query.select("id,label,start_date,end_date,note").maybeSingle();
}
export async function removeSaleEvent(db: SupabaseClient, id: string) {
  return await db.from("sale_events").delete().eq("id", id).select("id").maybeSingle();
}
export function selectTopAsins(rows: AsinTotal[]): AsinTotal[] {
  const end = rows.reduce((m, r) => r.window_end > m ? r.window_end : m, "");
  const start = rows.filter(r => r.window_end === end).reduce((m, r) => r.window_start > m ? r.window_start : m, "");
  return rows.filter(r => r.window_end === end && r.window_start === start).sort((a, b) => b.units_ordered - a.units_ordered || a.asin.localeCompare(b.asin)).slice(0, 30);
}
function timestamp(v: string | null | undefined): number | null { const n = v == null ? NaN : Date.parse(v); return Number.isFinite(n) ? n : null; }
export function stockoutCounts(dates: string[], top: AsinTotal[], items: InboundRecord[], orders: OrderRecord[]) {
  const earliest = new Map<string, number>();
  for (const o of orders) { const t = timestamp(o.created_at); if (t !== null) earliest.set(o.amazon_order_id, Math.min(earliest.get(o.amazon_order_id) ?? Infinity, t)); }
  const byAsin = new Map<string, { entered: number | null; exited: number | null }[]>();
  const targets = new Set(top.map(r => r.asin));
  for (const row of items) {
    // analyze.py と同じ順序：返品のみを除外してから追跡可否を決める。
    if (!row.asin || !targets.has(row.asin) || (row.return_amazon_order_id != null && row.order_id == null)) continue;
    const entered = timestamp(row.registered_at);
    const sold = (row.order_id != null ? earliest.get(row.order_id) : null) ?? timestamp(row.settled_at);
    const exit = timestamp(row.exit_at);
    let exited = sold == null ? exit : exit == null ? sold : Math.min(sold, exit);
    if (row.order_id != null && exited === null) exited = entered;
    const list = byAsin.get(row.asin) ?? []; list.push({ entered, exited }); byAsin.set(row.asin, list);
  }
  return { trackedCount: byAsin.size, counts: new Map(dates.map(date => {
    const noon = Date.parse(`${date}T12:00:00+09:00`);
    const count = [...byAsin.values()].filter(rows => !rows.some(r => r.entered !== null && r.entered <= noon && (r.exited === null || r.exited > noon))).length;
    return [date, byAsin.size ? count : null] as const;
  })) };
}
export function buildSalesAnalysis(start: string, end: string, daily: TrafficDaily[], totals: AsinTotal[], trends: TrendDaily[], events: SaleEvent[], items: InboundRecord[], orders: OrderRecord[]): SalesAnalysis {
  const dates = dateRange(start, end), top = selectTopAsins(totals), stock = stockoutCounts(dates, top, items, orders);
  const d = new Map(daily.map(r => [r.date, r])), t = new Map(trends.filter(r => r.keyword === "Amazon").map(r => [r.date, r.trend_value]));
  return { timezone: "Asia/Tokyo", requestedStart: start, requestedEnd: end, latestAvailableDate: daily.map(r => r.date).sort().at(-1) ?? null,
    topAsinWindow: { start: top[0]?.window_start ?? null, end: top[0]?.window_end ?? null, trackedCount: stock.trackedCount, totalCount: 30 },
    days: dates.map(date => ({ date, salesTotal: d.get(date)?.ordered_product_sales ?? null, orderCount: d.get(date)?.total_order_items ?? null, sessions: d.get(date)?.sessions ?? null, buyBoxPercentage: d.get(date)?.buy_box_percentage ?? null, trendValue: t.get(date) ?? null, topStockoutCount: stock.counts.get(date) ?? null, saleEvents: events.filter(e => e.start_date <= date && e.end_date >= date).map(e => e.label) })) };
}
const mean = (v: (number | null)[]) => { const a = v.filter((x): x is number => x !== null); return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null; };
export function buildWeeklySummary(analysis: SalesAnalysis, today = tokyoDate()): WeeklySummary {
  let end = shiftDate(today, -1);
  // 月曜は直前の完了週を比較する。火曜以降は今週の昨日まで。
  const weekday = (new Date(today).getUTCDay() + 6) % 7;
  const start = shiftDate(today, weekday === 0 ? -7 : -weekday);
  if (weekday === 0) end = shiftDate(start, 6);
  const week = (s: string, e: string, label: string): WeekMetrics => {
    const rows = analysis.days.filter(d => s <= d.date && d.date <= e && d.salesTotal !== null);
    return { label, rangeStart: s, rangeEnd: e, presentWeekdays: rows.map(d => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d.date).getUTCDay()]), salesTotal: rows.length ? rows.reduce((n, r) => n + r.salesTotal!, 0) : null, orderCount: rows.length ? rows.reduce((n, r) => n + r.orderCount!, 0) : null, buyBoxPercentage: mean(rows.map(r => r.buyBoxPercentage)), topStockoutAvg: mean(rows.map(r => r.topStockoutCount)), trackedAsinCount: analysis.topAsinWindow.trackedCount };
  };
  const a = week(start, end, weekday === 0 ? "直近の完了週" : "今週"), b = week(shiftDate(start, -7), shiftDate(end, -7), "比較する前週");
  const comparable = a.presentWeekdays.length > 0 && [...a.presentWeekdays].sort().join() === [...b.presentWeekdays].sort().join();
  const delta = (x: number | null, y: number | null) => comparable && x !== null && y !== null ? x - y : null;
  const pct = (x: number | null, y: number | null) => comparable && x !== null && y !== null && y !== 0 ? (x - y) / y * 100 : null;
  return { thisWeek: a, lastWeek: b, comparable, dataAsOf: analysis.latestAvailableDate, note: SALES_NOTE,
    delta: { salesTotal: delta(a.salesTotal, b.salesTotal), orderCount: delta(a.orderCount, b.orderCount), buyBoxPercentagePoint: delta(a.buyBoxPercentage, b.buyBoxPercentage), topStockoutAvg: delta(a.topStockoutAvg, b.topStockoutAvg) }, deltaPercent: { salesTotal: pct(a.salesTotal, b.salesTotal), orderCount: pct(a.orderCount, b.orderCount) } };
}

// 決済用の既存集計は参照しない。安定した順序で1000行ずつ取得する。
export async function readAllRows<T>(db: SupabaseClient, table: string, columns: string, order: string, filter: (q: ReturnType<ReturnType<SupabaseClient["from"]>["select"]>) => ReturnType<ReturnType<SupabaseClient["from"]>["select"]> = q => q): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order(order).range(offset, offset + 999);
    if (error) throw new Error("売上分析データの取得に失敗しました");
    rows.push(...(data ?? []) as T[]);
    if (!data || data.length < 1000) return rows;
  }
}
export async function loadSalesAnalysis(db: SupabaseClient, start: string, end: string): Promise<SalesAnalysis> {
  const latest = await db.from("sales_traffic_asin_totals").select("window_start,window_end").order("window_end", { ascending: false }).order("window_start", { ascending: false }).limit(1);
  if (latest.error) throw new Error("主力商品の取得に失敗しました");
  const window = latest.data?.[0];
  const totals = window ? await readAllRows<AsinTotal>(db, "sales_traffic_asin_totals", "asin,window_start,window_end,units_ordered,ordered_sales", "asin", q => q.eq("window_start", window.window_start).eq("window_end", window.window_end)) : [];
  const top = selectTopAsins(totals), asins = top.map(r => r.asin);
  const [daily, trends, events, items, orders] = await Promise.all([
    readAllRows<TrafficDaily>(db, "sales_traffic_daily", "*", "date", q => q.gte("date", start).lte("date", end)),
    readAllRows<TrendDaily>(db, "google_trends_daily", "date,keyword,trend_value", "date", q => q.eq("keyword", "Amazon").gte("date", start).lte("date", end)),
    readAllRows<SaleEvent>(db, "sale_events", "id,label,start_date,end_date,note", "id", q => q.lte("start_date", end).gte("end_date", start)),
    asins.length ? readAllRows<InboundRecord>(db, "inbound_items", "asin,registered_at,order_id,settled_at,exit_at,return_amazon_order_id", "id", q => q.in("asin", asins)) : [],
    asins.length ? readAllRows<OrderRecord>(db, "amazon_orders", "amazon_order_id,created_at", "id", q => q.in("asin", asins)) : [],
  ]);
  const result = buildSalesAnalysis(start, end, daily, top, trends, events, items, orders);
  const last = await db.from("sales_traffic_daily").select("date").order("date", { ascending: false }).limit(1);
  if (last.error) throw new Error("最新取得日の確認に失敗しました");
  result.latestAvailableDate = last.data?.[0]?.date ?? null;
  return result;
}
