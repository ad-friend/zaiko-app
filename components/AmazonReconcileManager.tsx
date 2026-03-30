"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import ManualFinanceProcessModal, { type PendingFinanceGroupData } from "@/components/ManualFinanceProcessModal";
import ReturnInspectionQueueSection from "@/components/ReturnInspectionQueueSection";
import { normalizeOrderCondition } from "@/lib/amazon-condition-match";

type AmazonOrder = {
  /** amazon_orders の主キー（UUID 文字列） */
  id: string;
  /** GET /api/amazon/orders が付与。`id` と同じ DB 主キー */
  order_row_id?: string;
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

/** DB 主キー amazon_orders.id（UUID 文字列） */
function resolveOrderRowIdString(o: Pick<AmazonOrder, "id" | "order_row_id">): string | null {
  const candidates = [o.order_row_id, o.id];
  for (const raw of candidates) {
    if (raw == null) continue;
    const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (s.length > 0) return s;
  }
  return null;
}

function orderStableKey(o: AmazonOrder): string {
  const rowId = resolveOrderRowIdString(o);
  if (rowId) return `pk:${rowId}`;
  return `amz:${encodeURIComponent(o.amazon_order_id)}|sku:${encodeURIComponent(o.sku)}`;
}

function stringifyPayload(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

async function readJsonSafe(res: Response): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: res.ok, status: res.status, data: {} };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: res.status,
      data: { error: `サーバーが JSON 以外を返しました (${res.status})`, raw: trimmed.slice(0, 300) },
    };
  }
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
  /** 本消込のみ（reconcile-sales）実行中 */
  const [isProcessingOnly, setIsProcessingOnly] = useState(false);

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
    (rowId: string, condition_id: string, amazon_order_id: string, sku: string) => {
      setManualOrders((prev) =>
        prev.map((o) => {
          const oid = resolveOrderRowIdString(o);
          const samePk = rowId.length > 0 && oid != null && oid === rowId;
          const sameBiz =
            String(o.amazon_order_id).trim() === String(amazon_order_id).trim() &&
            String(o.sku).trim() === String(sku).trim();
          return samePk || sameBiz ? { ...o, condition_id } : o;
        })
      );
    },
    []
  );

  const handleOrderDeleted = useCallback((removedId: string) => {
    setManualOrders((prev) => prev.filter((o) => o.id !== removedId));
    setCandidateCountByOrderId((prev) => {
      const next = { ...prev };
      delete next[`pk:${removedId}`];
      return next;
    });
  }, []);

  const handleOrderCancellationExcluded = useCallback((amazonOrderId: string) => {
    const want = String(amazonOrderId).trim();
    setManualOrders((prev) => prev.filter((o) => String(o.amazon_order_id).trim() !== want));
  }, []);

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

  const handleReconcileSalesOnly = async () => {
    setIsProcessingOnly(true);
    setFinanceResult(null);
    try {
      const res = await fetch("/api/amazon/reconcile-sales", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        reconciledCount?: number;
        skippedCount?: number;
        message?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "本消込に失敗しました");
      const reconciled = data.reconciledCount ?? 0;
      const skipped = data.skippedCount ?? 0;
      setFinanceResult({
        type: "success",
        message: data.message ?? `本消込: ${reconciled}件成功（保留: ${skipped}件）`,
      });
      await fetchPendingFinances();
    } catch (e) {
      setFinanceResult({
        type: "error",
        message: e instanceof Error ? e.message : "本消込に失敗しました",
      });
    } finally {
      setIsProcessingOnly(false);
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

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
        {/* 左カラム: 在庫の仮消込（ワイド画面で広く） */}
        <div className="flex flex-col gap-8 xl:col-span-9">
          <h2 className="text-lg font-bold tracking-tight text-slate-800 border-b border-slate-200 pb-3">
            在庫の仮消込
          </h2>

          {/* STEP 1: 注文データの取り込み */}
          <div className="rounded-xl border border-slate-200 bg-white p-7 lg:p-8 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-blue-500" />
            <h3 className="text-lg lg:text-xl font-bold text-slate-800 mb-2">STEP 1: Amazonから注文データを取得</h3>
            <p className="text-sm text-slate-500 mb-5 leading-relaxed">
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
          <div className="rounded-xl border border-slate-200 bg-white p-7 lg:p-8 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-primary" />
            <h3 className="text-lg lg:text-xl font-bold text-slate-800 mb-2">STEP 2: 自動消込の実行</h3>
            <p className="text-sm text-slate-500 mb-5 leading-relaxed">
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
          <div className="rounded-xl border border-slate-200 bg-white p-7 lg:p-8 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-amber-500" />
            <h3 className="text-lg lg:text-xl font-bold text-slate-800 mb-2">STEP 3: 未処理注文（手動確認）</h3>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed max-w-4xl">
              中古在庫候補が複数あるなど、手動で確認が必要な注文です。正しい在庫候補を選んで確定してください。在庫なしの注文も表示されます。
            </p>
            <div className="flex flex-wrap items-center gap-4 mb-6">
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
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-5 md:grid-cols-2 xl:grid-cols-3">
                {filteredManualOrders.map((order) => (
                  <ManualOrderCard
                    key={order.id}
                    order={order}
                    onConfirmed={fetchManualOrders}
                    onCandidatesLoaded={handleCandidatesLoaded}
                    onConditionUpdated={handleOrderConditionUpdated}
                    onDeleted={handleOrderDeleted}
                    onCancellationExcluded={handleOrderCancellationExcluded}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右カラム: 売上とお金の確定（本消込） */}
        <div className="flex flex-col gap-8 xl:col-span-3 xl:min-h-0">
          <div className="rounded-xl border border-slate-200 bg-slate-100/60 p-5 lg:p-6 lg:sticky lg:top-24">
            <h2 className="text-lg font-bold tracking-tight text-slate-800 border-b border-slate-300 pb-3 mb-5">
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
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={handleFetchFinances}
                      disabled={isFetchingFinances || isProcessingOnly}
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
                    <button
                      type="button"
                      onClick={handleReconcileSalesOnly}
                      disabled={isFetchingFinances || isProcessingOnly}
                      className={`${buttonClass} w-full border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-sm`}
                    >
                      {isProcessingOnly ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          処理中...
                        </span>
                      ) : (
                        "未処理データの紐づけを実行"
                      )}
                    </button>
                  </div>
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

              <ReturnInspectionQueueSection />
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
  onDeleted,
  onCancellationExcluded,
}: {
  order: AmazonOrder;
  onConfirmed: () => void;
  onCandidatesLoaded?: (orderKey: string, candidateCount: number) => void;
  onConditionUpdated?: (rowId: string, condition_id: string, amazon_order_id: string, sku: string) => void;
  onDeleted?: (rowId: string) => void;
  onCancellationExcluded?: (amazon_order_id: string) => void;
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
  const [deleting, setDeleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rescueExtra, setRescueExtra] = useState<InboundCandidate[]>([]);
  const [rescueQuery, setRescueQuery] = useState("");
  const [rescueLoading, setRescueLoading] = useState(false);
  const [rescueError, setRescueError] = useState<string | null>(null);

  useEffect(() => {
    setConditionId(order.condition_id);
  }, [order.id, order.condition_id]);

  const orderCondNorm = normalizeOrderCondition(conditionId);
  const isUsedDisplay = orderCondNorm === "used";

  const mergedCandidates = useMemo(() => {
    const m = new Map<number, InboundCandidate>();
    for (const c of candidates) m.set(c.id, c);
    for (const c of rescueExtra) m.set(c.id, c);
    return [...m.values()].sort((a, b) => a.id - b.id);
  }, [candidates, rescueExtra]);

  useEffect(() => {
    onCandidatesLoaded?.(orderStableKey(order), mergedCandidates.length);
  }, [mergedCandidates.length, order, onCandidatesLoaded]);

  useEffect(() => {
    setRescueExtra([]);
    setRescueQuery("");
    setRescueError(null);
  }, [order.id, order.amazon_order_id, order.sku, candidatesRefreshKey]);

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

    const rowUuid = resolveOrderRowIdString(order);

    setConditionSaving(true);
    setConditionMessage(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        condition_id: next,
        amazon_order_id: order.amazon_order_id,
        order_id: order.amazon_order_id,
        sku: order.sku,
      };
      if (rowUuid) {
        payload.id = rowUuid;
        payload.id_string = rowUuid;
        payload.amazon_order_db_id = rowUuid;
      }

      const payloadJson = stringifyPayload(payload);
      console.log("📦 Final Payload:", payloadJson);

      const res = await fetch("/api/amazon/orders/condition", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: payloadJson,
      });
      const { ok: httpOk, data } = await readJsonSafe(res);
      const errMsg = typeof data.error === "string" ? data.error : undefined;
      const condRaw = data.condition_id;
      const idRaw = data.id;

      if (!httpOk) {
        const errorResponse = {
          httpStatus: res.status,
          httpStatusText: res.statusText,
          message: errMsg,
          body: data,
        };
        console.error("❌ APIエラー詳細:", errorResponse);
        throw new Error(errMsg ?? "コンディションの更新に失敗しました");
      }
      const saved = (condRaw === "New" || condRaw === "Used" ? condRaw : next) as "New" | "Used";
      const serverRowId =
        typeof idRaw === "string" && idRaw.trim().length > 0
          ? idRaw.trim()
          : rowUuid ?? "";
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

  const runCancellationExclude = async () => {
    const oid = String(order.amazon_order_id ?? "").trim();
    if (!oid) {
      setError("Amazon注文番号がありません。");
      return;
    }
    if (
      !window.confirm(
        `この注文（${oid}）をキャンセル扱いにし、紐付いた在庫の引き当てを解除しますか？\n同一注文のほかの明細行もまとめて処理されます。`
      )
    ) {
      return;
    }
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amazon_order_id: oid }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "キャンセル処理に失敗しました");
      onCancellationExcluded?.(oid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "キャンセル処理に失敗しました");
    } finally {
      setCancelling(false);
    }
  };

  const deleteCancelledOrderRow = async () => {
    const rowId = resolveOrderRowIdString(order);
    if (!rowId) {
      setError("行IDが取得できません。一覧を再読み込みしてください。");
      return;
    }
    if (
      !window.confirm(
        `この注文行（${order.amazon_order_id} / SKU: ${order.sku}）をデータベースから削除しますか？\nキャンセル注文などの整理用です。取り消しはできません。`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/amazon/orders/${encodeURIComponent(rowId)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "削除に失敗しました");
      onDeleted?.(rowId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setDeleting(false);
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

  const runRescueSearch = async () => {
    const q = rescueQuery.trim();
    if (q.length < 1) {
      setRescueError("検索語を入力してください");
      return;
    }
    setRescueLoading(true);
    setRescueError(null);
    try {
      const params = new URLSearchParams({ search: q, amazon_order_id: order.amazon_order_id });
      const res = await fetch(`/api/amazon/candidate-stocks?${params}`);
      const raw: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          raw &&
          typeof raw === "object" &&
          "error" in raw &&
          typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : "検索に失敗しました";
        throw new Error(msg);
      }
      const list = Array.isArray(raw) ? raw : [];
      type ApiCand = {
        id: number;
        sku: string | null;
        condition: string | null;
        product_name: string | null;
        created_at: string | null;
        amazon_order_id: string | null;
      };
      const mapped: InboundCandidate[] = (list as ApiCand[]).map((r) => ({
        id: r.id,
        jan_code: r.sku,
        product_name: r.product_name,
        condition_type: r.condition,
        created_at: r.created_at ?? "",
        order_id: r.amazon_order_id,
      }));
      setRescueExtra(mapped);
      if (mapped.length === 0) {
        setRescueError("該当する在庫がありませんでした");
      }
    } catch (e) {
      setRescueError(e instanceof Error ? e.message : "検索に失敗しました");
    } finally {
      setRescueLoading(false);
    }
  };

  const noCandidates = !loadingCandidates && candidates.length === 0;

  const createdLabel =
    order.created_at != null && String(order.created_at).trim() !== ""
      ? (() => {
          try {
            const d = new Date(order.created_at);
            return Number.isNaN(d.getTime()) ? null : d.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });
          } catch {
            return null;
          }
        })()
      : null;

  const condToggleClass =
    "inline-flex items-center justify-center rounded-md border px-2.5 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-45 disabled:cursor-not-allowed min-h-[38px] sm:px-3 sm:text-[13px]";

  return (
    <div
      className={`min-w-0 w-full rounded-lg border-2 p-4 lg:p-5 shadow-sm transition-shadow ${
        noCandidates
          ? "border-red-200/90 bg-red-50/40 hover:shadow-md"
          : "border-slate-200/90 bg-white hover:shadow-md hover:border-slate-300"
      }`}
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">注文番号（Amazon）</p>
            <div className="-mx-0.5 max-w-full overflow-x-auto px-0.5 pb-0.5 [scrollbar-width:thin]">
              <a
                href={`https://sellercentral.amazon.co.jp/orders-v3/order/${order.amazon_order_id}`}
                target="_blank"
                rel="noopener noreferrer"
                title={order.amazon_order_id}
                className="inline-block whitespace-nowrap font-mono text-sm font-semibold text-amber-700 hover:text-amber-800 hover:underline"
              >
                {order.amazon_order_id}
              </a>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-slate-100 pt-2.5 lg:border-t-0 lg:pt-0">
            <button
              type="button"
              title="キャンセル・除外（在庫を解放）"
              aria-label="キャンセル・除外（在庫を解放）"
              disabled={cancelling || deleting || submitting || conditionSaving}
              onClick={() => {
                void runCancellationExclude().catch((err) => console.error("[runCancellationExclude]", err));
              }}
              className="inline-flex items-center gap-1 rounded-md border border-amber-400/90 bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-950 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed sm:text-xs"
            >
              <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
              キャンセル
            </button>
            <button
              type="button"
              title="DBから行を削除（キャンセル注文の整理）"
              aria-label="削除（キャンセル注文）"
              disabled={deleting || cancelling || submitting || conditionSaving}
              onClick={() => {
                void deleteCancelledOrderRow().catch((err) => console.error("[deleteCancelledOrderRow]", err));
              }}
              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2 py-1.5 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed sm:text-xs"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              削除
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-slate-400">SKU</p>
            <p className="mt-0.5 break-all font-mono text-sm font-semibold leading-snug text-slate-900">{order.sku}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-slate-400">数量</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">{order.quantity}</p>
          </div>
        </div>

        {createdLabel && (
          <p className="text-xs text-slate-400">
            <span className="font-medium text-slate-500">登録日時</span>{" "}
            <span className="tabular-nums">{createdLabel}</span>
          </p>
        )}

        {(order.jan_code || order.asin) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
            {order.jan_code && (
              <span>
                <span className="font-medium text-slate-600">JAN</span> {order.jan_code}
              </span>
            )}
            {order.asin && (
              <span>
                <span className="font-medium text-slate-600">ASIN</span> {order.asin}
              </span>
            )}
          </div>
        )}

        <div className="rounded-lg border border-slate-200 bg-slate-50/90 p-3 space-y-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <span
              className={`inline-flex w-fit max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${
                orderCondNorm == null
                  ? "bg-amber-200/80 text-amber-950"
                  : isUsedDisplay
                    ? "bg-violet-200/80 text-violet-950"
                    : "bg-emerald-200/80 text-emerald-950"
              }`}
            >
              {orderCondNorm == null
                ? `未判定（${conditionId || "—"}）`
                : isUsedDisplay
                  ? "中古（Used）"
                  : "新品（New）"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {orderCondNorm == null ? (
                <>
                  <button
                    type="button"
                    disabled={conditionSaving}
                    title="新品（New）に設定"
                    onClick={() => {
                      void patchCondition("New").catch((err) => console.error("[patchCondition]", err));
                    }}
                    className={`${condToggleClass} border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 focus-visible:ring-emerald-500`}
                  >
                    {conditionSaving ? "更新中…" : "新品に設定"}
                  </button>
                  <button
                    type="button"
                    disabled={conditionSaving}
                    title="中古（Used）に設定"
                    onClick={() => {
                      void patchCondition("Used").catch((err) => console.error("[patchCondition]", err));
                    }}
                    className={`${condToggleClass} border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100 focus-visible:ring-violet-500`}
                  >
                    {conditionSaving ? "更新中…" : "中古に設定"}
                  </button>
                </>
              ) : isUsedDisplay ? (
                <button
                  type="button"
                  disabled={conditionSaving}
                  title="新品（New）に変更"
                  onClick={() => {
                    void patchCondition("New").catch((err) => console.error("[patchCondition]", err));
                  }}
                  className={`${condToggleClass} border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:ring-slate-400`}
                >
                  {conditionSaving ? "更新中…" : "新品へ"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={conditionSaving}
                  title="中古（Used）に変更"
                  onClick={() => {
                    void patchCondition("Used").catch((err) => console.error("[patchCondition]", err));
                  }}
                  className={`${condToggleClass} border-violet-300 bg-violet-50 text-violet-900 hover:bg-violet-100 focus-visible:ring-violet-500`}
                >
                  {conditionSaving ? "更新中…" : "中古へ"}
                </button>
              )}
            </div>
          </div>
          {conditionMessage && (
            <p
              className={`text-xs leading-snug ${conditionMessage.type === "ok" ? "font-medium text-emerald-800" : "font-medium text-red-700"}`}
              role="status"
            >
              {conditionMessage.type === "ok" ? "✓ " : ""}
              {conditionMessage.text}
            </p>
          )}
        </div>

        {loadingCandidates ? (
          <p className="text-xs font-medium text-slate-500">在庫候補を取得中…</p>
        ) : noCandidates ? (
          <div className="space-y-2 rounded-lg border border-red-100 bg-red-50/50 p-3">
            <p className="text-xs font-semibold text-red-800 flex items-start gap-1.5 leading-snug">
              <span className="shrink-0" aria-hidden>
                ⚠
              </span>
              紐付け可能な在庫がありません。JAN / ASIN を確認し在庫を登録してください。
            </p>
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <input
                  type="text"
                  value={rescueQuery}
                  onChange={(e) => setRescueQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void runRescueSearch();
                    }
                  }}
                  placeholder="例: 4901234567890 または 商品名の一部"
                  disabled={rescueLoading || submitting}
                  className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                />
                <button
                  type="button"
                  onClick={() => void runRescueSearch()}
                  disabled={rescueLoading || submitting}
                  className={`${buttonClass} h-9 shrink-0 bg-sky-700 text-white hover:bg-sky-800 text-xs px-4 disabled:bg-slate-300`}
                >
                  {rescueLoading ? "検索中…" : "検索"}
                </button>
              </div>
              {rescueError ? <p className="text-[11px] font-medium text-red-700">{rescueError}</p> : null}
              {rescueExtra.length > 0 ? (
                <p className="text-[11px] text-sky-800/90">レスキュー検索で {rescueExtra.length} 件ヒット（下の候補に反映）</p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <label className="block text-xs font-bold text-slate-700">在庫候補を選択</label>
            <select
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border-2 border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            >
              <option value="">選択してください</option>
              {mergedCandidates.map((c: InboundCandidate) => (
                <option key={c.id} value={c.id}>
                  ID:{c.id} {c.product_name ?? ""} ({c.created_at?.slice(0, 10)})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={confirmSelection}
              disabled={selectedId == null || submitting || conditionSaving}
              className={`${buttonClass} h-10 w-full bg-amber-600 text-sm font-bold text-white shadow-sm hover:bg-amber-700 disabled:bg-slate-300 disabled:text-slate-500`}
            >
              {submitting ? "確定中…" : "この在庫で確定"}
            </button>
            <div className="space-y-2 pt-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <input
                  type="text"
                  value={rescueQuery}
                  onChange={(e) => setRescueQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void runRescueSearch();
                    }
                  }}
                  placeholder="例: 4901234567890 または 商品名の一部"
                  disabled={rescueLoading || submitting}
                  className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                />
                <button
                  type="button"
                  onClick={() => void runRescueSearch()}
                  disabled={rescueLoading || submitting}
                  className={`${buttonClass} h-9 shrink-0 bg-sky-700 text-white hover:bg-sky-800 text-xs px-4 disabled:bg-slate-300`}
                >
                  {rescueLoading ? "検索中…" : "検索"}
                </button>
              </div>
              {rescueError ? <p className="text-[11px] font-medium text-red-700">{rescueError}</p> : null}
              {rescueExtra.length > 0 ? (
                <p className="text-[11px] text-sky-800/90">レスキュー検索で {rescueExtra.length} 件ヒット（候補に反映）</p>
              ) : null}
            </div>
          </div>
        )}

        {error && <p className="text-xs font-medium text-red-700 leading-snug">{error}</p>}
      </div>
    </div>
  );
}