"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  LayoutDashboard,
  Loader2,
  RefreshCw,
  AlertCircle,
  Package,
  TrendingUp,
  TrendingDown,
  Wallet,
  ShoppingCart,
  PieChart,
  Table2,
} from "lucide-react";
import type { DashboardPayload, MonthlyDashboardPayload } from "@/lib/dashboard-types";
import DashboardNotices from "@/components/DashboardNotices";
import QuickInventoryAdjustment from "@/components/QuickInventoryAdjustment";

function formatYen(n: number): string {
  const rounded = Math.round(n);
  return `${rounded.toLocaleString("ja-JP")} 円`;
}

function formatYenCompact(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

function formatCount(n: number): string {
  return `${n.toLocaleString("ja-JP")} 個`;
}

function formatCountCompact(n: number): string {
  return n.toLocaleString("ja-JP");
}

const cardBase =
  "rounded-xl border border-slate-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md";
const cardTitle = "text-xs font-semibold uppercase tracking-wide text-slate-500";
const cardValue = "mt-2 text-2xl font-bold tabular-nums tracking-tight text-slate-900 sm:text-3xl";
const cardSub = "mt-1 text-sm text-slate-500";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [monthlyFrom, setMonthlyFrom] = useState("");
  const [monthlyTo, setMonthlyTo] = useState("");
  const [monthlyData, setMonthlyData] = useState<MonthlyDashboardPayload | null>(null);
  const [monthlyLoading, setMonthlyLoading] = useState(true);
  const [monthlyError, setMonthlyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `取得に失敗しました (${res.status})`);
      }
      setData((await res.json()) as DashboardPayload);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMonthly = useCallback(async (from?: string, to?: string) => {
    setMonthlyLoading(true);
    setMonthlyError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      const res = await fetch(`/api/dashboard/monthly${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `月次データの取得に失敗しました (${res.status})`);
      }
      const payload = (await res.json()) as MonthlyDashboardPayload;
      setMonthlyData(payload);
      setMonthlyFrom(payload.from);
      setMonthlyTo(payload.to);
    } catch (e) {
      setMonthlyData(null);
      setMonthlyError(e instanceof Error ? e.message : "月次データの読み込みに失敗しました");
    } finally {
      setMonthlyLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadMonthly();
  }, [load, loadMonthly]);

  const handleMonthlySubmit = (e: FormEvent) => {
    e.preventDefault();
    void loadMonthly(monthlyFrom, monthlyTo);
  };

  return (
    <div className="flex-1 flex flex-col">
      <main className="flex-1 py-8 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
              <span className="rounded-lg bg-primary/10 p-2 text-primary">
                <LayoutDashboard className="h-6 w-6" />
              </span>
              経営ダッシュボード
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              売上・原価は <span className="font-medium text-slate-800">在庫引当時（inbound_items.settled_at）</span> を基準に集計しています。財務明細は{" "}
              <span className="font-medium text-slate-800">同じ注文ID・当月の posted_date</span> に限定しています。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            再読み込み
          </button>
        </div>

        {loading && !data && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className={`${cardBase} animate-pulse`}>
                <div className="h-3 w-24 rounded bg-slate-200" />
                <div className="mt-4 h-8 w-40 rounded bg-slate-100" />
                <div className="mt-2 h-4 w-28 rounded bg-slate-100" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div>
              <p className="font-semibold">データを取得できませんでした</p>
              <p className="mt-1 text-red-800/90">{error}</p>
            </div>
          </div>
        )}

        {data && (
          <>
            <QuickInventoryAdjustment />

            <p className="mb-4 text-sm font-medium text-slate-600">
              集計期間（当月・東京）: <span className="text-slate-900">{data.period.label}</span>
            </p>

            <section className="mb-6">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Package className="h-4 w-4 text-primary" />
                現在の総資産（在庫）
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className={cardBase}>
                  <p className={cardTitle}>総在庫数</p>
                  <p className={cardValue}>{formatCount(data.inventory.count)}</p>
                  <p className={cardSub}>未販売・未調整（settled_at / exit_type が NULL）</p>
                </div>
                <div className={cardBase}>
                  <p className={cardTitle}>総在庫金額（原価ベース）</p>
                  <p className={cardValue}>{formatYen(data.inventory.totalAmount)}</p>
                  <p className={cardSub}>effective_unit_price の合計</p>
                </div>
              </div>
            </section>

            <section className="mb-6">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <ShoppingCart className="h-4 w-4 text-primary" />
                当月の動き
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className={cardBase}>
                  <p className={cardTitle}>当月仕入</p>
                  <p className={cardValue}>{formatCount(data.monthlyPurchase.count)}</p>
                  <p className={cardSub}>金額 {formatYen(data.monthlyPurchase.totalAmount)}</p>
                </div>
                <div className={cardBase}>
                  <p className={cardTitle}>当月損失・経費相当</p>
                  <p className={cardValue}>{formatCount(data.monthlyLoss.count)}</p>
                  <p className={cardSub}>金額 {formatYen(data.monthlyLoss.totalAmount)}</p>
                  <p className="mt-2 text-xs text-amber-700/90">
                    月次判定は registered_at を使用しています（調整日とずれる場合は exit_at 列の追加を検討してください）。
                  </p>
                </div>
                <div className={cardBase}>
                  <p className={cardTitle}>当月販売（確定済み）</p>
                  <p className={cardValue}>{formatCount(data.monthlySettled.soldCount)}</p>
                  <p className={cardSub}>settled_at が当月の明細件数</p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <PieChart className="h-4 w-4 text-primary" />
                当月の売上・利益（確定ベース）
              </h2>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className={cardBase}>
                    <p className={cardTitle}>販売原価</p>
                    <p className={cardValue}>{formatYen(data.monthlySettled.costOfGoodsSold)}</p>
                    <p className={cardSub}>当月 settled の effective_unit_price 合計</p>
                  </div>
                  <div className={cardBase}>
                    <p className={cardTitle}>売上額（Charge / Sell）</p>
                    <p className={`${cardValue} text-emerald-700`}>{formatYen(data.monthlySettled.revenue)}</p>
                    <p className={cardSub}>sales_transactions・当月 posted_date</p>
                  </div>
                  <div className={cardBase}>
                    <p className={cardTitle}>手数料等（Fee 系）</p>
                    <p
                      className={`${cardValue} ${
                        data.monthlySettled.feesAndAdjustments < 0 ? "text-slate-700" : "text-slate-600"
                      }`}
                    >
                      {formatYen(data.monthlySettled.feesAndAdjustments)}
                    </p>
                    <p className={cardSub}>Fee / FeeAdjustment / ChargeAdjustment の合計</p>
                  </div>
                  <div className={`${cardBase} ring-2 ring-primary/20`}>
                    <p className={cardTitle}>当月利益（概算）</p>
                    <p
                      className={`${cardValue} flex items-center gap-2 ${
                        data.monthlySettled.profit < 0 ? "text-red-600" : "text-primary"
                      }`}
                    >
                      {data.monthlySettled.profit < 0 ? (
                        <TrendingDown className="h-7 w-7 shrink-0" aria-hidden />
                      ) : (
                        <TrendingUp className="h-7 w-7 shrink-0" aria-hidden />
                      )}
                      {formatYen(data.monthlySettled.profit)}
                    </p>
                    <p className={cardSub}>
                      （売上 + 手数料等）− 販売原価 − 当月損失額
                    </p>
                  </div>
                </div>
                <div className={`${cardBase} flex flex-col justify-center bg-slate-50/80`}>
                  <div className="flex items-center gap-2 text-slate-700">
                    <Wallet className="h-5 w-5 text-primary" />
                    <span className="text-sm font-semibold">計算式</span>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-slate-600 leading-relaxed">
                    <li>
                      <span className="font-medium text-slate-800">売上</span> … Charge / Sell の合計
                    </li>
                    <li>
                      <span className="font-medium text-slate-800">手数料等</span> … 多くはマイナス（マーケットプレイス控除）
                    </li>
                    <li>
                      <span className="font-medium text-slate-800">利益</span> … 売上 + 手数料等 − 販売原価 − 損失額
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <section className="mb-8 mt-10">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Table2 className="h-4 w-4 text-primary" />
                月次一覧
              </h2>
              <p className="mb-4 text-sm text-slate-600">
                売上・入金・消費税は <span className="font-medium text-slate-800">sales_transactions.posted_date</span> 基準。
                販売個数・原価は <span className="font-medium text-slate-800">settled_at</span> 基準。
                月末在庫は履歴スナップショットがないため再計算です（上段の当月カードと数値が異なる場合があります）。
              </p>

              <form
                onSubmit={handleMonthlySubmit}
                className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm"
              >
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700">開始月</span>
                  <input
                    type="month"
                    value={monthlyFrom}
                    onChange={(e) => setMonthlyFrom(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium text-slate-700">終了月</span>
                  <input
                    type="month"
                    value={monthlyTo}
                    onChange={(e) => setMonthlyTo(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                  />
                </label>
                <button
                  type="submit"
                  disabled={monthlyLoading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
                >
                  {monthlyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  表示
                </button>
              </form>

              {monthlyError && (
                <div
                  className="mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                  <p>{monthlyError}</p>
                </div>
              )}

              {monthlyLoading && !monthlyData && (
                <div className="rounded-xl border border-slate-200/80 bg-white p-8 text-center text-sm text-slate-500">
                  <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-primary" />
                  月次データを集計しています…
                </div>
              )}

              {monthlyData && (
                <div className="overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-sm">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                        <th className="whitespace-nowrap px-4 py-3">月</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">売上総額</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">消費税</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">仕入金額</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">月末在庫金額</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">月末在庫数</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">販売個数</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">入金額</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">利益額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyData.rows.map((row) => (
                        <tr key={row.period.dateStart} className="border-b border-slate-100 hover:bg-slate-50/50">
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">{row.period.label}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatYenCompact(row.salesTotal)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatYenCompact(row.consumptionTax)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatYenCompact(row.monthlyPurchase.totalAmount)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatYenCompact(row.inventoryAtMonthEnd.totalAmount)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatCountCompact(row.inventoryAtMonthEnd.count)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatCountCompact(row.soldCount)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-slate-800">
                            {formatYenCompact(row.netDeposit)}
                          </td>
                          <td
                            className={`whitespace-nowrap px-4 py-3 text-right tabular-nums font-medium ${
                              row.profit < 0 ? "text-red-600" : "text-primary"
                            }`}
                          >
                            {formatYenCompact(row.profit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
                    利益 = 入金額 − 販売原価 − 当月損失。売上総額は Principal + Sell（消費税除く）。入金額は sales_transactions 全行合計。単位: 円 / 個。
                  </p>
                </div>
              )}
            </section>

            <DashboardNotices
              className="mt-8"
              notices={data.notices ?? []}
              onAfterDismiss={() => void load()}
            />
          </>
        )}
      </main>
    </div>
  );
}
