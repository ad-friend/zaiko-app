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
    "inline-flex flex-1 items-center justify-center rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-45 min-h-[34px]";

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
    <div className="min-w-0 w-full rounded-lg border border-rose-200/90 bg-rose-50/40 p-3 shadow-sm">
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">在庫 ID</p>
            <p className="font-mono text-xs font-bold text-slate-900 tabular-nums">{row.id}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-1.5 text-xs">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-slate-400">JAN</p>
            <p className="break-all font-mono font-semibold text-slate-800">{row.jan_code ?? "—"}</p>
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-slate-400">登録日</p>
            <p className="tabular-nums text-slate-700">
              {row.created_at ? row.created_at.slice(0, 10) : "—"}
            </p>
          </div>
        </div>
        {row.product_name ? (
          <p className="text-xs leading-snug text-slate-600 line-clamp-2" title={row.product_name}>
            {row.product_name}
          </p>
        ) : null}

        <div className="rounded-lg border border-rose-100 bg-white/90 p-2.5 space-y-2">
          <p className="text-[11px] font-bold text-slate-700">コンディション（再判定）</p>
          <div className="flex gap-1.5">
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
          <p className="text-[10px] text-slate-500 leading-snug">
            DB: <span className="font-mono">{row.condition_type ?? "—"}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className={`${buttonClass} h-9 w-full bg-rose-600 text-xs font-bold text-white hover:bg-rose-700 disabled:bg-slate-300 px-3`}
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
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full bg-rose-500" />
      <div className="pl-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3 mb-3">
          <div className="flex items-start gap-2 min-w-0">
            <div className="rounded-md bg-rose-100 p-1.5 text-rose-700 shrink-0">
              <ClipboardList className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-800 leading-snug">
                返品・検品待ち（在庫）
              </h3>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                STEP 5 の財務イレギュラーとは別枠です。返品取り込みで滞留した在庫を確認し、再登録で販売可能に戻します。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={`${buttonClass} w-full sm:w-auto shrink-0 border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100 text-xs h-8 px-3`}
          >
            {loading ? "読込中…" : "再読込"}
          </button>
        </div>

        {loadError ? (
          <div className="rounded-lg border border-red-200 bg-red-50/80 p-2 text-xs text-red-800 mb-3">{loadError}</div>
        ) : null}

        {loading ? (
          <p className="text-xs text-slate-500 py-2">読み込み中…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 py-4 px-2 text-center">
            <p className="text-xs text-slate-500">検品待ちの在庫はありません。</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3 min-w-0">
            {items.map((row) => (
              <li key={row.id} className="min-w-0">
                <ReturnInspectionCard row={row} onConfirmed={removeItem} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
