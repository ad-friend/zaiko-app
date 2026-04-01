"use client";

import { useState } from "react";
import { Bell, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import type { DashboardNoticeRow } from "@/lib/dashboard-types";

const MAX_ORDER_LINKS = 28;

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function CronJobNotice({
  notice,
  onDismissed,
}: {
  notice: DashboardNoticeRow;
  onDismissed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const p = notice.payload ?? {};
  const jobKey = String((p as any).job_key ?? "").trim();
  const summary = String((p as any).summary ?? "").trim();
  const fetched = asNumber((p as any).fetched, 0);
  const errorCode = String((p as any).error_code ?? "").trim();
  const errorMessage = String((p as any).error_message ?? "").trim();
  const metrics = (p as any).metrics && typeof (p as any).metrics === "object" ? (p as any).metrics : null;

  const dismiss = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/dashboard/notices/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: notice.id }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "更新に失敗しました");
      onDismissed();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const oneLine = summary || `${jobKey || "cron"}: ${notice.notice_type} / 取得 ${fetched}件`;

  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left"
        aria-expanded={open}
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 shrink-0 rounded-lg p-2 ${notice.notice_type === "cron_job_error" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
            <Bell className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900">{oneLine}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {notice.created_at ? new Date(notice.created_at).toLocaleString("ja-JP") : ""}
            </p>
          </div>
          <ChevronDown className={`h-5 w-5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </div>
      </button>

      {open ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-xs text-slate-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-mono text-[11px] text-slate-600">job_key: {jobKey || "—"}</p>
              {errorCode || errorMessage ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-red-800">
                  <p className="font-semibold">エラー</p>
                  {errorCode ? <p className="mt-1 font-mono">code: {errorCode}</p> : null}
                  {errorMessage ? <p className="mt-1 whitespace-pre-wrap break-words">{errorMessage}</p> : null}
                </div>
              ) : null}
              {metrics ? (
                <details className="rounded-md border border-slate-200 bg-white px-2.5 py-2">
                  <summary className="cursor-pointer select-none text-[11px] font-semibold text-slate-700">
                    詳細（metrics）
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-2 text-[10px] text-slate-100">
                    {JSON.stringify(metrics, null, 2)}
                  </pre>
                </details>
              ) : null}
              {localError ? <p className="text-xs font-medium text-red-700">{localError}</p> : null}
            </div>
            <div className="shrink-0">
              <button
                type="button"
                onClick={() => void dismiss()}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-900 disabled:opacity-50 sm:w-auto"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                確認（非表示）
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AmazonDuplicateImportNotice({
  notice,
  onDismissed,
}: {
  notice: DashboardNoticeRow;
  onDismissed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const p = notice.payload;
  const merged = asNumber(p.duplicate_lines_merged, 0);
  const orderIds = asStringArray(p.amazon_order_ids);
  const totalOrders = asNumber(p.amazon_order_id_count, orderIds.length);
  const truncatedList = Boolean(p.truncated);
  const received = asNumber(p.received, 0);
  const upserted = asNumber(p.upserted, 0);

  const dismiss = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/dashboard/notices/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: notice.id }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "更新に失敗しました");
      onDismissed();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const showIds = orderIds.slice(0, MAX_ORDER_LINKS);
  const moreCount = Math.max(0, totalOrders - showIds.length);

  return (
    <div
      className="mb-6 rounded-xl border border-amber-300/90 bg-amber-50/90 px-4 py-4 shadow-sm"
      role="status"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="mt-0.5 shrink-0 rounded-lg bg-amber-200/80 p-2 text-amber-900">
            <Bell className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-2 text-sm text-amber-950">
            <p className="font-bold text-amber-950">お知らせ: 注文レポートで重複行を1件にまとめました</p>
            <p className="leading-relaxed text-amber-950/95">
              <span className="font-semibold">症状:</span> 同一の Amazon 注文番号＋SKU の行が CSV 内に複数あり、DB の制約のため{" "}
              <span className="font-mono font-semibold tabular-nums">{merged}</span> 行をマージして登録しました（数量は合算）。
              ごくまれに、明細の重複やレポート仕様により<strong>表示上の数量・在庫とのずれ</strong>が気になることがあります。
            </p>
            <p className="leading-relaxed text-amber-950/95">
              <span className="font-semibold">対応の目安:</span> 下記の注文を{" "}
              <span className="font-medium">Amazon セラーセントラルの注文詳細</span>で開き、明細・数量を確認してください。
            </p>
            <p className="text-xs text-amber-900/85 tabular-nums">
              取込ファイルの有効行: {received.toLocaleString("ja-JP")} / 今回の DB 登録行数（マージ後）: {upserted.toLocaleString("ja-JP")}
            </p>
            {totalOrders > 0 ? (
              <div className="rounded-lg border border-amber-200/80 bg-white/70 px-3 py-2">
                <p className="text-xs font-semibold text-amber-900 mb-2">
                  マージの対象となった注文（最大 {showIds.length} 件表示
                  {moreCount > 0 || truncatedList ? ` / 全 ${totalOrders} 件` : ""}）
                </p>
                <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
                  {showIds.map((oid) => (
                    <li key={oid} className="min-w-0">
                      <a
                        href={`https://sellercentral.amazon.co.jp/orders-v3/order/${encodeURIComponent(oid)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 font-mono text-amber-900 underline decoration-amber-600/60 hover:text-amber-950"
                      >
                        <span className="truncate">{oid}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
                      </a>
                    </li>
                  ))}
                </ul>
                {(moreCount > 0 || (truncatedList && totalOrders > showIds.length)) && (
                  <p className="mt-2 text-[11px] text-amber-800/90">
                    他 {moreCount > 0 ? `${moreCount} 件` : ""}
                    {truncatedList ? "（一覧は長いため一部のみ保存・表示しています）" : ""}
                  </p>
                )}
              </div>
            ) : null}
            {localError ? <p className="text-xs font-medium text-red-700">{localError}</p> : null}
          </div>
        </div>
        <div className="shrink-0 sm:pt-1">
          <button
            type="button"
            onClick={() => void dismiss()}
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-800 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-900 disabled:opacity-50 sm:w-auto"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            内容を確認しました
          </button>
          <p className="mt-1.5 text-center text-[10px] text-amber-900/70 sm:text-left">押すとこのお知らせを非表示にします</p>
        </div>
      </div>
    </div>
  );
}

type Props = {
  notices: DashboardNoticeRow[];
  onAfterDismiss: () => void;
};

export default function DashboardNotices({ notices, onAfterDismiss }: Props) {
  const duplicateNotices = notices.filter((n) => n.notice_type === "amazon_order_import_duplicate_lines");
  const cronNotices = notices.filter((n) => n.notice_type === "cron_job_success" || n.notice_type === "cron_job_error");
  if (duplicateNotices.length === 0 && cronNotices.length === 0) return null;

  return (
    <section className="mb-2" aria-label="ダッシュボードお知らせ">
      {cronNotices.map((n) => (
        <CronJobNotice key={n.id} notice={n} onDismissed={onAfterDismiss} />
      ))}
      {duplicateNotices.map((n) => (
        <AmazonDuplicateImportNotice key={n.id} notice={n} onDismissed={onAfterDismiss} />
      ))}
    </section>
  );
}
