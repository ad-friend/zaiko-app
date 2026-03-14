"use client";

import { useCallback, useEffect, useState } from "react";

type AmazonOrder = {
  id: number;
  amazon_order_id: string;
  sku: string;
  condition_id: string;
  reconciliation_status: string;
  quantity: number;
  jan_code: string | null;
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
  
  // ★追加：データ取得用のState
  const [fetchDate, setFetchDate] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

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

  // ★追加：Amazonから注文データを引っ張ってくる関数
  const runFetchOrders = async () => {
    setIsFetching(true);
    setFetchResult(null);
    setError(null);
    try {
      const url = fetchDate ? `/api/amazon/fetch-orders?startDate=${fetchDate}` : "/api/amazon/fetch-orders";
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
    <div className="space-y-8">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* ★追加：STEP1 注文データの取り込みパネル */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 w-1 h-full bg-blue-500"></div>
        <h2 className="text-lg font-bold text-slate-800 mb-2">STEP 1: Amazonから注文データを取得</h2>
        <p className="text-sm text-slate-500 mb-4">
          指定した日付以降の注文データをAmazonから取得し、システムに取り込みます。（日付を空欄にした場合は直近3日分を取得します）
        </p>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="fetchDate" className="text-sm font-medium text-slate-700">取得開始日:</label>
            <input
              type="date"
              id="fetchDate"
              value={fetchDate}
              onChange={(e) => setFetchDate(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
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

      {/* STEP2 自動消込の実行パネル */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 w-1 h-full bg-primary"></div>
        <h2 className="text-lg font-bold text-slate-800 mb-2">STEP 2: 自動消込の実行</h2>
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

      {/* STEP3 未処理注文（手動確認）パネル */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm relative overflow-hidden">
        <div className="absolute top-0 left-0 w-1 h-full bg-amber-500"></div>
        <h2 className="text-lg font-bold text-slate-800 mb-2">STEP 3: 未処理注文（手動確認）</h2>
        <p className="text-sm text-slate-500 mb-4">
          中古在庫候補が複数あるなど、手動で確認が必要な注文です。正しい在庫候補を選んで確定してください。
        </p>
        {loading ? (
          <p className="text-slate-500">読み込み中...</p>
        ) : manualOrders.length === 0 ? (
          <p className="text-slate-500">手動確認対象の注文はありません。</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {manualOrders.map((order) => (
              <ManualOrderCard
                key={order.id}
                order={order}
                onConfirmed={fetchManualOrders}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ManualOrderCard({
  order,
  onConfirmed,
}: {
  order: AmazonOrder;
  onConfirmed: () => void;
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
    fetch(`/api/amazon/orders/candidates?amazon_order_id=${encodeURIComponent(order.amazon_order_id)}`)
      .then((res) => res.ok ? res.json() : [])
      .then((data) => {
        if (!cancelled) setCandidates(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setError("候補の取得に失敗しました");
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => { cancelled = true; };
  }, [order.amazon_order_id]);

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

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 shadow-sm hover:shadow-md transition-shadow">
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
      </div>
      {loadingCandidates ? (
        <p className="text-xs text-slate-500">在庫候補を取得中...</p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-red-500">該当する中古在庫候補がありません。</p>
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