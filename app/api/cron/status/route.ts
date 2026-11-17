/**
 * 自動処理（cron_jobs）の記録を読むだけの入口（2026-11-17 相談-12）。
 * 窓口の AI と毎朝の Telegram 報告（PC）が、各ジョブの成功・失敗・エラーの中身を確かめるために使う。
 * 書き込みはしない。認証は TRENDS_IMPORT_SECRET の Bearer（PC にすでにある合い言葉を共用）。
 * GET /api/cron/status?hours=24   （1〜168 時間、既定 24）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireTrendsImportAuth } from "@/lib/trends-import-auth";

export const dynamic = "force-dynamic";

type JobRow = {
  job_key: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  metrics: unknown;
};

export async function GET(req: NextRequest) {
  const auth = requireTrendsImportAuth(req.headers.get("authorization"));
  if (auth !== 200) return NextResponse.json({ error: auth === 401 ? "unauthorized" : "not configured" }, { status: auth });

  const raw = Number(req.nextUrl.searchParams.get("hours") ?? 24);
  const hours = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 168) : 24;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from("cron_jobs")
    .select("job_key, status, started_at, finished_at, error_code, error_message, metrics")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: "cron_jobs を読めませんでした" }, { status: 500 });

  const rows = (data ?? []) as JobRow[];
  const byJob: Record<string, { runs: number; success: number; error: number; running: number; last: JobRow | null; lastError: JobRow | null }> = {};
  for (const r of rows) {
    const s = (byJob[r.job_key] ??= { runs: 0, success: 0, error: 0, running: 0, last: null, lastError: null });
    s.runs += 1;
    if (r.status === "success") s.success += 1;
    else if (r.status === "error") s.error += 1;
    else s.running += 1;
    s.last ??= r;
    if (r.status === "error") s.lastError ??= r;
  }
  const trim = (r: JobRow | null) =>
    r && { status: r.status, started_at: r.started_at, finished_at: r.finished_at, error_code: r.error_code, error_message: r.error_message ? r.error_message.slice(0, 300) : null };

  return NextResponse.json({
    hours,
    since,
    jobs: Object.fromEntries(
      Object.entries(byJob).map(([k, s]) => [k, { runs: s.runs, success: s.success, error: s.error, running: s.running, last: trim(s.last), lastError: trim(s.lastError), lastMetrics: s.last?.metrics ?? null }]),
    ),
  });
}
