import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dateRange, isDate, shiftDate, tokyoDate } from "./sales-analysis-aggregates";
import type { AsinTotal, TrafficDaily, TrendDaily } from "./sales-analysis-types";

type JsonRecord = Record<string, unknown>;
function object(v: unknown): JsonRecord { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("レポート形式が不正です"); return v as JsonRecord; }
function numeric(v: unknown) { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("レポート数値が不正です"); return v; }
function integer(v: unknown) { const n = numeric(v); if (!Number.isInteger(n)) throw new Error("レポート個数が不正です"); return n; }
export function parseSalesTrafficReport(input: unknown, start: string, end: string, reportId: string | null = null) {
  if (!isDate(start) || !isDate(end) || start > end) throw new Error("要求期間が不正です");
  const report = object(input);
  if (!Array.isArray(report.salesAndTrafficByDate)) throw new Error("日別レポートがありません");
  const seen = new Set<string>();
  const daily: TrafficDaily[] = report.salesAndTrafficByDate.map(value => {
    const row = object(value), sales = object(row.salesByDate), traffic = object(row.trafficByDate);
    // 11/12保存応答では+09:00の開始時刻が前日の日付になる。U-date1は未確定のまま、応答文字列を保存する。
    if (!isDate(row.date) || row.date < shiftDate(start, -1) || row.date > end || seen.has(row.date)) throw new Error("日別レポートの日付が不正です");
    seen.add(row.date);
    const amount = object(sales.orderedProductSales);
    if (amount.currencyCode !== "JPY") throw new Error("日本円以外のレポートです");
    return { date: row.date, sessions: integer(traffic.sessions), page_views: integer(traffic.pageViews), buy_box_percentage: numeric(traffic.buyBoxPercentage), unit_session_percentage: numeric(traffic.unitSessionPercentage), ordered_product_sales: numeric(amount.amount), total_order_items: integer(sales.totalOrderItems), units_ordered: integer(sales.unitsOrdered), source_report_id: reportId };
  });
  // 2026-11-17：本番の90日分に条件に合わない行が混ざり、1行のためにレポート全体を捨てていた。
  // 合わない行だけ飛ばし、数と例（ASIN・通貨の値だけ）を返す。大半が合わないときは従来どおりエラー。
  const rawAsin = Array.isArray(report.salesAndTrafficByAsin) ? report.salesAndTrafficByAsin : [];
  const skippedAsinSamples: string[] = [];
  let skippedAsinCount = 0;
  const asinRows: AsinTotal[] = [];
  for (const value of rawAsin) {
    const row = object(value), sales = object(row.salesByAsin), amount = object(sales.orderedProductSales);
    if (typeof row.childAsin !== "string" || !/^[A-Z0-9]{10}$/.test(row.childAsin) || amount.currencyCode !== "JPY") {
      skippedAsinCount += 1;
      if (skippedAsinSamples.length < 5) skippedAsinSamples.push(`${String(row.childAsin ?? "(なし)").slice(0, 20)}/${String(amount.currencyCode ?? "(なし)").slice(0, 5)}`);
      continue;
    }
    asinRows.push({ asin: row.childAsin, window_start: start, window_end: end, units_ordered: integer(sales.unitsOrdered), ordered_sales: numeric(amount.amount) });
  }
  if (rawAsin.length > 0 && skippedAsinCount * 2 > rawAsin.length) throw new Error(`ASIN別レポートが不正です（${skippedAsinCount}/${rawAsin.length}行、例 ${skippedAsinSamples.join(", ")}）`);
  // 固定応答には親ASINの違う同一childAsinが存在する。主キー単位へまとめてからbatch upsertする。
  const byAsin = new Map<string, AsinTotal>();
  for (const row of asinRows) {
    const previous = byAsin.get(row.asin);
    byAsin.set(row.asin, previous ? { ...row, units_ordered: previous.units_ordered + row.units_ordered, ordered_sales: previous.ordered_sales + row.ordered_sales } : row);
  }
  return { daily, totals: [...byAsin.values()], skippedAsinCount, skippedAsinSamples };
}
export function validateTrendsPayload(input: unknown) {
  const body = object(input), start = body.window_start, end = body.window_end;
  if (!isDate(start) || !isDate(end) || start > end || dateRange(start, end).length !== 90 || !Array.isArray(body.rows) || body.rows.length !== 90) throw new Error("90日分のトレンドが必要です");
  const expected = new Set(dateRange(start, end));
  const rows: TrendDaily[] = body.rows.map(value => {
    const row = object(value);
    if (!isDate(row.date) || !expected.delete(row.date) || row.keyword !== "Amazon" || typeof row.trend_value !== "number" || !Number.isFinite(row.trend_value) || row.trend_value < 0 || row.trend_value > 100) throw new Error("トレンドの日付・キーワード・値が不正です");
    return { date: row.date, keyword: "Amazon", trend_value: row.trend_value };
  });
  if (expected.size) throw new Error("トレンドに欠損があります");
  return { start, end, rows };
}
function checked(result: { error: unknown }) { if (result.error) throw new Error("売上分析の保存に失敗しました"); }
export async function saveSalesTraffic(db: SupabaseClient, parsed: ReturnType<typeof parseSalesTrafficReport>, start: string, end: string, includeAsins: boolean) {
  if (includeAsins) {
    const batch = randomUUID();
    if (parsed.totals.length) checked(await db.from("sales_traffic_asin_totals").upsert(parsed.totals.map(row => ({ ...row, fetch_batch_id: batch, fetched_at: new Date().toISOString() })), { onConflict: "asin,window_start,window_end" }));
    let prune = db.from("sales_traffic_asin_totals").delete().eq("window_start", start).eq("window_end", end);
    if (parsed.totals.length) prune = prune.not("asin", "in", `(${parsed.totals.map(r => r.asin).join(",")})`);
    checked(await prune);
  }
  if (parsed.daily.length) checked(await db.from("sales_traffic_daily").upsert(parsed.daily.map(row => ({ ...row, fetched_at: new Date().toISOString() })), { onConflict: "date" }));
}
export async function importTrends(db: SupabaseClient, input: unknown) {
  const { start, end, rows } = validateTrendsPayload(input), batch = randomUUID();
  checked(await db.from("google_trends_daily").upsert(rows.map(row => ({ ...row, fetch_batch_id: batch, fetched_at: new Date().toISOString() })), { onConflict: "date,keyword" }));
  checked(await db.from("google_trends_daily").delete().eq("keyword", "Amazon").neq("fetch_batch_id", batch).or(`date.lt.${start},date.gt.${end}`));
  return rows.length;
}

