"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { normalizeStockCondition } from "@/lib/amazon-condition-match";

type ReturnInspectionRow = {
  id: number;
  jan_code: string | null;
  product_name: string | null;
  condition_type: string | null;
  stock_status: string | null;
  created_at: string | null;
};

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

function initialListingCondition(raw: string | null | undefined): "new" | "used" {
  return normalizeStockCondition(raw) === "used" ? "used" : "new";
}

function ReturnInspectionCard({
  row,
  onConfirmed,
}: {
  row: ReturnInspectionRow;
  onConfirmed: (id: number) => void;
}) {
  const [cond, setCond] = useState<"new" | "used">(() => initialListingCondition(row.condition_type));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const condToggleClass =
    "inline-flex items-center justify-center rounded-md border px-2.5 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-45 min-h-[38px] sm:px-3 sm:text-[13px]";

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/return-inspection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, condition_type: cond }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "更新に失敗しました");
      onConfirmed(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-w-0 w-full rounded-lg border-2 border-rose-200/90 bg-rose-50/30 p-4 lg:p-5 shadow-sm">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">在庫 ID</p>
            <p className="font-mono text-sm font-bold text-slate-900 tabular-nums">{row.id}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-slate-400">JAN</p>
            <p className="break-all font-mono text-sm font-semibold text-slate-800">{row.jan_code ?? "—"}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-slate-400">登録日</p>
            <p className="text-sm tabular-nums text-slate-700">
              {row.created_at ? row.created_at.slice(0, 10) : "—"}
            </p>
          </div>
        </div>
        {row.product_name ? (
          <p className="text-xs leading-snug text-slate-600 line-clamp-2" title={row.product_name}>
            {row.product_name}
          </p>
        ) : null}

        <div className="rounded-lg border border-rose-100 bg-white/80 p-3 space-y-2.5">
          <p className="text-xs font-bold text-slate-700">コンディション（再判定）</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={submitting}
              onClick={() => setCond("new")}
              className={`${condToggleClass} ${
                cond === "new"
                  ? "border-emerald-400 bg-emerald-100 text-emerald-950 ring-2 ring-emerald-300/60"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              新品（New）
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setCond("used")}
              className={`${condToggleClass} ${
                cond === "used"
                  ? "border-violet-400 bg-violet-100 text-violet-950 ring-2 ring-violet-300/60"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              中古（Used）
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            現在のDB値: <span className="font-mono">{row.condition_type ?? "—"}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className={`${buttonClass} w-full bg-rose-600 text-sm font-bold text-white hover:bg-rose-700 disabled:bg-slate-300`}
        >
          {submitting ? "処理中…" : "在庫として再登録"}
        </button>
        {error ? <p className="text-xs font-medium text-red-700">{error}</p> : null}
      </div>
    </div>
  );
}

export default function ReturnInspectionQueueSection() {
  const [items, setItems] = useState<ReturnInspectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/amazon/return-inspection");
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "一覧の取得に失敗しました");
      }
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const removeItem = (id: number) => {
    setItems((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-7 lg:p-8 shadow-sm relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1.5 h-full bg-rose-500" />
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-rose-100 p-2 text-rose-700">
            <ClipboardList className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h3 className="text-lg lg:text-xl font-bold text-slate-800">STEP: 返品・検品待ち（イレギュラー）</h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed max-w-3xl">
              返品レポート取り込みで解放された在庫はここに滞留します。コンディションを確認のうえ「在庫として再登録」で通常の販売可能在庫（
              <span className="font-mono text-xs">stock_status=available</span>
              ）に戻してください。
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={`${buttonClass} shrink-0 border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 text-sm h-9 px-4`}
        >
          {loading ? "読込中…" : "再読込"}
        </button>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-red-200 bg-red-50/80 p-3 text-sm text-red-800 mb-4">{loadError}</div>
      ) : null}

      {loading ? (
        <p className="text-slate-500 text-sm">読み込み中…</p>
      ) : items.length === 0 ? (
        <p className="text-slate-500 text-sm">検品待ちの在庫はありません。</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2 xl:grid-cols-3">
          {items.map((row) => (
            <ReturnInspectionCard key={row.id} row={row} onConfirmed={removeItem} />
          ))}
        </div>
      )}
    </div>
  );
}
