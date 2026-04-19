/**
 * Vercel Cron 用エンドポイント（サーバ側で処理を完走させる）
 * - Authorization: Bearer ${CRON_SECRET}
 * - GET /api/cron/run?jobKey=orders_poll
 * - GET /api/cron/run?jobKey=finances_poll（財務チャンク・要 cron_continuation_state。過去 FINANCES_LOOKBACK_DAYS 日・既定45。state キー finances:rolling:yyyy-MM-dd）
 * - GET /api/cron/run?jobKey=listing_report_poll（出品レポート段階実行）
 * - GET /api/cron/run?jobKey=reconcile_poll（自動消込の短いバッチ）
 * - GET /api/cron/run?jobKey=finances_daily&reconcile=1（日次5通知・消込のみ。財務/出品は上記ポールに依存）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { gunzipSync } from "zlib";
import {
  clampFinancialQueryBounds,
  createAmazonFinancesSpClient,
  fetchFinancialEventsChunk,
  parseFinancesLookbackDaysFromEnv,
  rollingFinancesBoundsForCronDay,
  upsertSalesTransactionRows,
} from "@/lib/amazon-financial-events";
import { deleteCronState, getCronState, setCronState } from "@/lib/cron-continuation-state";

type JobStatus = "running" | "success" | "error";

function nowIso(): string {
  return new Date().toISOString();
}

function requireCronAuth(req: NextRequest): { ok: true } | { ok: false; res: NextResponse } {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, res: NextResponse.json({ error: "CRON_SECRET が未設定です。" }, { status: 500 }) };
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    console.log("【DEBUG】サーバー側の正解:", secret);
    console.log("【DEBUG】送られてきた値:", auth);
    return { ok: false, res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}

function safeString(v: unknown): string {
  return v == null ? "" : String(v);
}

function extractHttpErrorCode(message: string): string | null {
  // よくある: "Request failed with status code 429"
  const m = message.match(/\bstatus code\s+(\d{3})\b/i);
  if (m?.[1]) return m[1];
  const m2 = message.match(/\b(\d{3})\b/);
  if (m2?.[1]) return m2[1];
  return null;
}

async function insertDashboardNotice(payload: {
  job_key: string;
  result: "success" | "error";
  fetched: number;
  summary: string;
  metrics?: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
}) {
  const { error } = await supabase.from("dashboard_notices").insert({
    notice_type: payload.result === "success" ? "cron_job_success" : "cron_job_error",
    payload: {
      job_key: payload.job_key,
      fetched: payload.fetched,
      summary: payload.summary,
      metrics: payload.metrics ?? {},
      error_code: payload.error_code ?? null,
      error_message: payload.error_message ?? null,
      created_at: nowIso(),
    },
  });
  if (error) {
    // テーブルが無い場合は握りつぶさず、ジョブ自体は成功扱いでも良いが、今回はログとして残す
    console.error("[cron/run] dashboard_notices insert failed:", error.message);
  }
}

async function cleanupOldJobs(days = 90): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // created_at は started_at
  const { error } = await supabase.from("cron_jobs").delete().lt("started_at", cutoff);
  if (error) {
    console.error("[cron/run] cron_jobs cleanup failed:", error.message);
  }
}

async function cleanupOldDashboardNotices(days = 90): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("dashboard_notices").delete().lt("created_at", cutoff);
  if (error) console.error("[cron/run] dashboard_notices cleanup failed:", error.message);
}

type TokyoYesterdayBounds = {
  label: string;
  /** 東京の「昨日」の yyyy-MM-dd（state_key 用） */
  dateKey: string;
  startIso: string;
  endExclusiveIso: string;
};

