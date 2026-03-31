"use client";

import { useEffect, useState } from "react";
import { isPrincipalTaxOffsetQuad } from "@/lib/amazon-principal-tax-quad";
import type { PendingFinanceGroupKind } from "@/lib/pending-finance-group-kind";

export type PendingFinanceDetail = {
  id: number;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  [key: string]: unknown;
};

export type PendingFinanceGroupData = {
  groupId: string;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  net_amount: number;
  posted_date: string;
  raw_details: PendingFinanceDetail[];
  group_kind?: PendingFinanceGroupKind;
  display_label?: string;
};

export type CandidateStock = {
  id: number;
  sku: string | null;
  condition: string | null;
  unit_cost: number;
  amazon_order_id: string | null;
  product_name: string | null;
  created_at: string | null;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  data: PendingFinanceGroupData | null;
  onSuccess?: () => void;
};

export default function ManualFinanceProcessModal({ isOpen, onClose, data, onSuccess }: Props) {
  const [candidateStocks, setCandidateStocks] = useState<CandidateStock[]>([]);
  const [selectedStockId, setSelectedStockId] = useState<number | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const details = data?.raw_details ?? [];
    const isOffsetQuad =
      data != null &&
      (data.group_kind === "offset_principal_tax" || isPrincipalTaxOffsetQuad(details));
    if (!isOpen || !data || data.transaction_type !== "Order" || isOffsetQuad) {
      setCandidateStocks([]);
      setSelectedStockId(null);
      setError(null);
      return;
    }
    setLoadingCandidates(true);
    setError(null);
    const params = new URLSearchParams();
    if (data.amazon_order_id) params.set("amazon_order_id", data.amazon_order_id);
    if (data.sku) params.set("sku", data.sku);
    fetch(`/api/amazon/candidate-stocks?${params}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        setCandidateStocks(Array.isArray(list) ? list : []);
        setSelectedStockId(null);
      })
      .catch(() => setCandidateStocks([]))
      .finally(() => setLoadingCandidates(false));
  }, [isOpen, data?.groupId, data?.amazon_order_id, data?.sku, data?.transaction_type, data?.group_kind, data?.raw_details]);

  const details = data?.raw_details ?? [];
  const netAmount = data?.net_amount ?? 0;
  const txType = data?.transaction_type ?? "";
  const isOffsetQuad =
    data != null &&
    (data.group_kind === "offset_principal_tax" || isPrincipalTaxOffsetQuad(details));

  const handlePrincipalTaxSettle = async (action: "offset" | "release_inbound") => {
    if (!data) return;
    const ids = details.map((d) => d.id);
    if (ids.length !== 4 || ids.some((id) => !Number.isFinite(id))) {
      setError("明細IDが不正です。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/manual-finance-principal-tax-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, salesTransactionIds: ids }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "処理に失敗しました");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmOrder = async () => {
    if (!data || selectedStockId == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/manual-reconcile-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: data.groupId, stockId: selectedStockId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "本消込に失敗しました");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "本消込に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="absolute inset-0"
        aria-hidden
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-200 flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-finance-modal-title"
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-6 py-4 shrink-0">
          <h2 id="manual-finance-modal-title" className="text-lg font-bold text-slate-800">
            手動処理 — {data?.amazon_order_id ?? data?.sku ?? data?.groupId ?? "未処理データ"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200 hover:text-slate-700 transition-colors"
            aria-label="閉じる"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* 左: 財務データ明細 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/30 overflow-hidden">
              <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                財務データの明細
              </h3>
              <div className="p-4">
                {details.length === 0 ? (
                  <p className="text-sm text-slate-500 py-4">明細がありません。</p>
                ) : (
                  <div className="space-y-1">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                          <th className="pb-2 pr-3">金額の種類</th>
                          <th className="pb-2 text-right w-28">金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.map((row) => {
                          const amount = Number(row.amount ?? 0);
                          const isNegative = amount < 0;
                          return (
                            <tr key={row.id} className="border-b border-slate-100 last:border-0">
                              <td className="py-2.5 pr-3 text-slate-700">
                                {row.amount_description ?? row.amount_type ?? "—"}
                              </td>
                              <td className={`py-2.5 text-right tabular-nums font-medium ${isNegative ? "text-red-600" : "text-slate-800"}`}>
                                {isNegative ? "−" : ""}
                                {Math.abs(amount).toLocaleString()} 円
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="mt-4 pt-4 border-t-2 border-slate-200">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-700">合計金額</span>
                        <span className={`text-xl font-bold tabular-nums ${netAmount >= 0 ? "text-slate-900" : "text-red-600"}`}>
                          {netAmount >= 0 ? "" : "−"}
                          {Math.abs(netAmount).toLocaleString()} 円
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 右: アクションエリア */}
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {isOffsetQuad && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    Principal / Tax 相殺
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      注文内で Principal / Tax のプラスがマイナスと相殺しているだけの場合、在庫を触らずに未消込リストから外すことができます。在庫に紐づく注文引当を解除してから相殺する場合は下のボタンを選んでください。
                    </p>
                    {error && <p className="text-sm text-red-600">{error}</p>}
                    <button
                      type="button"
                      onClick={() => void handlePrincipalTaxSettle("offset")}
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-slate-700 text-white py-2.5 px-4 text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "相殺のみ完結（在庫は触らない）"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePrincipalTaxSettle("release_inbound")}
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-amber-500 text-white py-2.5 px-4 text-sm font-semibold hover:bg-amber-600 disabled:opacity-50 transition-colors shadow-sm border border-amber-600/30"
                    >
                      {submitting ? "処理中..." : "在庫の注文引当を解除して復帰"}
                    </button>
                  </div>
                </>
              )}
              {!isOffsetQuad && txType === "Order" && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    紐付ける在庫の選択
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-500">
                      この注文に紐づける在庫を選び、本消込を実行します。
                    </p>
                    {loadingCandidates ? (
                      <p className="text-sm text-slate-500 py-4 text-center">在庫候補を取得中...</p>
                    ) : candidateStocks.length === 0 ? (
                      <p className="text-sm text-slate-500 py-4 text-center">紐付け可能な在庫がありません。</p>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3">
                        {candidateStocks.map((s) => (
                          <label key={s.id} className="flex items-center gap-3 cursor-pointer">
                            <input
                              type="radio"
                              name="stock-select"
                              checked={selectedStockId === s.id}
                              onChange={() => setSelectedStockId(s.id)}
                              className="rounded-full border-slate-300 text-blue-600"
                            />
                            <span className="text-sm text-slate-600">
                              ID: {s.id} — {s.product_name || s.sku || "—"} ({s.created_at ? new Date(s.created_at).toLocaleDateString("ja-JP") : ""})
                              {s.unit_cost ? ` · ${Number(s.unit_cost).toLocaleString()}円` : ""}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    {error && (
                      <p className="text-sm text-red-600">{error}</p>
                    )}
                    <button
                      type="button"
                      onClick={handleConfirmOrder}
                      disabled={selectedStockId == null || submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-blue-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "この在庫で売上確定（本消込）する"}
                    </button>
                  </div>
                </>
              )}
              {!isOffsetQuad && txType === "Refund" && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    返品処理
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      返品に伴い、過去に紐付けた在庫の注文紐付けを解除し、在庫に復帰させます。
                    </p>
                    <button
                      type="button"
                      onClick={() => console.log("返品処理実行", data?.groupId)}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-amber-500 text-white py-2.5 px-4 text-sm font-semibold hover:bg-amber-600 transition-colors shadow-sm border border-amber-600/30"
                    >
                      過去の注文紐付けを解除し、在庫に復帰させる
                    </button>
                  </div>
                </>
              )}
              {!isOffsetQuad &&
                (txType === "Adjustment" || (txType !== "Order" && txType !== "Refund")) && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    補填処理
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      該当SKUの最古の在庫を補填として処理します。
                    </p>
                    <button
                      type="button"
                      onClick={() => console.log("補填処理実行", data?.groupId)}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-emerald-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-emerald-700 transition-colors shadow-sm"
                    >
                      該当SKUの最古の在庫を補填として処理する
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
