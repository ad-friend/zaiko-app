"use client";

import { useCallback, useState } from "react";
import { Ban } from "lucide-react";
import {
  EXIT_TYPE_INTERNAL_DAMAGE,
  EXIT_TYPE_INTERNAL_USE,
  EXIT_TYPE_LOSS,
  EXIT_TYPE_PROMO_ENTERTAINMENT,
  type QuickAdjustExitType,
} from "@/lib/inbound-stock-status";

const cardBase =
  "rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md";

const EXIT_OPTIONS: { value: QuickAdjustExitType; label: string }[] = [
  { value: EXIT_TYPE_INTERNAL_DAMAGE, label: "破損" },
  { value: EXIT_TYPE_LOSS, label: "紛失" },
  { value: EXIT_TYPE_INTERNAL_USE, label: "社内使用" },
  { value: EXIT_TYPE_PROMO_ENTERTAINMENT, label: "接待・販促" },
];

function exitLabel(v: QuickAdjustExitType): string {
  return EXIT_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

const btnClass =
  "inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

export default function QuickInventoryAdjustment() {
  const [jan, setJan] = useState("");
  const [condition, setCondition] = useState<"new" | "used">("new");
  const [exitType, setExitType] = useState<QuickAdjustExitType>(EXIT_TYPE_INTERNAL_DAMAGE);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    const j = jan.trim();
    if (!j) {
      setError("JANコードを入力してください");
      setSuccess(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/inventory-adjustment/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jan_code: j,
          condition_type: condition,
          exit_type: exitType,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        jan_code?: string;
        condition_type?: string;
        exit_type?: string;
        applied_price?: number;
      };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : `エラー (${res.status})`);
      }
      const condJa = data.condition_type === "used" ? "中古" : "新品";
      const reason = data.exit_type ? exitLabel(data.exit_type as QuickAdjustExitType) : exitLabel(exitType);
      const price = typeof data.applied_price === "number" ? Math.round(data.applied_price) : 0;
      setSuccess(
        `JAN: ${data.jan_code ?? j}（${condJa}）を [${reason}] として1件除外しました（適用価格: ¥${price.toLocaleString("ja-JP")}）`
      );
      setJan("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }, [jan, condition, exitType]);

  return (
    <section className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Ban className="h-4 w-4 text-amber-700" />
        クイック在庫除外（破損・紛失等）
      </h2>
      <div className={`${cardBase} border-amber-200/70 bg-amber-50/20`}>
        <p className="text-xs text-slate-600 leading-relaxed mb-4">
          同一JAN・同一コンディションの<strong className="font-semibold text-slate-800">未引当・販売可能</strong>
          在庫のうち、<strong className="font-semibold text-slate-800">原価（effective_unit_price）が最も安い1件</strong>
          を優先して除外します。同額の場合は登録が古い行から処理します。
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="min-w-0 flex-1 sm:min-w-[200px]">
            <label htmlFor="quick-adj-jan" className="block text-xs font-semibold text-slate-700 mb-1">
              JANコード
            </label>
            <input
              id="quick-adj-jan"
              type="text"
              value={jan}
              onChange={(e) => setJan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void run();
                }
              }}
              placeholder="スキャンまたは入力"
              disabled={submitting}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-mono text-slate-900 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
            />
          </div>
          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-1">コンディション</span>
            <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setCondition("new")}
                className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                  condition === "new"
                    ? "bg-white text-emerald-800 shadow-sm ring-1 ring-emerald-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                New
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setCondition("used")}
                className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                  condition === "used"
                    ? "bg-white text-violet-900 shadow-sm ring-1 ring-violet-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Used
              </button>
            </div>
          </div>
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="quick-adj-exit" className="block text-xs font-semibold text-slate-700 mb-1">
              除外理由
            </label>
            <select
              id="quick-adj-exit"
              value={exitType}
              onChange={(e) => setExitType(e.target.value as QuickAdjustExitType)}
              disabled={submitting}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
            >
              {EXIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void run()}
            disabled={submitting}
            className={`${btnClass} h-10 w-full sm:w-auto shrink-0 bg-amber-700 px-5 text-sm text-white hover:bg-amber-800 focus-visible:ring-amber-600`}
          >
            {submitting ? "処理中…" : "1件除外する"}
          </button>
        </div>
        {success ? (
          <p
            className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            role="status"
          >
            {success}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