function dayBoundsTokyoYesterday(): TokyoYesterdayBounds {
  const tz = "Asia/Tokyo";
  const fmtEn = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayTokyo = fmtEn.format(new Date());
  const todayTokyoMidnight = new Date(`${todayTokyo}T00:00:00+09:00`);
  const startTokyo = new Date(todayTokyoMidnight.getTime() - 24 * 60 * 60 * 1000);
  const label = new Intl.DateTimeFormat("ja-JP", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(startTokyo);
  const dateKey = fmtEn.format(startTokyo);
  return { label, dateKey, startIso: startTokyo.toISOString(), endExclusiveIso: todayTokyoMidnight.toISOString() };
}

const FINANCES_POLL_MAX_PAGES = 15;
/** レポートオプション変更時はキーを変え、進行中の旧 reportId と混ざらないようにする */
const LISTING_STATE_KEY = "listing:GET_MERCHANT_LISTINGS_ALL_DATA:custom_en_US";
const MAX_LISTING_POLL_ATTEMPTS = 500;

function createSpClient() {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) {
    throw new Error("SP-APIの認証情報が不足しています（SP_API_* を確認してください）");
  }
  const SellingPartnerAPI = require("amazon-sp-api");
  return new SellingPartnerAPI({
    region: "fe",
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      AWS_SELLING_PARTNER_ROLE: "",
    },
  });
}