export type ReportState = { phase: "poll" | "download"; reportId: string; requestedWindowStart: string; requestedWindowEnd: string; documentId?: string };
export type SyncDependencies = {
  db: SupabaseClient;
  getState(key: string): Promise<Record<string, unknown> | null>;
  setState(key: string, state: Record<string, unknown>): Promise<void>;
  deleteState(key: string): Promise<void>;
  call(operation: string, parameters: Record<string, unknown>): Promise<unknown>;
  download(url: string, compression?: string): Promise<unknown>;
  now(): number; sleep(ms: number): Promise<void>;
};
// 暫定50秒。Vercelの実設定を未接続では確認できないため、反映前に60秒以上の上限を窓口が確認する。
export const SALES_TRAFFIC_BUDGET_MS = 50000;
const IO_RESERVE_MS = 35000;
async function bounded<T>(work: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("売上分析処理の待機時間を超えました")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export async function runSalesTrafficSync(deps: SyncDependencies, today = tokyoDate(), backfill = false) {
  const deadline = deps.now() + SALES_TRAFFIC_BUDGET_MS;
  let fetched = 0;
  let skippedAsinCount = 0;
  const skippedAsinSamples: string[] = [];
  let pending = false;
  const processReport = async (key: string, days: number, includeAsins: boolean, existing: Record<string, unknown> | null) => {
    let state: ReportState;
    if (existing?.reportId) {
      if (!isDate(existing.requestedWindowStart) || !isDate(existing.requestedWindowEnd) || typeof existing.reportId !== "string" || !["poll", "download"].includes(String(existing.phase))) throw new Error("取得状態が不正です");
      state = existing as unknown as ReportState;
    } else {
      if (deps.now() + IO_RESERVE_MS >= deadline) return false;
      const start = shiftDate(today, -(days - 1));
      const result = object(await deps.call("createReport", { body: { reportType: "GET_SALES_AND_TRAFFIC_REPORT", marketplaceIds: ["A1VC38T7YXB528"], dataStartTime: `${start}T00:00:00+09:00`, dataEndTime: `${today}T23:59:59+09:00`, reportOptions: { dateGranularity: "DAY", ...(includeAsins ? { asinGranularity: "CHILD" } : {}) } } }));
      if (typeof result.reportId !== "string") throw new Error("レポートIDがありません");
      state = { phase: "poll", reportId: result.reportId, requestedWindowStart: start, requestedWindowEnd: today };
      await deps.setState(key, { ...state });
    }
    while (deps.now() + IO_RESERVE_MS < deadline) {
      if (state.phase === "poll") {
        const result = object(await deps.call("getReport", { path: { reportId: state.reportId } }));
        if (["CANCELLED", "FATAL"].includes(String(result.processingStatus))) { await deps.deleteState(key); throw new Error("SP-APIレポートが失敗しました"); }
        if (result.processingStatus !== "DONE") { await deps.sleep(1500); continue; }
        if (typeof result.reportDocumentId !== "string") throw new Error("レポート文書がありません");
        state = { ...state, phase: "download", documentId: result.reportDocumentId };
        await deps.setState(key, { ...state });
      }
      const doc = object(await deps.call("getReportDocument", { path: { reportDocumentId: state.documentId } }));
      if (typeof doc.url !== "string") throw new Error("レポート文書がありません");
      const raw = await deps.download(doc.url, typeof doc.compressionAlgorithm === "string" ? doc.compressionAlgorithm : undefined);
      const parsed = parseSalesTrafficReport(raw, state.requestedWindowStart, state.requestedWindowEnd, state.reportId);
      if (includeAsins && !Array.isArray(object(raw).salesAndTrafficByAsin)) throw new Error("ASIN別レポートがありません");
      await saveSalesTraffic(deps.db, parsed, state.requestedWindowStart, state.requestedWindowEnd, includeAsins);
      await deps.deleteState(key);
      fetched += parsed.daily.length;
      skippedAsinCount += parsed.skippedAsinCount;
      skippedAsinSamples.push(...parsed.skippedAsinSamples.slice(0, 5 - skippedAsinSamples.length));
      return true;
    }
    return false; // poll/create後の状態は外部I/O前に既に保存済み。
  };
  const weeklyKey = "sales_traffic:weekly_asin", dailyKey = "sales_traffic:daily";
  const weekly = await deps.getState(weeklyKey);
  const latest = await deps.db.from("sales_traffic_asin_totals").select("window_end").order("window_end", { ascending: false }).limit(1);
  checked(latest);
  const lastEnd = latest.data?.[0]?.window_end as string | undefined;
  const monday = new Date(today).getUTCDay() === 1;
  if (weekly?.reportId || backfill || !lastEnd || lastEnd <= shiftDate(today, -7) || (monday && lastEnd !== today)) {
    if (!await processReport(weeklyKey, 90, true, weekly)) pending = true;
  }
  if (!pending && !backfill) {
    const daily = await deps.getState(dailyKey);
    if (!await processReport(dailyKey, 7, false, daily)) pending = true;
  }
  return { fetched, summary: pending ? "売上とトラフィック: 継続待ち（翌朝再開）" : "売上とトラフィック: 取得完了", metrics: { pending, fetched, skippedAsinCount, skippedAsinSamples } };
}
export async function runSalesTrafficPoll(backfill = false) {
  try {
    const [{ createSalesAnalysisWriter }, state] = await Promise.all([import("./supabase-server"), import("./cron-continuation-state")]);
    const values = [process.env.SP_API_CLIENT_ID, process.env.SP_API_CLIENT_SECRET, process.env.SP_API_REFRESH_TOKEN, process.env.SP_API_AWS_ACCESS_KEY, process.env.SP_API_AWS_SECRET_KEY];
    if (values.some(v => !v)) throw new Error("SP-API設定が不足しています");
    const SellingPartnerAPI = createRequire(import.meta.url)("amazon-sp-api");
    const client = new SellingPartnerAPI({ region: "fe", refresh_token: values[2], credentials: { SELLING_PARTNER_APP_CLIENT_ID: values[0], SELLING_PARTNER_APP_CLIENT_SECRET: values[1], AWS_ACCESS_KEY_ID: values[3], AWS_SECRET_ACCESS_KEY: values[4], AWS_SELLING_PARTNER_ROLE: "" }, options: { auto_request_throttled: false, retry_remote_timeout: false, timeouts: { response: 3000, idle: 3000, deadline: 3000 } } });
    return await runSalesTrafficSync({ db: createSalesAnalysisWriter(), getState: key => bounded(state.getCronState(key)), setState: (key, value) => bounded(state.setCronState(key, value)), deleteState: key => bounded(state.deleteCronState(key)), now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      call: (operation, parameters) => bounded(client.callAPI({ operation, endpoint: "reports", ...parameters }), 6500),
      download: async (url, compression) => { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error("本文取得失敗"); const buffer = Buffer.from(await response.arrayBuffer()); return JSON.parse((compression === "GZIP" ? gunzipSync(buffer, { maxOutputLength: 32 * 1024 * 1024 }) : buffer).toString("utf8")); },
    }, tokyoDate(), backfill);
  } catch (e: unknown) {
    // SDK由来のURL、署名、ヘッダーは渡さない。原因が分かるよう、種類・番号と伏せ字にした短い文だけ残す（2026-11-17）。
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
    const kind = [o.name, o.code, o.statusCode ?? o.status].filter((v) => v != null && String(v).length > 0).map(String).join("/");
    const text = String(o.message ?? e ?? "")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [伏せ字]")
      .replace(/(X-Amz-[A-Za-z0-9-]+|Signature|access_token|refresh_token|client_secret|Authorization)=?\s*[:=]\s*([^&\s"',]+)/gi, "$1=[伏せ字]")
      .slice(0, 200);
    throw new Error(`SALES_TRAFFIC_FAILED: SP-API取得に失敗しました（${kind || "不明"}: ${text}）`);
  }
}
