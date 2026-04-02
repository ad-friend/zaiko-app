/**
 * Vercel Cron 用エンドポイント（サーバ側で処理を完走させる）
 * - Authorization: Bearer ${CRON_SECRET}
 * - GET /api/cron/run?jobKey=orders_poll
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { gunzipSync } from "zlib";

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

function dayBoundsTokyoYesterdayIso(): { label: string; startIso: string; endExclusiveIso: string } {
  const tz = "Asia/Tokyo";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayTokyo = fmt.format(new Date()); // yyyy-MM-dd
  const todayTokyoMidnight = new Date(`${todayTokyo}T00:00:00+09:00`);
  const startTokyo = new Date(todayTokyoMidnight.getTime() - 24 * 60 * 60 * 1000);
  const label = new Intl.DateTimeFormat("ja-JP", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(startTokyo);
  return { label, startIso: startTokyo.toISOString(), endExclusiveIso: todayTokyoMidnight.toISOString() };
}

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
  if (skuIdx < 0 || asinIdx < 0 || condIdx < 0) {
    return {
      rows: [],
      parseErrors: ["必須列が見つかりません（seller-sku / asin1 / item-condition）。レポート種別・言語設定を確認してください。"],
    };
  }
  const bySku = new Map<string, { sku: string; asin: string | null; condition_id: "New" | "Used" }>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const sku = toTrimmedString(cols[skuIdx]);
    if (!sku) continue;
    const asin = toTrimmedString(cols[asinIdx]) || null;
    const cond = conditionFromItemCondition(toTrimmedString(cols[condIdx]));
    bySku.set(sku, { sku, asin, condition_id: cond });
  }
  return { rows: [...bySku.values()], parseErrors: [] };
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

async function runListingReportDaily(): Promise<{ fetched: number; summary: string; metrics: Record<string, unknown> }> {
  const sp = createSpClient();
  const marketplaceId = "A1VC38T7YXB528";
  const reportType = "GET_MERCHANT_LISTINGS_ALL_DATA";
  const created = (await sp.callAPI({
    operation: "createReport",
    endpoint: "reports",
    body: {
      reportType,
      marketplaceIds: [marketplaceId],
      reportOptions: { preferredReportDocumentLocale: "en_US" },
    },
  })) as { reportId?: string };
  const reportId = String(created?.reportId ?? "").trim();
  if (!reportId) throw new Error("出品レポートの作成に失敗しました（reportIdが取得できません）");

  let reportDocumentId = "";
  let processingStatus = "";
  for (let i = 0; i < 60; i++) {
    const r = (await sp.callAPI({
      operation: "getReport",
      endpoint: "reports",
      path: { reportId },
    })) as { processingStatus?: string; reportDocumentId?: string };
    processingStatus = String(r?.processingStatus ?? "");
    reportDocumentId = String(r?.reportDocumentId ?? "");
    if (processingStatus === "DONE" && reportDocumentId) break;
    if (processingStatus === "CANCELLED" || processingStatus === "FATAL") {
      throw new Error(`出品レポートの生成に失敗しました (${processingStatus})`);
    }
    await new Promise((rr) => setTimeout(rr, 5000));
  }
  if (!reportDocumentId) throw new Error("出品レポートの生成がタイムアウトしました");

  const doc = (await sp.callAPI({
    operation: "getReportDocument",
    endpoint: "reports",
    path: { reportDocumentId },
  })) as { url?: string; compressionAlgorithm?: string };
  const url = String(doc?.url ?? "").trim();
  if (!url) throw new Error("出品レポートURLが取得できませんでした");

  const text = await fetchTextFromReportDocument(url, doc?.compressionAlgorithm);
  const parsed = parseListingReportTsv(text);
  if (parsed.parseErrors.length && parsed.rows.length === 0) throw new Error(parsed.parseErrors[0]);
  const { upserted, deletedStale } = await upsertSkuConditions(parsed.rows);
  const fetched = upserted;
  const summary = `出品レポート: 成功 / 辞書更新 ${upserted}件`;
  return { fetched, summary, metrics: { reportType, processingStatus, rows: parsed.rows.length, upserted, deletedStale, parseErrors: parsed.parseErrors.slice(0, 5) } };
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

async function runFinancesDaily(req: NextRequest): Promise<{ fetched: number; summary: string; metrics: Record<string, unknown> }> {
  const origin = originFromRequest(req);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const startDate = `${y}-${m}-${day}`;
  const endDate = new Date().toISOString().slice(0, 10);

  const res = await fetch(`${origin}/api/amazon/fetch-finances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate }),
  });
  const { json, raw } = await fetchJsonAnySafe(res);
  if (!res.ok) {
    const msg = (json && typeof json.error === "string" ? json.error : null) ?? raw.slice(0, 300) ?? "財務取得に失敗しました";
    throw new Error(msg);
  }
  const total = Number(json?.totalFetched ?? 0);
  const inserted = Number(json?.rowsInserted ?? 0);
  const skipped = Number(json?.rowsSkipped ?? 0);
  const fetched = total;
  const summary = `財務取得: 成功 / 取得 ${fetched}件`;
  return { fetched, summary, metrics: { startDate, endDate, totalFetched: total, rowsInserted: inserted, rowsSkipped: skipped, message: safeString(json?.message ?? "") } };
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
    } else if (jobKey === "finances_daily") {
      const r = await runFinancesDaily(req);
      fetched = r.fetched;
      summary = r.summary;
      metrics = { ...metrics, ...r.metrics };
    } else {
      summary = `${jobKey}: 未対応 / 取得 0件`;
      metrics = { ...metrics, notImplemented: true };
    }

    if (runReconcile) {
      const rec = await runAutoReconcile(req);
      metrics = { ...metrics, autoReconcile: rec };
    }

    await finishJob(jobId, { status: "success", metrics });
    // orders_poll は毎分実行のため通知を氾濫させない（日次サマリで別途通知）
    if (jobKey !== "orders_poll") {
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
      const day = dayBoundsTokyoYesterdayIso();

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

      // 2) 売上取得（財務）
      const totalFetched = Number((metrics as any).totalFetched ?? 0) || 0;
      const rowsInserted = Number((metrics as any).rowsInserted ?? 0) || 0;
      const rowsSkipped = Number((metrics as any).rowsSkipped ?? 0) || 0;
      await insertDashboardNotice({
        job_key: "fetch_finances_daily",
        result: "success",
        fetched: totalFetched,
        summary: `売上取得(日次 ${day.label}): 成功 / 取得 ${totalFetched}件（insert ${rowsInserted} / skip ${rowsSkipped}）`,
        metrics: { step: "fetch_finances", dayLabel: day.label, totalFetched, rowsInserted, rowsSkipped },
        error_code: null,
        error_message: null,
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

      // 5) 出品レポート（自動取得→辞書更新）
      try {
        const r = await runListingReportDaily();
        await insertDashboardNotice({
          job_key: "listing_report_daily",
          result: "success",
          fetched: Number((r.metrics as any).upserted ?? r.fetched ?? 0) || 0,
          summary: `出品レポート(日次 ${day.label}): 成功 / 辞書更新 ${Number((r.metrics as any).upserted ?? 0) || 0}件`,
          metrics: { step: "listing_report", dayLabel: day.label, ...r.metrics },
          error_code: null,
          error_message: null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "出品レポートに失敗しました";
        const code = extractHttpErrorCode(msg);
        await insertDashboardNotice({
          job_key: "listing_report_daily",
          result: "error",
          fetched: 0,
          summary: `出品レポート(日次 ${day.label}): 失敗 / 取得 0件`,
          metrics: { step: "listing_report", dayLabel: day.label },
          error_code: code,
          error_message: msg,
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
    if (jobKey !== "orders_poll") {
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