async function fetchTextFromReportDocument(url: string, compressionAlgorithm: string | null | undefined): Promise<string> {
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`レポート本文のダウンロードに失敗しました (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (String(compressionAlgorithm ?? "").toUpperCase() === "GZIP") return gunzipSync(buf).toString("utf-8");
  return buf.toString("utf-8");
}

function conditionFromItemCondition(raw: string): "New" | "Used" {
  const n = Number(String(raw ?? "").trim());
  if (n === 11) return "New";
  return "Used";
}

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/**
 * GET_MERCHANT_LISTINGS_ALL_DATA の TSV（reportOptions.custom=true でカスタム出力を要求）。
 * item-condition 列が無い場合は全行 New。ある場合は 11=New、それ以外 Used。
 */
function parseListingReportTsv(text: string): {
  rows: Array<{ sku: string; asin: string | null; condition_id: "New" | "Used" }>;
  parseErrors: string[];
} {
  const bomStripped = text.replace(/^\uFEFF/, "");
  const lines = bomStripped.split(/\r?\n/);
  const headerLine = lines.find((l) => l.trim().length > 0) ?? "";
  const headers = headerLine.split("\t").map((h) => h.trim().toLowerCase());
  const idx = (k: string) => headers.findIndex((h) => h === k);
  const skuIdx = idx("seller-sku");
  const asinIdx = idx("asin1");
  const condIdx = idx("item-condition");
  if (skuIdx < 0 || asinIdx < 0) {
    return {
      rows: [],
      parseErrors: [
        "必須列が見つかりません（seller-sku / asin1）。出品詳細(GET_MERCHANT_LISTINGS_ALL_DATA)・言語 en_US を確認してください。",
      ],
    };
  }
  const parseErrors: string[] = [];
  if (condIdx < 0) {
    parseErrors.push("item-condition 列がありません。全行を新品(New)として登録します。");
  }
  const bySku = new Map<string, { sku: string; asin: string | null; condition_id: "New" | "Used" }>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const sku = toTrimmedString(cols[skuIdx]);
    if (!sku) continue;
    const asin = toTrimmedString(cols[asinIdx]) || null;
    const condition_id: "New" | "Used" =
      condIdx >= 0 ? conditionFromItemCondition(toTrimmedString(cols[condIdx])) : "New";
    bySku.set(sku, { sku, asin, condition_id });
  }
  return { rows: [...bySku.values()], parseErrors };
}

async function upsertSkuConditions(rows: Array<{ sku: string; asin: string | null; condition_id: "New" | "Used" }>): Promise<{ upserted: number; deletedStale: number }> {
  if (!rows.length) return { upserted: 0, deletedStale: 0 };
  const now = nowIso();
  const payloads = rows.map((r) => ({ sku: r.sku, condition_id: r.condition_id, asin: r.asin, last_updated: now }));
  let upserted = 0;
  const UPSERT_CHUNK = 500;
  for (let i = 0; i < payloads.length; i += UPSERT_CHUNK) {
    const chunk = payloads.slice(i, i + UPSERT_CHUNK);
    const { data, error } = await supabase.from("amazon_sku_conditions").upsert(chunk, { onConflict: "sku" }).select("sku");
    if (error) throw new Error(error.message);
    upserted += Array.isArray(data) ? data.length : 0;
  }
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 2);
  const { error: delErr, count } = await supabase.from("amazon_sku_conditions").delete({ count: "exact" }).lt("last_updated", cutoff.toISOString());
  if (delErr) throw new Error(`古い行の削除に失敗しました: ${delErr.message}`);
  return { upserted, deletedStale: count ?? 0 };
}

async function runFinancesPoll(): Promise<{ fetched: number; summary: string; metrics: Record<string, unknown> }> {
  const lookbackDays = parseFinancesLookbackDaysFromEnv();
  const boundsFresh = rollingFinancesBoundsForCronDay(lookbackDays);
  const stateKey = `finances:rolling:${boundsFresh.dateKey}`;
  const payload = await getCronState(stateKey);

  let postedAfter: string;
  let postedBefore: string;
  let startNextToken: string | null = null;

  if (!payload || String(payload.dateKey ?? "") !== boundsFresh.dateKey) {
    const c = clampFinancialQueryBounds(boundsFresh.postedAfter, boundsFresh.postedBefore);
    postedAfter = c.postedAfter;
    postedBefore = c.postedBefore;
    startNextToken = null;
  } else {
    postedAfter = String(payload.postedAfter ?? boundsFresh.postedAfter);
    postedBefore = String(payload.postedBefore ?? boundsFresh.postedBefore);
    const nt = payload.nextToken;
    startNextToken = nt != null && String(nt).length > 0 ? String(nt) : null;
    const c = clampFinancialQueryBounds(postedAfter, postedBefore);
    postedAfter = c.postedAfter;
    postedBefore = c.postedBefore;
  }

  const spClient = createAmazonFinancesSpClient();
  const chunk = await fetchFinancialEventsChunk(spClient, {
    postedAfter,
    postedBefore,
    startNextToken,
    maxPages: FINANCES_POLL_MAX_PAGES,
  });

  const upsert = await upsertSalesTransactionRows(chunk.rows);
  if (upsert.tableMissing) {
    throw new Error("sales_transactions テーブルがありません。docs/sales_transactions_table.sql を実行してください。");
  }

  if (chunk.complete) {
    await deleteCronState(stateKey);
  } else {
    await setCronState(stateKey, {
      dateKey: boundsFresh.dateKey,
      dayLabel: boundsFresh.label,
      postedAfter,
      postedBefore,
      nextToken: chunk.nextToken,
    });
  }

  const summary = chunk.complete
    ? `財務ポール: 区間完走 (${boundsFresh.dateKey} / 過去${lookbackDays}日) / insert ${upsert.inserted} skip ${upsert.skipped} / 行 ${chunk.rows.length}`
    : `財務ポール: 継続中 (${boundsFresh.dateKey} / 過去${lookbackDays}日) / ページ ${chunk.pagesFetched} / insert ${upsert.inserted}`;

  return {
    fetched: chunk.rows.length,
    summary,
    metrics: {
      step: "finances_poll",
      dateKey: boundsFresh.dateKey,
      dayLabel: boundsFresh.label,
      lookbackDays,
      pagesFetched: chunk.pagesFetched,
      rowsFlattened: chunk.rows.length,
      rowsInserted: upsert.inserted,
      rowsSkipped: upsert.skipped,
      windowComplete: chunk.complete,
      hasMoreToken: Boolean(chunk.nextToken),
    },
  };
}

async function runListingReportPollStep(): Promise<{ fetched: number; summary: string; metrics: Record<string, unknown> }> {
  const sp = createSpClient();
  const marketplaceId = "A1VC38T7YXB528";
  const reportType = "GET_MERCHANT_LISTINGS_ALL_DATA";
  const st = await getCronState(LISTING_STATE_KEY);

  if (!st || st.phase == null) {
    const created = (await sp.callAPI({
      operation: "createReport",
      endpoint: "reports",
      body: {
        reportType,
        marketplaceIds: [marketplaceId],
        reportOptions: {
          preferredReportDocumentLocale: "en_US",
          custom: "true",
        },
      },
    })) as { reportId?: string };
    const reportId = String(created?.reportId ?? "").trim();
    if (!reportId) throw new Error("出品レポートの作成に失敗しました（reportIdが取得できません）");
    await setCronState(LISTING_STATE_KEY, { phase: "poll", reportId, pollAttempts: 0, reportType });
    return {
      fetched: 0,
      summary: `出品レポート: 作成済み、次回ポーリング (${reportId.slice(0, 10)}…)`,
      metrics: { step: "listing_create", reportId, pollAttempts: 0 },
    };
  }

  if (String(st.phase) === "poll") {
    const reportId = String(st.reportId ?? "");
    const pollAttempts = Number(st.pollAttempts ?? 0) + 1;
    if (pollAttempts > MAX_LISTING_POLL_ATTEMPTS) {
      await deleteCronState(LISTING_STATE_KEY);
      throw new Error("出品レポート: ポーリング上限に達しました");
    }
    const r = (await sp.callAPI({
      operation: "getReport",
      endpoint: "reports",
      path: { reportId },
    })) as { processingStatus?: string; reportDocumentId?: string };
    const processingStatus = String(r?.processingStatus ?? "");
    const reportDocumentId = String(r?.reportDocumentId ?? "");
    if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
      await deleteCronState(LISTING_STATE_KEY);
      throw new Error(`出品レポートの生成に失敗しました (${processingStatus})`);
    }
    if (processingStatus === "DONE" && reportDocumentId) {
      const doc = (await sp.callAPI({
        operation: "getReportDocument",
        endpoint: "reports",
        path: { reportDocumentId },
      })) as { url?: string; compressionAlgorithm?: string };
      const url = String(doc?.url ?? "").trim();
      if (!url) throw new Error("出品レポートURLが取得できませんでした");
      const text = await fetchTextFromReportDocument(url, doc?.compressionAlgorithm);
      const parsed = parseListingReportTsv(text);
      if (parsed.parseErrors.length && parsed.rows.length === 0) {
        await deleteCronState(LISTING_STATE_KEY);
        throw new Error(parsed.parseErrors[0]);
      }
      const { upserted, deletedStale } = await upsertSkuConditions(parsed.rows);
      await deleteCronState(LISTING_STATE_KEY);
      return {
        fetched: upserted,
        summary: `出品レポート: 成功 / 辞書更新 ${upserted}件`,
        metrics: {
          step: "listing_download",
          completed: true,
          reportType,
          processingStatus,
          rows: parsed.rows.length,
          upserted,
          deletedStale,
          parseErrors: parsed.parseErrors.slice(0, 5),
        },
      };
    }
    await setCronState(LISTING_STATE_KEY, { phase: "poll", reportId, pollAttempts, reportType });
    return {
      fetched: 0,
      summary: `出品レポート: ポーリング (${processingStatus || "処理中"}) #${pollAttempts}`,
      metrics: { step: "listing_poll", reportId, pollAttempts, processingStatus },
    };
  }

  await deleteCronState(LISTING_STATE_KEY);
  throw new Error("出品レポート: 不明な state フェーズ");
}

