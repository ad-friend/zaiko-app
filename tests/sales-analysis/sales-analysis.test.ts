import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSalesAnalysis, buildWeeklySummary, dateRange, loadSalesAnalysis, readAllRows, removeSaleEvent, selectTopAsins, shiftDate, stockoutCounts, validateSaleEvent, writeSaleEvent } from "../../lib/sales-analysis-aggregates";
import { importTrends, parseSalesTrafficReport, runSalesTrafficSync, saveSalesTraffic, validateTrendsPayload, type SyncDependencies } from "../../lib/sales-traffic-sync";
import type { AsinTotal, InboundRecord, OrderRecord, TrendDaily } from "../../lib/sales-analysis-types";
import { requireTrendsImportAuth } from "../../lib/trends-import-auth";
import { MockDatabase } from "./mock-db";

// コピー・環境変数・ネット接続を使わず、依頼された取得済みデータだけを読む。
const source = "C:/Users/user/Desktop/AIの作業場/secretary/research/売上日次分析";
const fixture = (name: string) => JSON.parse(readFileSync(join(source, "data", name), "utf8"));
const raw = fixture("sales_traffic.json"), parsed = parseSalesTrafficReport(raw, "2026-08-11", "2026-11-11");
const items: InboundRecord[] = fixture("db_inbound_items.json"), orders: OrderRecord[] = fixture("db_amazon_orders.json");
const top = selectTopAsins(parsed.totals);
const dates = dateRange("2026-08-12", "2026-11-11");
const stock = stockoutCounts(dates, top, items, orders);
const trends: TrendDaily[] = readFileSync(join(source, "data/trends_amazon.csv"), "utf8").trim().split(/\r?\n/).slice(1).map(line => { const [date, trend] = line.split(","); return { date, keyword: "Amazon", trend_value: Number(trend) }; });
const analysis = buildSalesAnalysis(dates[0], dates.at(-1)!, parsed.daily, parsed.totals, trends, [], items, orders);

