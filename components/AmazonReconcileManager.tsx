"use client";

import { useCallback, useEffect, useState } from "react";
import ManualFinanceProcessModal, { type PendingFinanceGroupData } from "@/components/ManualFinanceProcessModal";
import { normalizeOrderCondition } from "@/lib/amazon-condition-match";

type AmazonOrder = {
  /**
   * amazon_orders の主キー（bigint）。JSON では string になることがある。
   * 数字のみの文字列のみ有効（503-xxx 形式の Amazon 注文番号が入っていてはならない）。
   */
  id: number | string;
  /** GET /api/amazon/orders が付与。`id` と同じ DB 主キー */
  order_row_id?: number | string;
  amazon_order_id: string;
  sku: string;
  condition_id: string;
  reconciliation_status: string;
  quantity: number;
  jan_code: string | null;
  asin?: string | null;
  created_at: string;
};

type InboundCandidate = {
  id: number;
  jan_code: string | null;
  product_name: string | null;
  condition_type: string | null;
  created_at: string;
  order_id: string | null;
};

/** DB 主キー amazon_orders.id のみ（数字のみの文字列）。ハイフン付き注文番号は 0 扱い */
function resolveOrderRowPk(o: Pick<AmazonOrder, "id" | "order_row_id">): number {
  const candidates = [o.order_row_id, o.id];
  for (const raw of candidates) {
    if (raw == null || raw === "") continue;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw === Math.trunc(raw)) {
      return Math.trunc(raw);
    }
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) {
      const n = Number.parseInt(s, 10);
      if (n > 0) return n;
    }
  }
  return 0;
}