async function startJob(job_key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("cron_jobs")
    .insert({ job_key, status: "running", started_at: nowIso() })
    .select("id")
    .limit(1);
  if (error) {
    console.error("[cron/run] cron_jobs insert failed:", error.message);
    return null;
  }
  const id = data?.[0]?.id;
  return id ? String(id) : null;
}

async function finishJob(id: string | null, patch: { status: JobStatus; metrics?: Record<string, unknown>; error_code?: string | null; error_message?: string | null }) {
  if (!id) return;
  const { error } = await supabase
    .from("cron_jobs")
    .update({
      status: patch.status,
      finished_at: nowIso(),
      metrics: patch.metrics ?? {},
      error_code: patch.error_code ?? null,
      error_message: patch.error_message ?? null,
    })
    .eq("id", id);
  if (error) console.error("[cron/run] cron_jobs update failed:", error.message);
}

async function fetchJsonAnySafe(res: Response): Promise<{ json: any; raw: string }> {
  const raw = await res.text();
  const t = raw.trim();
  if (!t) return { json: null, raw };
  try {
    return { json: JSON.parse(t), raw };
  } catch {
    return { json: null, raw };
  }
}

function originFromRequest(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  return `${proto}://${host}`;
}

async function runOrdersPoll(req: NextRequest): Promise<{ fetched: number; summary: string; metrics: Record<string, unknown> }> {
  const origin = originFromRequest(req);
  const minutes = 10;
  const url = `${origin}/api/amazon/fetch-orders?minutes=${minutes}`;
  const res = await fetch(url, { method: "GET" });
  const { json, raw } = await fetchJsonAnySafe(res);
  if (!res.ok) {
    const msg = (json && typeof json.error === "string" ? json.error : null) ?? raw.slice(0, 300) ?? "注文取得に失敗しました";
    throw new Error(msg);
  }
  const fetched = Number(json?.rowsUpserted ?? 0);
  const summary = `注文取得: 成功 / 取得 ${fetched}件`;
  const ordersFetched = Number(json?.ordersFetched ?? 0);
  return {
    fetched,
    summary,
    metrics: { minutes, rowsUpserted: fetched, ordersFetched, message: safeString(json?.message ?? "") },
  };
}