test("保存済みSP-API応答3件の日別・ASIN期間合計を解析", () => {
  let count = 0;
  for (const filename of readdirSync(join(source, "data")).filter(n => /^sales_traffic.*\.json$/.test(n))) {
    const data = fixture(filename), rows = data.salesAndTrafficByDate;
    const result = parseSalesTrafficReport(data, rows[0].date, rows.at(-1).date, "fixture");
    assert.equal(result.daily.length, rows.length); assert.equal(result.totals.length, new Set(data.salesAndTrafficByAsin.map((r: { childAsin: string }) => r.childAsin)).size);
    assert.equal(result.daily[0].ordered_product_sales, rows[0].salesByDate.orderedProductSales.amount);
    assert.equal(result.daily[0].source_report_id, "fixture"); count++;
  }
  assert.equal(count, 3); assert.equal(parsed.daily.length, 93); assert.equal(parsed.totals.length, 888);
  // 研究スクリプトのJST要求に対して前日文字列を含む実応答も日付を変換せず保存する。
  assert.equal(parseSalesTrafficReport(raw, "2026-08-12", "2026-11-11").daily[0].date, "2026-08-11");
  assert.equal(parsed.totals.find(r => r.asin === "B0C6LNJL6C")?.units_ordered, 51);
});
test("SP-API不正値・重複日・通貨違いは保存前に拒否", () => {
  const bad = structuredClone(raw); bad.salesAndTrafficByDate[0].salesByDate.orderedProductSales.currencyCode = "USD";
  assert.throws(() => parseSalesTrafficReport(bad, "2026-08-12", "2026-11-12"));
  bad.salesAndTrafficByDate[0].salesByDate.orderedProductSales.currencyCode = "JPY";
  bad.salesAndTrafficByDate.push(bad.salesAndTrafficByDate[0]); assert.throws(() => parseSalesTrafficReport(bad, "2026-08-12", "2026-11-12"));
});
test("主力30は最新window_end→最新window_start→個数降順→ASIN昇順", () => {
  const base = (asin: string, start: string, end: string, n: number): AsinTotal => ({ asin, window_start: start, window_end: end, units_ordered: n, ordered_sales: 0 });
  assert.deepEqual(selectTopAsins([base("OLD", "2026-01-01", "2026-02-01", 999), base("OTHER", "2026-01-01", "2026-03-01", 999), base("B", "2026-01-02", "2026-03-01", 2), base("A", "2026-01-02", "2026-03-01", 2)]).map(r => r.asin), ["A", "B"]);
  assert.equal(top.length, 30); assert.ok(top.every((r, i) => !i || top[i - 1].units_ordered >= r.units_ordered));
});
test("返品のみのASINは追跡対象から除外、正午境界・最小販売時刻・即売を検証", () => {
  const totals = ["RETURN", "UNKNOWN", "SOLD", "EXIT", "STOCK"].map(asin => ({ asin, window_start: "2026-01-01", window_end: "2026-11-11", units_ordered: 1, ordered_sales: 0 }));
  const base: InboundRecord = { asin: null, registered_at: "2026-11-01T00:00:00+09:00", order_id: null, settled_at: null, exit_at: null, return_amazon_order_id: null };
  const result = stockoutCounts(["2026-11-11"], totals, [
    { ...base, asin: "RETURN", return_amazon_order_id: "R" }, { ...base, asin: "UNKNOWN", order_id: "missing" },
    { ...base, asin: "SOLD", order_id: "sale", settled_at: "2026-11-12T00:00:00+09:00" },
    { ...base, asin: "EXIT", exit_at: "2026-11-11T12:00:00+09:00" },
    { ...base, asin: "STOCK", registered_at: "2026-11-11T12:00:00+09:00" },
  ], [{ amazon_order_id: "sale", created_at: "2026-11-11T13:00:00+09:00" }, { amazon_order_id: "sale", created_at: "2026-11-11T11:00:00+09:00" }]);
  assert.equal(result.trackedCount, 4); assert.equal(result.counts.get("2026-11-11"), 3);
  assert.equal(stockoutCounts(["2026-11-11"], totals.slice(0, 1), [{ ...base, asin: "RETURN", return_amazon_order_id: "R" }], []).counts.get("2026-11-11"), null);
});
test("Excelの日次在庫切れ数92日・週平均14週と照合", () => {
  const result = spawnSync("python", [resolve("tests/sales-analysis/read-reference.py"), join(source, "売上日次分析_2026-08-12_11-11.xlsx")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const book = JSON.parse(result.stdout) as { daily: Record<string, string | number>[]; weekly: Record<string, string | number>[]; stock: Record<string, string | number>[] };
  const stockHeader = book.stock[0];
  assert.deepEqual(new Set(Object.entries(stockHeader).filter(([k]) => k !== "A").map(([, v]) => String(v).slice(0, 10))), new Set(top.map(r => r.asin).filter(asin => items.some(r => r.asin === asin && !(r.return_amazon_order_id != null && r.order_id == null)))));
  const header = book.daily[0], stockColumn = Object.keys(header).find(k => header[k] === "主力の在庫切れ数")!;
  assert.ok(stockColumn);
  for (const row of book.daily.slice(1)) { const date = String(row.A); assert.equal(stock.counts.get(date), row[stockColumn], date); }
  const weeklyColumn = Object.keys(book.weekly[0]).find(k => book.weekly[0][k] === "主力の在庫切れ数")!;
  const weekly = new Map<string, number[]>();
  for (const date of dates) { const sunday = shiftDate(date, (7 - new Date(date).getUTCDay()) % 7); const label = "～" + sunday.slice(5).replace("-", "/"); const group = weekly.get(label) ?? []; group.push(stock.counts.get(date)!); weekly.set(label, group); }
  for (const row of book.weekly.slice(1)) { const group = weekly.get(String(row.A))!; const avg = group.reduce((a, b) => a + b, 0) / group.length; assert.ok(Math.abs(avg - Number(row[weeklyColumn])) <= 0.00501, `週${row.A}: ${avg} vs ${row[weeklyColumn]}`); }
  console.log(`Excel照合: 日次${book.daily.length - 1}件・週${book.weekly.length - 1}件一致、追跡${stock.trackedCount}/30`);
});
test("日次APIの欠損nullと実値0・イベント重複・追跡不能を区別", () => {
  const a = buildSalesAnalysis("2026-11-10", "2026-11-11", [{ ...parsed.daily[0], date: "2026-11-10", ordered_product_sales: 0 }], [], [], [{ id: 1, label: "セール", start_date: "2026-11-10", end_date: "2026-11-11", note: null }], [], []);
  assert.equal(a.days[0].salesTotal, 0); assert.equal(a.days[1].salesTotal, null); assert.equal(a.days[0].trendValue, null); assert.equal(a.days[0].topStockoutCount, null); assert.deepEqual(a.days[1].saleEvents, ["セール"]);
});
test("週要点: 同曜日のみ比較し、日数が同じでも異曜日ならdeltaはnull", () => {
  const a = structuredClone(analysis); a.days = a.days.filter(d => ["2026-11-02", "2026-11-03", "2026-11-09", "2026-11-10"].includes(d.date));
  const summary = buildWeeklySummary(a, "2026-11-11"); assert.equal(summary.comparable, true); assert.deepEqual(summary.thisWeek.presentWeekdays, ["Mon", "Tue"]);
  a.days.find(d => d.date === "2026-11-03")!.date = "2026-11-04";
  const mismatch = buildWeeklySummary(a, "2026-11-12"); assert.equal(mismatch.comparable, false); assert.equal(mismatch.delta.salesTotal, null); assert.equal(mismatch.deltaPercent.orderCount, null);
  const empty = buildWeeklySummary({ ...a, days: [] }, "2026-11-12"); assert.equal(empty.comparable, false); assert.equal(empty.thisWeek.salesTotal, null);
});
test("週要点: 先週0なら増減率null、カート率は日率の算術平均、月曜は完了週", () => {
  const a = structuredClone(analysis); a.days = a.days.filter(d => d.date >= "2026-11-02");
  for (const row of a.days) if (row.date < "2026-11-09") { row.salesTotal = 0; row.orderCount = 0; }
  const s = buildWeeklySummary(a, "2026-11-12"); assert.equal(s.comparable, true); assert.equal(s.deltaPercent.salesTotal, null);
  const rows = a.days.filter(d => d.date >= "2026-11-09"); assert.equal(s.thisWeek.buyBoxPercentage, rows.reduce((n, r) => n + r.buyBoxPercentage!, 0) / rows.length);
  const monday = buildWeeklySummary(analysis, "2026-11-09"); assert.equal(monday.thisWeek.rangeStart, "2026-11-02"); assert.equal(monday.thisWeek.rangeEnd, "2026-11-08");
});
const trendInput = () => { const end = "2026-11-11", start = shiftDate(end, -89); return { window_start: start, window_end: end, rows: trends.filter(r => r.date >= start && r.date <= end) }; };
test("トレンド完全性: 保存CSV90日・重複・欠損・混合語・範囲外・不正日付", () => {
  const value = trendInput(); assert.equal(validateTrendsPayload(value).rows.length, 90);
  for (const mutate of [ (v: ReturnType<typeof trendInput>) => { v.rows.pop(); }, (v: ReturnType<typeof trendInput>) => { v.rows[0] = v.rows[1]; }, (v: ReturnType<typeof trendInput>) => { v.rows[0].keyword = "Other"; }, (v: ReturnType<typeof trendInput>) => { v.rows[0].trend_value = 101; }, (v: ReturnType<typeof trendInput>) => { v.rows[0].date = "2026-02-30"; } ]) { const v = structuredClone(value); mutate(v); assert.throws(() => validateTrendsPayload(v)); }
});
test("二重取り込み: 同じSP-API入力2回で行数不変、消えたASINをprune", async () => {
  const db = new MockDatabase(); await saveSalesTraffic(db.client, parsed, "2026-08-11", "2026-11-11", true); await saveSalesTraffic(db.client, parsed, "2026-08-11", "2026-11-11", true);
  assert.equal(db.tables.get("sales_traffic_daily")!.length, 93); assert.equal(db.tables.get("sales_traffic_asin_totals")!.length, 888);
  await saveSalesTraffic(db.client, { ...parsed, totals: parsed.totals.slice(1) }, "2026-08-11", "2026-11-11", true); assert.equal(db.tables.get("sales_traffic_asin_totals")!.length, 887);
  assert.deepEqual(db.calls.filter(c => c.table === "sales_traffic_asin_totals" && c.action === "upsert").map(c => c.count), [888, 888, 887]);
});
test("トレンド2回・週がずれた再取込でも90行・1batch、無効入力は一切書かない", async () => {
  const db = new MockDatabase(), input = trendInput(); await importTrends(db.client, input); await importTrends(db.client, input);
  assert.equal(db.tables.get("google_trends_daily")!.length, 90);
  const shifted = { window_start: shiftDate(input.window_start, 7), window_end: shiftDate(input.window_end, 7), rows: input.rows.map(r => ({ ...r, date: shiftDate(r.date, 7) })) };
  await importTrends(db.client, shifted); const rows = db.tables.get("google_trends_daily")!;
  assert.equal(rows.length, 90); assert.equal(new Set(rows.map(r => r.fetch_batch_id)).size, 1); assert.equal(rows[0].date, shifted.window_start);
  const calls = db.calls.length; await assert.rejects(importTrends(db.client, { ...input, rows: input.rows.slice(1) })); assert.equal(db.calls.length, calls);
});
test("1000行ページング・主力ASIN絞り込みで固定DB全件を取得", async () => {
  const db = new MockDatabase(); db.tables.set("sales_traffic_daily", parsed.daily); db.tables.set("sales_traffic_asin_totals", parsed.totals); db.tables.set("google_trends_daily", trends);
  db.tables.set("inbound_items", items.map((r, id) => ({ ...r, id }))); db.tables.set("amazon_orders", orders.map((r, id) => ({ ...r, id })));
  assert.equal((await readAllRows<InboundRecord>(db.client, "inbound_items", "*", "id")).length, 14108);
  const actual = await loadSalesAnalysis(db.client, dates[0], dates.at(-1)!); assert.deepEqual(actual.days, analysis.days);
});
function syncFixture() {
  const db = new MockDatabase(), states = new Map<string, Record<string, unknown>>(); let clock = 0;
  const operations: string[] = [];
  const deps: SyncDependencies = { db: db.client, getState: async key => states.get(key) ?? null, setState: async (key, value) => { states.set(key, value); }, deleteState: async key => { states.delete(key); }, now: () => clock, sleep: async ms => { clock += ms; },
    call: async operation => { operations.push(operation); if (operation === "createReport") return { reportId: "fixture-report" }; if (operation === "getReport") return { processingStatus: "DONE", reportDocumentId: "fixture-document" }; return { url: "mock://fixture" }; },
    download: async () => ({ salesAndTrafficByDate: raw.salesAndTrafficByDate.filter((r: { date: string }) => r.date >= "2026-08-14"), salesAndTrafficByAsin: raw.salesAndTrafficByAsin }),
  };
  return { db, states, operations, deps };
}
test("cronは1呼出しでcreate→poll→download完了、pending時に再createしない", async () => {
  const f = syncFixture(); const result = await runSalesTrafficSync(f.deps, "2026-11-11", true); assert.equal(result.metrics.pending, false); assert.deepEqual(f.operations, ["createReport", "getReport", "getReportDocument"]); assert.equal(f.states.size, 0);
  const g = syncFixture(); g.states.set("sales_traffic:weekly_asin", { phase: "poll", reportId: "old", requestedWindowStart: "2026-08-14", requestedWindowEnd: "2026-11-11" });
  g.deps.now = () => 0; await runSalesTrafficSync(g.deps, "2026-11-12", true); assert.ok(!g.operations.includes("createReport"));
  assert.equal(g.db.tables.get("sales_traffic_asin_totals")![0].window_end, "2026-11-11");
});
test("cron予算切れは継続保存、CANCELLED/FATALはstate削除、DB失敗はstate維持", async () => {
  const f = syncFixture(); const call = f.deps.call; f.deps.call = async (operation, args) => operation === "getReport" ? { processingStatus: "IN_PROGRESS" } : call(operation, args);
  assert.equal((await runSalesTrafficSync(f.deps, "2026-11-11", true)).metrics.pending, true); assert.equal(f.states.size, 1);
  for (const status of ["CANCELLED", "FATAL"]) { f.deps.call = async () => ({ processingStatus: status }); await assert.rejects(runSalesTrafficSync(f.deps, "2026-11-12", true)); assert.equal(f.states.size, 0); f.states.set("sales_traffic:weekly_asin", { phase: "poll", reportId: "old", requestedWindowStart: "2026-08-14", requestedWindowEnd: "2026-11-11" }); }
  const g = syncFixture(); g.db.failTable = "sales_traffic_daily"; await assert.rejects(runSalesTrafficSync(g.deps, "2026-11-11", true)); assert.equal(g.states.size, 1);
});
test("cronは週次完了後に日次7日も取得し、最新週次があれば日次だけ実行", async () => {
  const f = syncFixture();
  f.deps.download = async () => { const current = f.states.get("sales_traffic:daily") ?? f.states.get("sales_traffic:weekly_asin")!; return { salesAndTrafficByDate: raw.salesAndTrafficByDate.filter((r: { date: string }) => r.date >= String(current.requestedWindowStart)), salesAndTrafficByAsin: raw.salesAndTrafficByAsin }; };
  await runSalesTrafficSync(f.deps, "2026-11-11"); assert.equal(f.operations.filter(o => o === "createReport").length, 2); assert.equal(f.states.size, 0);
  f.operations.length = 0; await runSalesTrafficSync(f.deps, "2026-11-11"); assert.equal(f.operations.filter(o => o === "createReport").length, 1);
});
test("セール入力の日付順序・実在日付・空ラベルを検証", () => {
  assert.deepEqual(validateSaleEvent({ label: " セール ", start_date: "2026-11-01", end_date: "2026-11-02" }), { label: "セール", start_date: "2026-11-01", end_date: "2026-11-02", note: null });
  for (const value of [null, {}, { label: " ", start_date: "2026-11-01", end_date: "2026-11-02" }, { label: "a", start_date: "2026-11-02", end_date: "2026-11-01" }, { label: "a", start_date: "2026-02-30", end_date: "2026-03-01" }]) assert.throws(() => validateSaleEvent(value));
});
test("専用Bearerは未設定500・誤り401・一致200（ダミー値のみ）", () => {
  const original = process.env.TRENDS_IMPORT_SECRET;
  try { delete process.env.TRENDS_IMPORT_SECRET; assert.equal(requireTrendsImportAuth(null), 500); process.env.TRENDS_IMPORT_SECRET = "test-only-not-a-real-secret"; assert.equal(requireTrendsImportAuth("Bearer invalid"), 401); assert.equal(requireTrendsImportAuth("Bearer test-only-not-a-real-secret"), 200); }
  finally { if (original === undefined) delete process.env.TRENDS_IMPORT_SECRET; else process.env.TRENDS_IMPORT_SECRET = original; }
});
test("セールCRUDをモックで検証: 重複追加エラー・編集・期間重なり・削除・不存在", async () => {
  const db = new MockDatabase(), value = { label: "セール", start_date: "2026-11-01", end_date: "2026-11-05" };
  const inserted = await writeSaleEvent(db.client, value); assert.equal(inserted.error, null); assert.equal(inserted.data?.id, 1);
  assert.equal((await writeSaleEvent(db.client, value)).error?.code, "23505"); assert.equal(db.tables.get("sale_events")!.length, 1);
  assert.equal((await writeSaleEvent(db.client, { ...value, label: "編集済み" }, "1")).data?.label, "編集済み");
  assert.equal((await readAllRows(db.client, "sale_events", "*", "id", q => q.lte("start_date", "2026-11-02").gte("end_date", "2026-11-02"))).length, 1);
  assert.equal((await removeSaleEvent(db.client, "1")).data?.id, 1); assert.equal(db.tables.get("sale_events")!.length, 0); assert.equal((await removeSaleEvent(db.client, "1")).data, null);
});
