/**
 * Vercel Cron 用エンドポイント（サーバ側で処理を完走させる）
 * - Authorization: Bearer ${CRON_SECRET}
 * - GET /api/cron/run?jobKey=orders_poll
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

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
  return { fetched, summary, metrics: { minutes, rowsUpserted: fetched, message: safeString(json?.message ?? "") } };
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

async function runAutoReconcile(req: NextRequest, maxRounds = 120, batchSizeOrders = 10): Promise<{ reconciled: number; skipped: number }> {
  const origin = originFromRequest(req);
  let reconciled = 0;
  let skipped = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const res = await fetch(`${origin}/api/amazon/reconcile-sales`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchSizeOrders }),
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
    await insertDashboardNotice({
      job_key: jobKey,
      result: "success",
      fetched,
      summary,
      metrics,
      error_code: null,
      error_message: null,
    });

    return NextResponse.json({ ok: true, jobKey, fetched, summary, metrics });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Cron job failed";
    const code = extractHttpErrorCode(message);
    const fetched = 0;
    const summary = `${jobKey}: 失敗${code ? `(${code})` : ""} / 取得 ${fetched}件`;
    await finishJob(jobId, { status: "error", metrics: { startedAt }, error_code: code, error_message: message });
    await insertDashboardNotice({
      job_key: jobKey,
      result: "error",
      fetched,
      summary,
      metrics: { startedAt },
      error_code: code,
      error_message: message,
    });
    return NextResponse.json({ error: message, jobKey }, { status: 500 });
  }
}