function orderStableKey(o: AmazonOrder): string {
  const pk = resolveOrderRowPk(o);
  if (pk > 0) return `pk:${pk}`;
  return `amz:${encodeURIComponent(o.amazon_order_id)}|sku:${encodeURIComponent(o.sku)}`;
}

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function AmazonReconcileManager() {
  const [manualOrders, setManualOrders] = useState<AmazonOrder[]>([]);
  const [loading, setLoading] = useState(true);
  
  // 自動消込用のState（バックエンドは1回最大20件のため、フロントで連続呼び出し）
  const [reconciling, setReconciling] = useState(false);
  const [reconcileLoopRound, setReconcileLoopRound] = useState(0);
  const [reconcileResult, setReconcileResult] = useState<{
    message: string;
    completed?: number;
    manual_required?: number;
    skipped_used_safety?: number;
    rounds?: number;
    allComplete?: boolean;
  } | null>(null);
  
  // STEP 1: 注文データ取得用のState
  const [orderStartDate, setOrderStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [orderEndDate, setOrderEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isFetching, setIsFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<string | null>(null);

  // STEP 4: 売上データ（ペイメント）取得用のState
  const [financeStartDate, setFinanceStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d.toISOString().slice(0, 10);
  });
  const [financeEndDate, setFinanceEndDate] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [isFetchingFinances, setIsFetchingFinances] = useState(false);
  const [financeResult, setFinanceResult] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  // STEP 5: 未処理イレギュラー（pending finances）用のState
  const [pendingFinances, setPendingFinances] = useState<PendingFinanceGroupData[]>([]);
  const [isLoadingPendingFinances, setIsLoadingPendingFinances] = useState(false);
  const [selectedPendingFinance, setSelectedPendingFinance] = useState<PendingFinanceGroupData | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [showOnlyNoStock, setShowOnlyNoStock] = useState(false);
  const [candidateCountByOrderId, setCandidateCountByOrderId] = useState<Record<string, number>>({});

  const fetchManualOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/orders?status=manual_required");
      if (!res.ok) throw new Error("注文一覧の取得に失敗しました");
      const data = await res.json();
      setManualOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      setManualOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchManualOrders();
  }, [fetchManualOrders]);

  const handleCandidatesLoaded = useCallback((orderKey: string, count: number) => {
    setCandidateCountByOrderId((prev) => ({ ...prev, [orderKey]: count }));
  }, []);

  const handleOrderConditionUpdated = useCallback(
    (rowId: number, condition_id: string, amazon_order_id: string, sku: string) => {
      setManualOrders((prev) =>
        prev.map((o) => {
          const samePk = rowId > 0 && resolveOrderRowPk(o) === rowId;
          const sameBiz =
            String(o.amazon_order_id).trim() === String(amazon_order_id).trim() &&
            String(o.sku).trim() === String(sku).trim();
          return samePk || sameBiz ? { ...o, condition_id } : o;
        })
      );
    },
    []
  );

  const filteredManualOrders = showOnlyNoStock
    ? manualOrders.filter((o) => (candidateCountByOrderId[orderStableKey(o)] ?? -1) === 0)
    : manualOrders;
  const noStockCount = manualOrders.filter((o) => (candidateCountByOrderId[orderStableKey(o)] ?? -1) === 0).length;

  const fetchPendingFinances = useCallback(async () => {
    setIsLoadingPendingFinances(true);
    try {
      const res = await fetch("/api/amazon/pending-finances");
      if (!res.ok) throw new Error("未処理財務データの取得に失敗しました");
      const data = await res.json();
      setPendingFinances(Array.isArray(data) ? data : []);
    } catch {
      setPendingFinances([]);
    } finally {
      setIsLoadingPendingFinances(false);
    }
  }, []);

  useEffect(() => {
    fetchPendingFinances();
  }, [fetchPendingFinances]);

  const runFetchOrders = async () => {
    setIsFetching(true);
    setFetchResult(null);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (orderStartDate) params.set("startDate", orderStartDate);
      if (orderEndDate) params.set("endDate", orderEndDate);
      const url = `/api/amazon/fetch-orders?${params}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "データ取得に失敗しました");
      setFetchResult(`${data.message} (新規/更新: ${data.rowsUpserted}件)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "データ取得に失敗しました");
    } finally {
      setIsFetching(false);
    }
  };

  const handleFetchFinances = async () => {
    setIsFetchingFinances(true);
    setFinanceResult(null);
    try {
      const res = await fetch("/api/amazon/fetch-finances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: financeStartDate,
          endDate: financeEndDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "売上データの取得に失敗しました");
      const total = data.totalFetched ?? 0;
      const inserted = data.rowsInserted ?? 0;
      const skipped = data.rowsSkipped ?? 0;
      let message = `取得成功: ${total}件 (新規: ${inserted}件, スキップ: ${skipped}件)`;

      const reconcileRes = await fetch("/api/amazon/reconcile-sales", { method: "POST" });
      const reconcileData = await reconcileRes.json();
      if (reconcileRes.ok) {
        const reconciled = reconcileData.reconciledCount ?? 0;
        const skippedReconcile = reconcileData.skippedCount ?? 0;
        message += ` / 自動消込: ${reconciled}件成功 (保留: ${skippedReconcile}件)`;
        await fetchPendingFinances();
      } else {
        message += ` / 自動消込: 失敗 (${reconcileData.error ?? "エラー"})`;
      }

      setFinanceResult({ message, type: "success" });
    } catch (e) {
      setFinanceResult({
        message: e instanceof Error ? e.message : "売上データの取得に失敗しました",
        type: "error",
      });
    } finally {
      setIsFetchingFinances(false);
    }
  };

  const RECONCILE_MAX_ROUNDS = 300;

  const runReconcile = async () => {
    if (!confirm("自動消込を実行しますか？（pending がなくなるまで最大繰り返し実行されます）")) return;
    setReconciling(true);
    setReconcileLoopRound(0);
    setReconcileResult(null);
    setError(null);

    let round = 0;
    let totalCompleted = 0;
    let totalManual = 0;
    let totalSkippedUsed = 0;

    try {
      for (;;) {
        round += 1;
        setReconcileLoopRound(round);

        const res = await fetch("/api/amazon/reconcile", { method: "POST" });
        const data = (await res.json()) as {
          error?: string;
          processed?: number;
          completed?: number;
          manual_required?: number;
          skipped_used_safety?: number;
          message?: string;
        };

        if (!res.ok) {
          throw new Error(data.error ?? "消込に失敗しました");
        }

        const processed = Number(data.processed ?? 0);
        totalCompleted += Number(data.completed ?? 0);
        totalManual += Number(data.manual_required ?? 0);
        totalSkippedUsed += Number(data.skipped_used_safety ?? 0);

        if (processed === 0) {
          setReconcileResult({
            message: "🎉 全ての自動消込が完了しました！",
            completed: totalCompleted,
            manual_required: totalManual,
            skipped_used_safety: totalSkippedUsed,
            rounds: round,
            allComplete: true,
          });
          await fetchManualOrders();
          return;
        }

        if (round >= RECONCILE_MAX_ROUNDS) {
          setError(
            `安全のため ${RECONCILE_MAX_ROUNDS} 回でループを打ち切りました。pending が残る場合は再度「自動消込を開始する」を押してください。`
          );
          setReconcileResult({
            message: "一部のみ実行されました（ループ上限に達しました）。",
            completed: totalCompleted,
            manual_required: totalManual,
            skipped_used_safety: totalSkippedUsed,
            rounds: round,
            allComplete: false,
          });
          await fetchManualOrders();
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "消込処理に失敗しました");
      await fetchManualOrders();
    } finally {
      setReconciling(false);
      setReconcileLoopRound(0);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-10">
        {/* 左カラム（7）: 在庫の仮消込 */}
        <div className="flex flex-col gap-6 lg:col-span-7">
          <h2 className="text-base font-bold text-slate-700 border-b border-slate-200 pb-2">
            在庫の仮消込
          </h2>

          {/* STEP 1: 注文データの取り込み */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500" />
            <h3 className="text-lg font-bold text-slate-800 mb-2">STEP 1: Amazonから注文データを取得</h3>
            <p className="text-sm text-slate-500 mb-4">
              指定した期間の注文データをAmazonから取得し、システムに取り込みます。（未指定の場合は直近3日～現在）
            </p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="orderStartDate" className="block text-sm font-medium text-slate-700 mb-1">開始日</label>
                  <input
                    type="date"
                    id="orderStartDate"
                    value={orderStartDate}
                    onChange={(e) => setOrderStartDate(e.target.value)}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
                  />
                </div>
                <div>
                  <label htmlFor="orderEndDate" className="block text-sm font-medium text-slate-700 mb-1">終了日</label>
                  <input
                    type="date"
                    id="orderEndDate"
                    value={orderEndDate}
                    onChange={(e) => setOrderEndDate(e.target.value)}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={runFetchOrders}
                disabled={isFetching}
                className={`${buttonClass} bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-300`}
              >
                {isFetching ? (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Amazonと通信中...
                  </span>
                ) : (
                  "注文データを取得する"
                )}
              </button>
            </div>
            {fetchResult && (
              <div className="mt-4 rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-800 font-medium">
                ✅ {fetchResult}
              </div>
            )}
          </div>

          {/* STEP 2: 自動消込の実行 */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
            <h3 className="text-lg font-bold text-slate-800 mb-2">STEP 2: 自動消込の実行</h3>
            <p className="text-sm text-slate-500 mb-4">
              取り込んだ未処理注文に対して、新品・セット・中古（1件のみ候補）の自動消込を行います。1回のAPIは最大20件まで処理するため、pending がなくなるまで自動で繰り返し呼び出します。
            </p>
            <button
              type="button"
              onClick={runReconcile}
              disabled={reconciling}
              className={`${buttonClass} bg-primary text-white hover:bg-primary/90 disabled:bg-slate-300`}
            >
              {reconciling ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  自動消込を実行中...
                </span>
              ) : (
                "自動消込を開始する"
              )}
            </button>
            {reconciling && reconcileLoopRound > 0 && (
              <p className="mt-2 text-sm font-medium text-slate-600" aria-live="polite">
                自動消込を実行中...（{reconcileLoopRound}回目）
              </p>
            )}
            {reconcileResult && (
              <div
                className={`mt-4 rounded-lg border p-4 text-sm ${
                  reconcileResult.allComplete
                    ? "bg-emerald-50 border-emerald-300 text-emerald-900"
                    : "bg-amber-50/80 border-amber-200 text-amber-900"
                }`}
              >
                <p className="font-semibold text-base leading-snug">{reconcileResult.message}</p>
                {reconcileResult.rounds != null && (
                  <p className="mt-1 text-xs opacity-90">API 呼び出し回数: {reconcileResult.rounds} 回</p>
                )}
                {reconcileResult.completed != null && (
                  <p className="mt-2">このセッションで自動消込完了: {reconcileResult.completed} 件</p>
                )}
                {reconcileResult.manual_required != null && reconcileResult.manual_required > 0 && (
                  <p className="mt-1">手動確認に回した注文: {reconcileResult.manual_required} 件</p>
                )}
                {reconcileResult.skipped_used_safety != null && reconcileResult.skipped_used_safety > 0 && (
                  <p className="mt-1">中古安全装置でスキップ（pending のまま）: {reconcileResult.skipped_used_safety} 件</p>
                )}
              </div>
            )}
          </div>

          {/* STEP 3: 未処理注文（手動確認） */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-amber-500" />
            <h3 className="text-lg font-bold text-slate-800 mb-2">STEP 3: 未処理注文（手動確認）</h3>
            <p className="text-sm text-slate-500 mb-4">
              中古在庫候補が複数あるなど、手動で確認が必要な注文です。正しい在庫候補を選んで確定してください。在庫なしの注文も表示されます。
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyNoStock}
                  onChange={(e) => setShowOnlyNoStock(e.target.checked)}
                  className="rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm font-medium text-slate-700">在庫なしのみ表示</span>
              </label>
              {noStockCount > 0 && (
                <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
                  在庫なし: {noStockCount}件
                </span>
              )}
            </div>
            {loading ? (
              <p className="text-slate-500">読み込み中...</p>
            ) : manualOrders.length === 0 ? (
              <p className="text-slate-500">手動確認対象の注文はありません。</p>
            ) : filteredManualOrders.length === 0 ? (
              <p className="text-slate-500">
                {showOnlyNoStock ? "在庫なしの注文はありません（候補の読み込みが完了すると反映されます）。" : "表示する注文がありません。"}
              </p>
            ) : (
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                {filteredManualOrders.map((order) => (
                  <ManualOrderCard
                    key={order.id}
                    order={order}
                    onConfirmed={fetchManualOrders}
                    onCandidatesLoaded={handleCandidatesLoaded}
                    onConditionUpdated={handleOrderConditionUpdated}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右カラム（3）: 売上とお金の確定（本消込） */}
        <div className="flex flex-col gap-6 lg:col-span-3 lg:min-h-0">
          <div className="rounded-xl border border-slate-200 bg-slate-100/60 p-4 lg:sticky lg:top-24">
            <h2 className="text-base font-bold text-slate-700 border-b border-slate-300 pb-2 mb-4">
              売上とお金の確定（本消込）
            </h2>
            <div className="space-y-6">
              {/* STEP 4: 売上データ（ペイメント）の取得 ＆ 自動処理 */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800 mb-2">STEP 4: 売上データ（ペイメント）の取得 ＆ 自動処理</h3>
                <p className="text-xs text-slate-500 mb-4">対象期間の売上・手数料・返品・補填データを取得し、sales_transactions に保存します。</p>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="financeStartDate" className="block text-xs font-medium text-slate-600 mb-1">開始日</label>
                      <input
                        type="date"
                        id="financeStartDate"
                        value={financeStartDate}
                        onChange={(e) => setFinanceStartDate(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label htmlFor="financeEndDate" className="block text-xs font-medium text-slate-600 mb-1">終了日</label>
                      <input
                        type="date"
                        id="financeEndDate"
                        value={financeEndDate}
                        onChange={(e) => setFinanceEndDate(e.target.value)}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleFetchFinances}
                    disabled={isFetchingFinances}
                    className={`${buttonClass} w-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-sm`}
                  >
                    {isFetchingFinances ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        取得中...
                      </span>
                    ) : (
                      "売上データを取得・処理する"
                    )}
                  </button>
                  {financeResult && (
                    <div
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        financeResult.type === "success"
                          ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                          : "bg-red-50 border-red-200 text-red-800"
                      }`}
                    >
                      {financeResult.type === "success" ? "✅ " : "❌ "}
                      {financeResult.message}
                    </div>
                  )}
                </div>
              </div>

              {/* STEP 5: イレギュラー処理（返品・補填など） */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800 mb-2">STEP 5: イレギュラー処理（返品・補填など）</h3>
                <p className="text-xs text-slate-500 mb-3">返品・補填など未処理のイレギュラーを確認します。</p>
                {isLoadingPendingFinances ? (
                  <p className="text-xs text-slate-500 py-4 text-center">読み込み中...</p>
                ) : pendingFinances.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 py-6 px-3 text-center">
                    <p className="text-xs text-slate-500">現在、未処理のイレギュラーデータはありません。</p>
                  </div>
                ) : (
                  <ul className="space-y-2 max-h-[280px] overflow-y-auto pr-0.5">
                    {pendingFinances.map((g) => (
                      <li
                        key={g.groupId}
                        className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-800" title={g.amazon_order_id ?? g.sku ?? g.groupId}>
                            {g.amazon_order_id ?? g.sku ?? g.groupId}
                          </p>
                          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                            <span
                              className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                g.transaction_type === "Order"
                                  ? "bg-blue-100 text-blue-700"
                                  : g.transaction_type === "Refund"
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-slate-200 text-slate-700"
                              }`}
                            >
                              {g.transaction_type}
                            </span>
                            <span className="text-slate-500">
                              {g.posted_date ? new Date(g.posted_date).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) : "—"}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={`font-semibold tabular-nums ${g.net_amount >= 0 ? "text-slate-800" : "text-red-600"}`}>
                            {g.net_amount >= 0 ? "" : "−"}
                            {Math.abs(g.net_amount).toLocaleString()}円
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedPendingFinance(g);
                              setIsModalOpen(true);
                            }}
                            className="mt-1 inline-flex items-center justify-center rounded bg-slate-200 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-300 transition-colors"
                          >
                            手動処理
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <ManualFinanceProcessModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedPendingFinance(null);
        }}
        data={selectedPendingFinance}
        onSuccess={fetchPendingFinances}
      />
    </div>
  );
}

function ManualOrderCard({
  order,
  onConfirmed,
  onCandidatesLoaded,
  onConditionUpdated,
}: {
  order: AmazonOrder;
  onConfirmed: () => void;
  onCandidatesLoaded?: (orderKey: string, candidateCount: number) => void;
  onConditionUpdated?: (rowId: number, condition_id: string, amazon_order_id: string, sku: string) => void;
}) {
  const [candidates, setCandidates] = useState<InboundCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conditionId, setConditionId] = useState(order.condition_id);
  const [conditionSaving, setConditionSaving] = useState(false);
  const [conditionMessage, setConditionMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [candidatesRefreshKey, setCandidatesRefreshKey] = useState(0);

  useEffect(() => {
    setConditionId(order.condition_id);
  }, [order.id, order.condition_id]);

  const orderCondNorm = normalizeOrderCondition(conditionId);
  const isUsedDisplay = orderCondNorm === "used";

  useEffect(() => {
    let cancelled = false;
    setLoadingCandidates(true);
    setError(null);
    const params = new URLSearchParams({ amazon_order_id: order.amazon_order_id });
    if (order.sku) params.set("sku", order.sku);
    fetch(`/api/amazon/orders/candidates?${params}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        if (!cancelled) {
          setCandidates(list);
          onCandidatesLoaded?.(orderStableKey(order), list.length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("候補の取得に失敗しました");
          onCandidatesLoaded?.(orderStableKey(order), 0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [order.amazon_order_id, order.sku, order.id, onCandidatesLoaded, candidatesRefreshKey]);

  const patchCondition = async (next: "New" | "Used") => {
    if (conditionSaving) return;
    const currentNorm = normalizeOrderCondition(conditionId);
    const nextNorm = next === "Used" ? "used" : "new";
    if (currentNorm === nextNorm) return;

    if (!String(order.amazon_order_id ?? "").trim()) {
      setConditionMessage({ type: "err", text: "Amazon注文番号がありません。一覧を再読み込みしてください。" });
      return;
    }

    const orderDbId = resolveOrderRowPk(order);
    const rawId = order.order_row_id ?? order.id;

    setConditionSaving(true);
    setConditionMessage(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        condition_id: next,
        amazon_order_id: order.amazon_order_id,
        order_id: order.amazon_order_id,
        sku: order.sku,
        id: Number(rawId),
        id_numeric: Number(rawId),
        id_string: String(rawId ?? ""),
      };
      if (orderDbId > 0) {
        payload.id = orderDbId;
        payload.id_numeric = orderDbId;
        payload.order_row_id = orderDbId;
      }

      console.log("📦 Final Payload:", JSON.stringify(payload));

      const res = await fetch("/api/amazon/orders/condition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string; condition_id?: string; id?: number };
      if (!res.ok) {
        const errorResponse = {
          httpStatus: res.status,
          httpStatusText: res.statusText,
          message: data.error,
          body: data,
        };
        console.error("❌ APIエラー詳細:", errorResponse);
        throw new Error(data.error ?? "コンディションの更新に失敗しました");
      }
      const saved = (data.condition_id === "New" || data.condition_id === "Used" ? data.condition_id : next) as
        | "New"
        | "Used";
      const serverRowId = typeof data.id === "number" && data.id > 0 ? data.id : orderDbId;
      setConditionId(saved);
      setSelectedId(null);
      onConditionUpdated?.(serverRowId, saved, order.amazon_order_id, order.sku);
      setCandidatesRefreshKey((k) => k + 1);
      setConditionMessage({
        type: "ok",
        text: `コンディションを「${saved === "Used" ? "中古（Used）" : "新品（New）"}」に更新しました。`,
      });
    } catch (e) {
      setConditionMessage({
        type: "err",
        text: e instanceof Error ? e.message : "コンディションの更新に失敗しました",
      });
    } finally {
      setConditionSaving(false);
    }
  };

  const confirmSelection = async () => {
    if (selectedId == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/reconcile/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amazon_order_id: order.amazon_order_id,
          inbound_item_id: selectedId,
          amazon_order_db_id: order.id,
          sku: order.sku,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "確定に失敗しました");
      onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "確定に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const noCandidates = !loadingCandidates && candidates.length === 0;

  return (
    <div
      className={`rounded-lg border p-4 shadow-sm transition-shadow ${
        noCandidates
          ? "border-red-200 bg-red-50 hover:shadow-md"
          : "border-slate-200 bg-slate-50/50 hover:shadow-md"
      }`}
    >
      <div className="mb-3">
        <a
          href={`https://sellercentral.amazon.co.jp/orders-v3/order/${order.amazon_order_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-mono font-bold text-amber-600 hover:underline"
        >
          {order.amazon_order_id}
        </a>
        <p className="text-xs text-slate-500 mt-1">
          SKU: {order.sku} / 数量: {order.quantity}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              orderCondNorm == null
                ? "bg-amber-100 text-amber-900"
                : isUsedDisplay
                  ? "bg-violet-100 text-violet-800"
                  : "bg-emerald-100 text-emerald-800"
            }`}
          >
            コンディション:{" "}
            {orderCondNorm == null
              ? `未判定（${conditionId || "—"}）`
              : isUsedDisplay
                ? "中古（Used）"
                : "新品（New）"}
          </span>
          {orderCondNorm == null ? (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={conditionSaving}
                onClick={() => patchCondition("New")}
                className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {conditionSaving ? "更新中..." : "新品（New）に設定"}
              </button>
              <button
                type="button"
                disabled={conditionSaving}
                onClick={() => patchCondition("Used")}
                className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {conditionSaving ? "更新中..." : "中古（Used）に設定"}
              </button>
            </div>
          ) : isUsedDisplay ? (
            <button
              type="button"
              disabled={conditionSaving}
              onClick={() => patchCondition("New")}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {conditionSaving ? "更新中..." : "新品（New）に変更"}
            </button>
          ) : (
            <button
              type="button"
              disabled={conditionSaving}
              onClick={() => patchCondition("Used")}
              className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {conditionSaving ? "更新中..." : "中古（Used）に変更"}
            </button>
          )}
        </div>
        {conditionMessage && (
          <p
            className={`mt-1.5 text-[11px] ${conditionMessage.type === "ok" ? "text-emerald-700" : "text-red-600"}`}
            role="status"
          >
            {conditionMessage.type === "ok" ? "✓ " : ""}
            {conditionMessage.text}
          </p>
        )}
        {order.jan_code && <p className="text-xs text-slate-500 font-medium mt-1">JAN: {order.jan_code}</p>}
        {order.asin && <p className="text-xs text-slate-500 font-medium">ASIN: {order.asin}</p>}
      </div>
      {loadingCandidates ? (
        <p className="text-xs text-slate-500">在庫候補を取得中...</p>
      ) : noCandidates ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-red-700 flex items-center gap-1">
            <span className="shrink-0" aria-hidden>⚠</span>
            紐付け可能な在庫が登録されていません。JAN/ASINを確認して在庫を登録してください。
          </p>
          <button
            type="button"
            disabled
            className={`${buttonClass} w-full bg-slate-300 text-slate-500 cursor-not-allowed text-sm`}
          >
            手動で紐付け（在庫なしのため選択不可）
          </button>
        </div>
      ) : (
        <>
          <label className="block text-xs font-semibold text-slate-600 mb-1">在庫候補を選択</label>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
            className="mb-3 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50"
          >
            <option value="">選択してください</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                ID:{c.id} {c.product_name ?? ""} ({c.created_at?.slice(0, 10)})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={confirmSelection}
            disabled={selectedId == null || submitting || conditionSaving}
            className={`${buttonClass} w-full bg-amber-500 text-white hover:bg-amber-600 disabled:bg-slate-300 text-sm`}
          >
            {submitting ? "確定中..." : "この在庫で確定"}
          </button>
        </>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}