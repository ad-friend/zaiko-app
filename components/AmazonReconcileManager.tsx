"use client";

import { useCallback, useEffect, useState } from "react";
import ManualFinanceProcessModal, { type PendingFinanceGroupData } from "@/components/ManualFinanceProcessModal";

type AmazonOrder = {
  id: number;
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

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function AmazonReconcileManager() {
  const [manualOrders, setManualOrders] = useState<AmazonOrder[]>([]);
  const [loading, setLoading] = useState(true);
  
  // 自動消込用のState
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    message: string;
    completed?: number;
    manual_required?: number;
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
  const [candidateCountByOrderId, setCandidateCountByOrderId] = useState<Record<number, number>>({});

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

  const handleCandidatesLoaded = useCallback((orderId: number, count: number) => {
    setCandidateCountByOrderId((prev) => ({ ...prev, [orderId]: count }));
  }, []);

  const filteredManualOrders = showOnlyNoStock
    ? manualOrders.filter((o) => (candidateCountByOrderId[o.id] ?? -1) === 0)
    : manualOrders;
  const noStockCount = manualOrders.filter((o) => (candidateCountByOrderId[o.id] ?? -1) === 0).length;

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

  const runReconcile = async () => {
    if (!confirm("自動消込を実行しますか？")) return;
    setReconciling(true);
    setReconcileResult(null);
    setError(null);
    try {
      const res = await fetch("/api/amazon/reconcile", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "消込に失敗しました");
      setReconcileResult({
        message: data.message ?? "完了しました",
        completed: data.completed,
        manual_required: data.manual_required,
      });
      await fetchManualOrders();
    } catch (e) {
      setError(e instanceof Error ? e.message : "消込処理に失敗しました");
    } finally {
      setReconciling(false);
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
              取り込んだ未処理注文に対して、新品・セット・中古（1件のみ候補）の自動消込を行います。
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
                  消込処理を実行中...
                </span>
              ) : (
                "消込処理を開始する"
              )}
            </button>
            {reconcileResult && (
              <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">
                <p className="font-medium">{reconcileResult.message}</p>
                {reconcileResult.completed != null && (
                  <p className="mt-1">自動消込完了: {reconcileResult.completed} 件</p>
                )}
                {reconcileResult.manual_required != null && reconcileResult.manual_required > 0 && (
                  <p className="mt-1">手動確認に回した注文: {reconcileResult.manual_required} 件</p>
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
}: {
  order: AmazonOrder;
  onConfirmed: () => void;
  onCandidatesLoaded?: (orderId: number, candidateCount: number) => void;
}) {
  const [candidates, setCandidates] = useState<InboundCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingCandidates(true);
    setError(null);
    const params = new URLSearchParams({ amazon_order_id: order.amazon_order_id });
    if (order.sku) params.set("sku", order.sku);
    fetch(`/api/amazon/orders/candidates?${params}`)
      .then((res) => res.ok ? res.json() : [])
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        if (!cancelled) {
          setCandidates(list);
          onCandidatesLoaded?.(order.id, list.length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("候補の取得に失敗しました");
          onCandidatesLoaded?.(order.id, 0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => { cancelled = true; };
  }, [order.amazon_order_id, order.sku, order.id, onCandidatesLoaded]);

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
          ? "border-red-200 bg-red-50/80 hover:shadow-md"
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
        <p className="text-xs text-slate-500 mt-1">SKU: {order.sku} / 状態: {order.condition_id} / 数量: {order.quantity}</p>
        {order.jan_code && <p className="text-xs text-slate-500 font-medium">JAN: {order.jan_code}</p>}
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
            disabled={selectedId == null || submitting}
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