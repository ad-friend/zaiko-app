"use client";
import { useEffect, useState } from "react";
import type { WeeklySummary } from "@/lib/sales-analysis-types";

export default function WeeklyHighlights() {
  const [data, setData] = useState<WeeklySummary | null>(null), [error, setError] = useState(false);
  useEffect(() => { const controller = new AbortController(); void fetch("/api/dashboard/weekly-summary", { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error(); setData(await response.json()); }).catch(() => { if (!controller.signal.aborted) setError(true); }); return () => controller.abort(); }, []);
  const format = (n: number | null | undefined, digits = 0) => n == null ? "未取得" : n.toLocaleString("ja-JP", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const cards = data ? [
    { label: "売上", value: `${format(data.thisWeek.salesTotal)} 円`, delta: data.deltaPercent.salesTotal, unit: "%", lowerBetter: false },
    { label: "注文数", value: `${format(data.thisWeek.orderCount)} 件`, delta: data.deltaPercent.orderCount, unit: "%", lowerBetter: false },
    { label: "カート獲得率（日率平均）", value: `${format(data.thisWeek.buyBoxPercentage, 1)} %`, delta: data.delta.buyBoxPercentagePoint, unit: "ポイント", lowerBetter: false },
    { label: "主力の在庫切れ（週平均）", value: `${format(data.thisWeek.topStockoutAvg, 1)} 点`, delta: data.delta.topStockoutAvg, unit: "点", lowerBetter: true },
  ] : [];
  return <section className="mb-8" aria-labelledby="weekly-highlights-title">
    <h2 id="weekly-highlights-title" className="mb-3 text-lg font-semibold">① 今週の要点</h2>
    {error ? <p role="alert">週の要点を取得できませんでした。</p> : !data ? <p role="status">週の要点を集計しています…</p> : <>
      <p className="mb-3 text-sm text-slate-600">{data.thisWeek.label}: {data.thisWeek.rangeStart}〜{data.thisWeek.rangeEnd} ／ 前週: {data.lastWeek.rangeStart}〜{data.lastWeek.rangeEnd} ／ データ最新日: {data.dataAsOf ?? "未取得"}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{cards.map(card => <div key={card.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">{card.label}</p><p className="mt-2 text-2xl font-bold tabular-nums">{card.value}</p>
        <p className={`mt-2 text-sm ${card.delta == null || card.delta === 0 ? "text-slate-500" : (card.lowerBetter ? card.delta < 0 : card.delta > 0) ? "text-emerald-700" : "text-red-700"}`}>{card.delta == null ? "比較できる値が揃っていません" : `前週比 ${card.delta > 0 ? "↑" : card.delta < 0 ? "↓" : "→"} ${format(Math.abs(card.delta), 1)} ${card.unit}`}</p>
      </div>)}</div>
      {!data.comparable && <p className="mt-2 text-sm text-slate-600">比較できる日数・曜日が揃っていません。</p>}
      <p className="mt-2 text-xs text-slate-500">在庫の追跡数 {data.thisWeek.trackedAsinCount}／30。{data.note}</p>
    </>}
  </section>;
}