async function runAutoReconcile(req: NextRequest, maxRounds = 120): Promise<{ reconciled: number; skipped: number }> {
  const origin = originFromRequest(req);
  let reconciled = 0;
  let skipped = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const res = await fetch(`${origin}/api/amazon/reconcile-sales`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { json, raw } = await fetchJsonAnySafe(res);
    if (!res.ok) {
      const msg = (json && typeof json.error === "string" ? json.error : null) ?? raw.slice(0, 300) ?? "自動消込に失敗しました";
      throw new Error(msg);
    }
    const processedOrders = Number(json?.processedOrders ?? 0);
    reconciled += Number(json?.reconciledCount ?? 0);
    skipped += Number(json?.skippedCount ?? 0);
    if (processedOrders <= 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return { reconciled, skipped };
}

export async function GET(req: NextRequest) {
  const auth = requireCronAuth(req);
  if (!auth.ok) return auth.res;

  const { searchParams } = new URL(req.url);
  const jobKey = safeString(searchParams.get("jobKey")).trim();
  const runReconcile = safeString(searchParams.get("reconcile")).trim() === "1";

  if (!jobKey) {
    return NextResponse.json({ error: "jobKey を指定してください。" }, { status: 400 });
  }

  await cleanupOldJobs(90);
  await cleanupOldDashboardNotices(90);
  const jobId = await startJob(jobKey);
  const startedAt = nowIso();

  try {
    let fetched = 0;
    let summary = "";
    let metrics: Record<string, unknown> = { startedAt };

    if (jobKey === "orders_poll") {
      const r = await runOrdersPoll(req);
      fetched = r.fetched;
      summary = r.summary;
      metrics = { ...metrics, ...r.metrics };
    } else if (jobKey === "finances_poll") {
      const r = await runFinancesPoll();
      fetched = r.fetched;
      summary = r.summary;
      metrics = { ...metrics, ...r.metrics };
    } else if (jobKey === "listing_report_poll") {
      const r = await runListingReportPollStep();
      fetched = r.fetched;
      summary = r.summary;
      metrics = { ...metrics, ...r.metrics };
    } else if (jobKey === "reconcile_poll") {
      const rec = await runAutoReconcile(req, 12);
      fetched = rec.reconciled;
      summary = `自動消込ポール: reconciled ${rec.reconciled} / skipped ${rec.skipped}`;
      metrics = { ...metrics, autoReconcile: rec };
    } else if (jobKey === "finances_daily") {
      summary = `日次ジョブ: 通知・消込（財務・出品は finances_poll / listing_report_poll で取得）`;
      metrics = { ...metrics, note: "finances_daily_orchestrator" };
      fetched = 0;
    } else {
      summary = `${jobKey}: 未対応 / 取得 0件`;
      metrics = { ...metrics, notImplemented: true };
    }

    if (runReconcile && jobKey === "finances_daily") {
      const rec = await runAutoReconcile(req, 28);
      metrics = { ...metrics, autoReconcile: rec };
      fetched = rec.reconciled;
    }

    await finishJob(jobId, { status: "success", metrics });
    const quietCronJobs = new Set(["orders_poll", "finances_poll", "listing_report_poll", "reconcile_poll"]);
    if (!quietCronJobs.has(jobKey)) {
      await insertDashboardNotice({
        job_key: jobKey,
        result: "success",
        fetched,
        summary,
        metrics,
        error_code: null,
        error_message: null,
      });
    }

    // finances_daily の完走後に「毎日の結果」をまとめて通知する（5項目）
    if (jobKey === "finances_daily") {
      const day = dayBoundsTokyoYesterday();

      // 1) Amazon注文取得（日次サマリ）
      const { data: pollJobs, error: pollErr } = await supabase
        .from("cron_jobs")
        .select("metrics, status")
        .eq("job_key", "orders_poll")
        .gte("started_at", day.startIso)
        .lt("started_at", day.endExclusiveIso);
      if (pollErr) throw new Error(`注文取得サマリの集計に失敗しました: ${pollErr.message}`);
      const list = Array.isArray(pollJobs) ? pollJobs : [];
      let pollRuns = 0;
      let pollOk = 0;
      let pollErrCount = 0;
      let sumRowsUpserted = 0;
      let sumOrdersFetched = 0;
      for (const j of list as Array<{ metrics: any; status: any }>) {
        pollRuns += 1;
        if (String(j.status) === "success") pollOk += 1;
        else if (String(j.status) === "error") pollErrCount += 1;
        const m = j.metrics && typeof j.metrics === "object" ? j.metrics : {};
        sumRowsUpserted += Number((m as any).rowsUpserted ?? 0) || 0;
        sumOrdersFetched += Number((m as any).ordersFetched ?? 0) || 0;
      }
      await insertDashboardNotice({
        job_key: "orders_poll_daily",
        result: pollErrCount > 0 ? "error" : "success",
        fetched: sumOrdersFetched,
        summary: `注文取得(日次 ${day.label}): ${pollErrCount > 0 ? "一部失敗" : "成功"} / 注文 ${sumOrdersFetched}件 / upsert ${sumRowsUpserted}行`,
        metrics: {
          step: "fetch_orders_daily",
          dayLabel: day.label,
          runs: pollRuns,
          successRuns: pollOk,
          errorRuns: pollErrCount,
          ordersFetched: sumOrdersFetched,
          rowsUpserted: sumRowsUpserted,
        },
        error_code: pollErrCount > 0 ? "PARTIAL" : null,
        error_message: pollErrCount > 0 ? "前日分のorders_pollに失敗が含まれます（詳細はcron_jobs参照）" : null,
      });

      // 2) 売上取得（財務）— finances_poll の集計
      const { data: finJobs, error: finErr } = await supabase
        .from("cron_jobs")
        .select("metrics, status")
        .eq("job_key", "finances_poll")
        .gte("started_at", day.startIso)
        .lt("started_at", day.endExclusiveIso);
      if (finErr) throw new Error(`財務ポール集計に失敗しました: ${finErr.message}`);
      const finList = Array.isArray(finJobs) ? finJobs : [];
      let finRuns = 0;
      let finErrCount = 0;
      let sumRowsFlattened = 0;
      let sumInserted = 0;
      let sumSkipped = 0;
      let sawWindowComplete = false;
      for (const j of finList as Array<{ metrics: any; status: any }>) {
        finRuns += 1;
        if (String(j.status) === "error") finErrCount += 1;
        const m = j.metrics && typeof j.metrics === "object" ? j.metrics : {};
        sumRowsFlattened += Number((m as any).rowsFlattened ?? 0) || 0;
        sumInserted += Number((m as any).rowsInserted ?? 0) || 0;
        sumSkipped += Number((m as any).rowsSkipped ?? 0) || 0;
        if ((m as any).windowComplete === true) sawWindowComplete = true;
      }
      const finPartial = finErrCount > 0 || (finRuns > 0 && !sawWindowComplete);
      await insertDashboardNotice({
        job_key: "fetch_finances_daily",
        result: finPartial ? "error" : "success",
        fetched: sumRowsFlattened,
        summary: `売上取得(日次 ${day.label}): ${finPartial ? "未完了または一部失敗" : "成功"} / 行 ${sumRowsFlattened}（insert ${sumInserted} / skip ${sumSkipped}） / 実行 ${finRuns}回`,
        metrics: {
          step: "fetch_finances",
          dayLabel: day.label,
          runs: finRuns,
          errorRuns: finErrCount,
          totalFetched: sumRowsFlattened,
          rowsInserted: sumInserted,
          rowsSkipped: sumSkipped,
          windowComplete: sawWindowComplete,
        },
        error_code: finPartial ? "PARTIAL" : null,
        error_message: finPartial
          ? "finances_poll が同日中に区間完走していないか、エラー実行があります（cron_jobs・cron_continuation_state を確認）"
          : null,
      });

      // 3) 注文データ消込 & 4) 売上引当て（同一エンジン）
      if (runReconcile) {
        const rec = (metrics as any).autoReconcile ?? {};
        const reconciled = Number(rec.reconciled ?? 0) || 0;
        const skipped = Number(rec.skipped ?? 0) || 0;
        await insertDashboardNotice({
          job_key: "auto_reconcile_daily",
          result: "success",
          fetched: reconciled,
          summary: `注文消込(日次 ${day.label}): 成功 / reconciled ${reconciled}件 / skipped ${skipped}件`,
          metrics: { step: "auto_reconcile", dayLabel: day.label, reconciled, skipped },
          error_code: null,
          error_message: null,
        });
        await insertDashboardNotice({
          job_key: "sales_allocation_daily",
          result: "success",
          fetched: reconciled,
          summary: `売上引当て(日次 ${day.label}): 成功 / 引当 ${reconciled}件`,
          metrics: { step: "sales_allocation", dayLabel: day.label, reconciled, skipped },
          error_code: null,
          error_message: null,
        });
      }

      // 5) 出品レポート — listing_report_poll の完了分を集計
      const { data: listJobs, error: listErr } = await supabase
        .from("cron_jobs")
        .select("metrics, status, finished_at")
        .eq("job_key", "listing_report_poll")
        .gte("started_at", day.startIso)
        .lt("started_at", day.endExclusiveIso);
      if (listErr) throw new Error(`出品レポート集計に失敗しました: ${listErr.message}`);
      const lj = Array.isArray(listJobs) ? listJobs : [];
      let bestUpserted = 0;
      let bestMetrics: Record<string, unknown> = {};
      let listErrCount = 0;
      for (const j of lj as Array<{ metrics: any; status: any }>) {
        if (String(j.status) === "error") listErrCount += 1;
        const m = j.metrics && typeof j.metrics === "object" ? j.metrics : {};
        if ((m as any).completed === true && String(j.status) === "success") {
          const u = Number((m as any).upserted ?? 0) || 0;
          if (u >= bestUpserted) {
            bestUpserted = u;
            bestMetrics = m as Record<string, unknown>;
          }
        }
      }
      if (bestUpserted > 0) {
        await insertDashboardNotice({
          job_key: "listing_report_daily",
          result: "success",
          fetched: bestUpserted,
          summary: `出品レポート(日次 ${day.label}): 成功 / 辞書更新 ${bestUpserted}件`,
          metrics: { step: "listing_report", dayLabel: day.label, ...bestMetrics },
          error_code: null,
          error_message: null,
        });
      } else {
        await insertDashboardNotice({
          job_key: "listing_report_daily",
          result: listErrCount > 0 ? "error" : "success",
          fetched: 0,
          summary:
            listErrCount > 0
              ? `出品レポート(日次 ${day.label}): 失敗または未完了（listing_report_poll を確認）`
              : `出品レポート(日次 ${day.label}): 完了ジョブなし（listing_report_poll のスケジュールを確認）`,
          metrics: { step: "listing_report", dayLabel: day.label, listPollErrors: listErrCount },
          error_code: listErrCount > 0 ? "PARTIAL" : null,
          error_message:
            listErrCount > 0 ? "listing_report_poll にエラーが含まれます" : "同日に completed な listing_report_poll がありません",
        });
      }
    }

    return NextResponse.json({ ok: true, jobKey, fetched, summary, metrics });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Cron job failed";
    const code = extractHttpErrorCode(message);
    const fetched = 0;
    const summary = `${jobKey}: 失敗${code ? `(${code})` : ""} / 取得 ${fetched}件`;
    await finishJob(jobId, { status: "error", metrics: { startedAt }, error_code: code, error_message: message });
    const quietOnError = new Set(["orders_poll", "finances_poll", "listing_report_poll", "reconcile_poll"]);
    if (!quietOnError.has(jobKey)) {
      await insertDashboardNotice({
        job_key: jobKey,
        result: "error",
        fetched,
        summary,
        metrics: { startedAt },
        error_code: code,
        error_message: message,
      });
    }
    return NextResponse.json({ error: message, jobKey }, { status: 500 });
  }
}

