"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AnalysisDay, SaleEvent, SalesAnalysis } from "@/lib/sales-analysis-types";

const emptyForm = { label: "", start_date: "", end_date: "", note: "" };
const series = [
  { key: "sessions", label: "セッション", color: "#047857" },
  { key: "buyBoxPercentage", label: "カート獲得率（%）", color: "#a16207" },
  { key: "trendValue", label: "Googleトレンド（0〜100）", color: "#9333ea" },
] as const;
const number = (v: number | null) => v === null ? "未取得" : v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
export default function SalesAnalysisChart() {
  const [data, setData] = useState<SalesAnalysis | null>(null), [events, setEvents] = useState<SaleEvent[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [editId, setEditId] = useState<number | null>(null), [form, setForm] = useState(emptyForm);
  const [visible, setVisible] = useState({ sessions: true, buyBoxPercentage: true, trendValue: true });
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [analysis, schedule] = await Promise.all([fetch("/api/dashboard/sales-analysis?days=90", { signal }), fetch("/api/dashboard/sale-events", { signal })]);
      if (!analysis.ok || !schedule.ok) throw new Error();
      setData(await analysis.json()); setEvents(await schedule.json()); setError("");
    } catch { if (!signal?.aborted) setError("日ごとの売上分析・セール日程を取得できませんでした。"); }
  }, []);
  useEffect(() => { const controller = new AbortController(); queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); }); return () => controller.abort(); }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch(`/api/dashboard/sale-events${editId === null ? "" : `/${editId}`}`, { method: editId === null ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!res.ok) { const body = await res.json(); throw new Error(body.error || "保存できませんでした"); }
      setForm(emptyForm); setEditId(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "保存できませんでした"); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    if (!window.confirm("このセール日程を削除しますか？")) return;
    setBusy(true);
    try { const res = await fetch(`/api/dashboard/sale-events/${id}`, { method: "DELETE" }); if (!res.ok) throw new Error(); if (editId === id) { setForm(emptyForm); setEditId(null); } await load(); }
    catch { setError("セール日程を削除できませんでした。"); } finally { setBusy(false); }
  }
  const days = data?.days ?? [], width = 1000, height = 300, left = 72, plot = 850, baseline = 240, top = 25;
  const x = (i: number) => left + (i + 0.5) * plot / Math.max(days.length, 1);
  const salesMax = Math.max(1, ...days.map(d => d.salesTotal ?? 0)), sessionsMax = Math.max(1, ...days.map(d => d.sessions ?? 0));
  const y = (value: number, max: number) => baseline - value / max * (baseline - top);
  // nullで線を切る。欠損を0や連続線で埋めない。
  function paths(key: "sessions" | "buyBoxPercentage" | "trendValue", max: number) {
    const chunks: string[] = []; let chunk = "";
    days.forEach((day, i) => { const value = day[key]; if (value === null) { if (chunk) chunks.push(chunk); chunk = ""; } else chunk += `${chunk ? " L" : "M"}${x(i)},${y(value, max)}`; });
    if (chunk) chunks.push(chunk); return chunks;
  }
  const columns: [keyof AnalysisDay, string][] = [["salesTotal", "売上（円）"], ["orderCount", "注文数"], ["sessions", "セッション"], ["buyBoxPercentage", "カート獲得率（%）"], ["trendValue", "トレンド"], ["topStockoutCount", "主力の在庫切れ数"]];
  return <section className="mb-8" aria-labelledby="sales-analysis-title">
    <h2 id="sales-analysis-title" className="mb-3 text-lg font-semibold">② 日ごとの売上分析</h2>
    <p className="mb-2 text-xs text-slate-600">Amazon注文ベース。棒＝売上（左軸・円）、緑線＝セッション（別尺度）、黄線＝カート獲得率・紫線＝トレンド（右軸0〜100）、青い帯＝セール日。未取得は空白です。</p>
    {error && <p role="alert" className="mb-3 text-red-700">{error}</p>}
    {!data && !error && <p role="status">売上分析を集計しています…</p>}
    {data && <>
      <p className="text-xs text-slate-600">{data.requestedStart}〜{data.requestedEnd} ／ 最新日 {data.latestAvailableDate ?? "未取得"} ／ 主力の対象期間 {data.topAsinWindow.start ?? "未取得"}〜{data.topAsinWindow.end ?? "未取得"} ／ 追跡数 {data.topAsinWindow.trackedCount}／30</p>
      <div className="my-2 flex flex-wrap gap-4 text-sm">{series.map(s => <label key={s.key} style={{ color: s.color }}><input type="checkbox" checked={visible[s.key]} onChange={e => setVisible(v => ({ ...v, [s.key]: e.target.checked }))} /> {s.label}</label>)}<span>セッション上端: {number(sessionsMax)}</span></div>
      <div className="overflow-x-auto rounded-xl border bg-white p-3"><svg viewBox={`0 0 ${width} ${height}`} className="min-w-[700px] w-full" role="img" aria-label="日別の売上・セッション・カート獲得率・Googleトレンド。数値は下の日次データ表で確認できます。">
        {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={left} x2={left + plot} y1={y(ratio, 1)} y2={y(ratio, 1)} stroke="#e2e8f0" /><text x={left - 6} y={y(ratio, 1) + 4} textAnchor="end" fontSize="11">{Math.round(salesMax * ratio).toLocaleString()}</text><text x={left + plot + 5} y={y(ratio, 1) + 4} fontSize="11">{ratio * 100}</text></g>)}
        {days.map((d, i) => <g key={d.date}>{d.saleEvents.length > 0 && <rect x={x(i) - plot / days.length / 2} y={top} width={plot / days.length} height={baseline - top} fill="#dbeafe"><title>{d.date}: {d.saleEvents.join("・")}</title></rect>}{d.salesTotal !== null && <rect x={x(i) - 2} y={y(d.salesTotal, salesMax)} width={4} height={baseline - y(d.salesTotal, salesMax)} fill="#2563eb"><title>{d.date}: {number(d.salesTotal)}円</title></rect>}{(i % 14 === 0 || i === days.length - 1) && <text x={x(i)} y={baseline + 22} textAnchor="middle" fontSize="11">{d.date.slice(5)}</text>}</g>)}
        {series.filter(s => visible[s.key]).map(s => <g key={s.key}>{paths(s.key, s.key === "sessions" ? sessionsMax : 100).map((path, i) => <path key={i} d={path} fill="none" stroke={s.color} strokeWidth="2" />)}{days.map((d, i) => d[s.key] === null ? null : <circle key={d.date} cx={x(i)} cy={y(d[s.key]!, s.key === "sessions" ? sessionsMax : 100)} r="1.6" fill={s.color}><title>{d.date} {s.label}: {number(d[s.key])}</title></circle>)}</g>)}
      </svg></div>
      <details className="mt-3 rounded-xl border bg-white p-4"><summary className="cursor-pointer font-medium">日次データ表（開く）</summary><div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr><th>日付</th>{columns.map(([key, label]) => <th key={key} className="whitespace-nowrap px-3">{label}</th>)}<th>セール日</th></tr></thead><tbody>{days.map(d => <tr key={d.date} className="border-t"><th className="whitespace-nowrap py-2 font-normal">{d.date}</th>{columns.map(([key]) => <td key={key} className="px-3 text-right tabular-nums">{number(d[key] as number | null)}</td>)}<td className="whitespace-nowrap">{d.saleEvents.join("・") || "—"}</td></tr>)}</tbody></table></div></details>
    </>}
    <div className="mt-4 rounded-xl border bg-white p-4"><h3 className="font-semibold">セール日程の入力</h3>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-3">{([ ["label", "名称", "text"], ["start_date", "開始日", "date"], ["end_date", "終了日", "date"], ["note", "メモ", "text"] ] as const).map(([key, label, type]) => <label key={key} className="flex flex-col gap-1 text-sm">{label}<input type={type} required={key !== "note"} maxLength={key === "note" ? 2000 : key === "label" ? 200 : undefined} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className="rounded border px-3 py-2" /></label>)}
      <button disabled={busy} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">{editId === null ? "追加" : "更新"}</button>{editId !== null && <button type="button" disabled={busy} onClick={() => { setEditId(null); setForm(emptyForm); }}>編集をやめる</button>}</form>
      <ul className="mt-4 space-y-2 text-sm">{events.map(e => <li key={e.id} className="flex flex-wrap items-center gap-3"><span>{e.start_date}〜{e.end_date} {e.label} {e.note}</span><button disabled={busy} className="text-blue-700 underline" onClick={() => { setEditId(e.id); setForm({ label: e.label, start_date: e.start_date, end_date: e.end_date, note: e.note ?? "" }); }}>編集</button><button disabled={busy} className="text-red-700 underline" onClick={() => void remove(e.id)}>削除</button></li>)}</ul>
    </div>
  </section>;
}
