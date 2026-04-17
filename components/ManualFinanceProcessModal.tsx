"use client";

import { useEffect, useMemo, useState } from "react";
import { isPrincipalTaxOffsetQuad } from "@/lib/amazon-principal-tax-quad";
import { consolidatedInternalNoteForEdit } from "@/lib/amazon-pending-finance-internal-note";
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
  internal_note?: string | null;
  [key: string]: unknown;
};

export type PendingFinanceGroupData = {
  groupId: string;
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  /** API 追加: 最古明細の transaction_type */
  representative_transaction_type?: string;
  net_amount: number;
  posted_date: string;
  raw_details: PendingFinanceDetail[];
  group_kind?: PendingFinanceGroupKind;
  display_label?: string;
  is_principal_tax_quad?: boolean;
  can_order_reconcile?: boolean;
  can_refund_positive_offset?: boolean;
  /** STEP5 カード用（API: pending-finances） */
  internal_note_summary?: string | null;
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

type ProcessMode =
  | "principal_tax_offset"
  | "order_reconcile"
  | "refund_positive_offset"
  | "adjustment_finance_only"
  | "adjustment_with_stock";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  data: PendingFinanceGroupData | null;
  onSuccess?: () => void;
};

function normalizeTxType(raw: string | null | undefined): string {
  return String(raw ?? "").normalize("NFKC").trim().toLowerCase();
}

function isAdjustmentTransactionType(raw: string | null | undefined): boolean {
  const t = normalizeTxType(raw);
  if (!t) return false;
  if (t === "adjustment") return true;
  if (t.includes("adjustment")) return true;
  // Amazon 日本語レポート
  if (raw != null && String(raw).normalize("NFKC").includes("調整")) return true;
  return false;
}

function isAdjustmentGroupData(data: PendingFinanceGroupData): boolean {
  if (data.group_kind === "adjustment_like") return true;
  const rows = data.raw_details ?? [];
  if (rows.some((r) => isAdjustmentTransactionType(r.transaction_type))) return true;
  if (isAdjustmentTransactionType(data.transaction_type)) return true;
  if (isAdjustmentTransactionType(data.representative_transaction_type)) return true;
  return false;
}

function isQuadFromData(data: PendingFinanceGroupData): boolean {
  return (
    data.is_principal_tax_quad === true ||
    data.group_kind === "offset_principal_tax" ||
    isPrincipalTaxOffsetQuad(data.raw_details ?? [])
  );
}

function buildModeOptions(data: PendingFinanceGroupData): { id: ProcessMode; label: string }[] {
  const isQuad = isQuadFromData(data);
  const isAdjustment = isAdjustmentGroupData(data);
  const opts: { id: ProcessMode; label: string }[] = [];
  if (isQuad) opts.push({ id: "principal_tax_offset", label: "Principal / Tax 相殺（在庫は基本触らない）" });
  // 調整は用途が混在し得るため、API側の可否に依存せず選択肢を出す（危険操作は実行前に二段確認）
  if (isAdjustment) {
    opts.push({ id: "adjustment_finance_only", label: "補填・財務のみ完結（推奨）" });
    opts.push({ id: "adjustment_with_stock", label: "補填・在庫にも紐付け（SKU→JAN候補から選択）" });
  }
  if (data.amazon_order_id?.trim()) {
    opts.push({ id: "order_reconcile", label: "注文売上の本消込（在庫を選択）※調整では通常不要" });
  }
  if (data.amazon_order_id?.trim()) {
    opts.push({ id: "refund_positive_offset", label: "返金＋プラス売上の相殺完結（在庫は触らない）※条件により失敗します" });
  }
  return opts;
}

function defaultProcessMode(data: PendingFinanceGroupData | null): ProcessMode {
  if (!data) return "order_reconcile";
  if (isQuadFromData(data)) return "principal_tax_offset";
  if (isAdjustmentGroupData(data)) {
    return "adjustment_finance_only";
  }
  if (data.can_refund_positive_offset) return "refund_positive_offset";
  if (data.can_order_reconcile) return "order_reconcile";
  return "adjustment_finance_only";
}

export default function ManualFinanceProcessModal({ isOpen, onClose, data, onSuccess }: Props) {
  const [processMode, setProcessMode] = useState<ProcessMode>("order_reconcile");
  const [candidateStocks, setCandidateStocks] = useState<CandidateStock[]>([]);
  const [adjustmentCandidates, setAdjustmentCandidates] = useState<CandidateStock[]>([]);
  const [selectedStockId, setSelectedStockId] = useState<number | null>(null);
  const [selectedAdjustmentStockId, setSelectedAdjustmentStockId] = useState<number | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadingAdjustmentCandidates, setLoadingAdjustmentCandidates] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReleaseInbound, setShowReleaseInbound] = useState(false);
  const [internalNote, setInternalNote] = useState("");

  const details = data?.raw_details ?? [];
  const netAmount = data?.net_amount ?? 0;
  const isQuad = data != null && isQuadFromData(data);
  const isAdjustment = data != null && isAdjustmentGroupData(data);

  const modeOptions = data ? buildModeOptions(data) : [];

  const rawDetailsNoteSig = useMemo(
    () => (data?.raw_details ?? []).map((d) => `${d.id}:${String(d.internal_note ?? "")}`).join("|"),
    [data?.groupId, data?.raw_details]
  );

  async function persistInternalNoteIfNeeded(ids: number[]): Promise<void> {
    const note = internalNote.trim();
    if (!note) return;
    if (ids.length === 0) return;
    const res = await fetch("/api/amazon/sales-transactions/internal-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ salesTransactionIds: ids, internal_note: note }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "internal_note の保存に失敗しました");
  }

  function confirmHeavyAction(label: string): boolean {
    const first = window.confirm(
      `${label}\n\nこの操作は在庫・売上整合に影響します。本当に続行しますか？\n（調整行では誤用に注意してください）`
    );
    if (!first) return false;
    return window.confirm("最終確認: 続行しますか？");
  }

  useEffect(() => {
    if (!isOpen || !data) return;
    const opts = buildModeOptions(data);
    const allowed = new Set(opts.map((o) => o.id));
    const d = defaultProcessMode(data);
    setProcessMode(allowed.has(d) ? d : (opts[0]?.id ?? "order_reconcile"));
    setSelectedStockId(null);
    setSelectedAdjustmentStockId(null);
    setError(null);
    setShowReleaseInbound(false);
    setInternalNote(consolidatedInternalNoteForEdit(data.raw_details ?? []));
  }, [
    isOpen,
    data?.groupId,
    data?.amazon_order_id,
    data?.transaction_type,
    data?.representative_transaction_type,
    data?.group_kind,
    data?.can_order_reconcile,
    data?.can_refund_positive_offset,
    data?.is_principal_tax_quad,
    rawDetailsNoteSig,
  ]);

  useEffect(() => {
    if (!isOpen || !data || processMode !== "order_reconcile" || !data.amazon_order_id || isQuad) {
      setCandidateStocks([]);
      setSelectedStockId(null);
      return;
    }
    setLoadingCandidates(true);
    const params = new URLSearchParams();
    params.set("amazon_order_id", data.amazon_order_id);
    if (data.sku) params.set("sku", data.sku);
    fetch(`/api/amazon/candidate-stocks?${params}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        setCandidateStocks(Array.isArray(list) ? list : []);
        setSelectedStockId(null);
      })
      .catch(() => setCandidateStocks([]))
      .finally(() => setLoadingCandidates(false));
  }, [isOpen, data?.groupId, data?.amazon_order_id, data?.sku, processMode, isQuad]);

  useEffect(() => {
    if (!isOpen || !data || processMode !== "adjustment_with_stock") {
      setAdjustmentCandidates([]);
      setSelectedAdjustmentStockId(null);
      return;
    }
    const sku = (data.sku ?? "").trim();
    if (!sku) {
      setAdjustmentCandidates([]);
      return;
    }
    setLoadingAdjustmentCandidates(true);
    fetch(`/api/amazon/adjustment-inbound-candidates?sku=${encodeURIComponent(sku)}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        setAdjustmentCandidates(Array.isArray(list) ? list : []);
        setSelectedAdjustmentStockId(null);
      })
      .catch(() => setAdjustmentCandidates([]))
      .finally(() => setLoadingAdjustmentCandidates(false));
  }, [isOpen, data?.groupId, data?.sku, processMode]);

  const handlePrincipalTaxSettle = async (action: "offset" | "release_inbound") => {
    if (!data) return;
    const ids = details.map((d) => d.id);
    if (ids.length !== 4 || ids.some((id) => !Number.isFinite(id))) {
      setError("明細IDが不正です。");
      return;
    }
    if (action === "release_inbound") {
      if (!confirmHeavyAction("Principal/Tax 相殺: 在庫の注文引当を解除")) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await persistInternalNoteIfNeeded(ids);
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
    if (!confirmHeavyAction("注文売上の本消込（在庫へ紐付け）")) return;
    setSubmitting(true);
    setError(null);
    try {
      await persistInternalNoteIfNeeded(details.map((d) => d.id));
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

  const handleRefundPositiveOffset = async () => {
    if (!data?.amazon_order_id) return;
    if (!confirmHeavyAction("返金＋プラス売上の相殺完結")) return;
    setSubmitting(true);
    setError(null);
    try {
      await persistInternalNoteIfNeeded(details.map((d) => d.id));
      const res = await fetch("/api/amazon/manual-finance-refund-offset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: data.amazon_order_id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "相殺に失敗しました");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "相殺に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdjustmentSettle = async (withStock: boolean) => {
    if (!data) return;
    const ids = details.map((d) => d.id);
    if (ids.length === 0) {
      setError("明細がありません。");
      return;
    }
    if (withStock && selectedAdjustmentStockId == null) {
      setError("在庫を選択してください。");
      return;
    }
    if (withStock) {
      if (!confirmHeavyAction("補填: 在庫へ紐付け（settled_at 更新）")) return;
    } else if (internalNote.trim()) {
      // メモのみでも確認（誤記防止）
      if (!confirmHeavyAction("補填: 財務のみ消込（メモ付き）")) return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // internal_note は adjustment-settle API 側でまとめて更新する（二重更新を避ける）
      const res = await fetch("/api/amazon/manual-finance-adjustment-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesTransactionIds: ids,
          stockId: withStock ? selectedAdjustmentStockId : null,
          internal_note: internalNote.trim() ? internalNote.trim() : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "補填の消込に失敗しました");
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "補填の消込に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="absolute inset-0" aria-hidden onClick={onClose} />
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
          <p className="mb-4 text-xs text-slate-600 leading-relaxed">
            処理内容を選んでから確定してください。返金の<strong>実物在庫</strong>は返品検品・在庫画面で扱い、ここでは<strong>財務上の相殺・本消込・補填の消込</strong>に限定します（補填で在庫に紐付ける場合は下で明示的に選択）。
          </p>

          {modeOptions.length > 1 && (
            <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50/80 p-3">
              <p className="text-xs font-semibold text-slate-700 mb-2">処理モード</p>
              <div className="flex flex-col gap-2">
                {modeOptions.map((o) => (
                  <label key={o.id} className="flex items-start gap-2 cursor-pointer text-sm text-slate-700">
                    <input
                      type="radio"
                      name="process-mode"
                      checked={processMode === o.id}
                      onChange={() => {
                        setProcessMode(o.id);
                        setError(null);
                      }}
                      className="mt-0.5 border-slate-300 text-blue-600"
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {isAdjustment && (
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <p className="text-xs font-semibold text-amber-950 mb-2">調整行の注意</p>
              <p className="text-xs text-amber-950/90 leading-relaxed">
                「調整」は補填だけとは限りません。基本は <span className="font-semibold">財務のみ完結</span> を推奨します。
                本消込・返金相殺は在庫/売上整合に影響するため、実行前に二段確認が出ます。
              </p>
            </div>
          )}

          {data ? (
            <div className="mb-5 rounded-lg border border-slate-200 bg-white p-3">
              <label className="block text-xs font-semibold text-slate-700 mb-2" htmlFor="internal-note">
                社内メモ（任意）<span className="font-normal text-slate-500"> — sales_transactions.internal_note</span>
              </label>
              <textarea
                id="internal-note"
                value={internalNote}
                onChange={(e) => setInternalNote(e.target.value)}
                rows={3}
                placeholder="例: 関連JAN=4901234567890 / 元注文=249-xxxx / 補填理由=..."
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300/30"
              />
              <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                このグループの全明細に同じ内容で保存されます（複数の既存メモは編集用に区切りで連結表示）。DBに{" "}
                <span className="font-mono">internal_note</span> 列が無い場合は、先に{" "}
                <span className="font-mono">docs/migration_sales_transactions_internal_note.sql</span> を Supabase で実行してください。
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
                              <td
                                className={`py-2.5 text-right tabular-nums font-medium ${isNegative ? "text-red-600" : "text-slate-800"}`}
                              >
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

            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {error && <p className="text-sm text-red-600 px-4 pt-4">{error}</p>}

              {processMode === "principal_tax_offset" && isQuad && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    Principal / Tax 相殺
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      注文内で Principal / Tax のプラスとマイナスが相殺しているだけの場合、在庫を変えずに未消込から外せます。
                    </p>
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
                      onClick={() => setShowReleaseInbound((v) => !v)}
                      className="text-xs text-slate-500 underline"
                    >
                      在庫の注文引当を戻す必要がある場合
                    </button>
                    {showReleaseInbound && (
                      <button
                        type="button"
                        onClick={() => void handlePrincipalTaxSettle("release_inbound")}
                        disabled={submitting}
                        className="w-full inline-flex items-center justify-center rounded-lg bg-amber-500 text-white py-2.5 px-4 text-sm font-semibold hover:bg-amber-600 disabled:opacity-50 transition-colors shadow-sm border border-amber-600/30"
                      >
                        {submitting ? "処理中..." : "在庫の注文引当を解除してから相殺"}
                      </button>
                    )}
                  </div>
                </>
              )}

              {processMode === "order_reconcile" && Boolean(data?.amazon_order_id?.trim()) && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    紐付ける在庫の選択
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-500">
                      この注文に紐づける在庫を選び、本消込を実行します（棚卸のため在庫と売上を一致させます）。
                    </p>
                    {isAdjustment && !data?.can_order_reconcile ? (
                      <p className="text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
                        注意: このグループは自動判定では「注文本消込」対象外です。調整行に対して本消込を実行すると失敗する可能性があります。
                      </p>
                    ) : null}
                    {loadingCandidates ? (
                      <p className="text-sm text-slate-500 py-4 text-center">在庫候補を取得中...</p>
                    ) : candidateStocks.length === 0 ? (
                      <p className="text-sm text-slate-500 py-4 text-center">
                        紐付け可能な在庫がありません。検索で候補を広げる場合は Amazon 消込の在庫レスキューと同様に、必要なら別途検索UIを追加できます。
                      </p>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3 max-h-56 overflow-y-auto">
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
                              ID: {s.id} — {s.product_name || s.sku || "—"} (
                              {s.created_at ? new Date(s.created_at).toLocaleDateString("ja-JP") : ""})
                              {s.unit_cost ? ` · ${Number(s.unit_cost).toLocaleString()}円` : ""}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleConfirmOrder()}
                      disabled={selectedStockId == null || submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-blue-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "この在庫で売上確定（本消込）する"}
                    </button>
                  </div>
                </>
              )}

              {processMode === "refund_positive_offset" && Boolean(data?.amazon_order_id?.trim()) && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    返金＋プラス売上の相殺
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      同一注文でプラスの売上行と返金行が揃っている場合、在庫を変えずに財務上だけ相殺済みにできます（自動本消込と同じ考え方）。
                    </p>
                    {!data?.can_refund_positive_offset ? (
                      <p className="text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
                        注意: このグループは自動判定では「返金相殺」条件を満たしていません。実行するとAPI側で拒否される可能性があります。
                      </p>
                    ) : null}
                    <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1.5">
                      返品の実物在庫は「返品検品」等の在庫フローで処理してください。
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleRefundPositiveOffset()}
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-violet-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-violet-700 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "相殺完結（在庫は触らない）"}
                    </button>
                  </div>
                </>
              )}

              {processMode === "adjustment_finance_only" && isAdjustment && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    補填・財務のみ
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      補填・クレーム等の明細を、在庫を変えずに消込リストから外します。
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleAdjustmentSettle(false)}
                      disabled={submitting}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-emerald-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "財務のみ消込する"}
                    </button>
                  </div>
                </>
              )}

              {processMode === "adjustment_with_stock" && isAdjustment && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    補填・在庫にも紐付け
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      seller SKU から JAN を解き、該当 JAN の在庫候補を表示します。正の金額行に在庫と原価を付け、在庫に settled_at を立てます（order_id は変更しません）。
                    </p>
                    {!data?.sku?.trim() ? (
                      <p className="text-sm text-amber-700">明細に SKU が無いため候補を出せません。財務のみ消込を選ぶか、データ取込を確認してください。</p>
                    ) : loadingAdjustmentCandidates ? (
                      <p className="text-sm text-slate-500 py-4 text-center">在庫候補を取得中...</p>
                    ) : adjustmentCandidates.length === 0 ? (
                      <p className="text-sm text-slate-500 py-4 text-center">候補在庫がありません（マッピング・JAN を確認）。</p>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3 max-h-56 overflow-y-auto">
                        {adjustmentCandidates.map((s) => (
                          <label key={s.id} className="flex items-center gap-3 cursor-pointer">
                            <input
                              type="radio"
                              name="adj-stock-select"
                              checked={selectedAdjustmentStockId === s.id}
                              onChange={() => setSelectedAdjustmentStockId(s.id)}
                              className="rounded-full border-slate-300 text-emerald-600"
                            />
                            <span className="text-sm text-slate-600">
                              ID: {s.id} — {s.product_name || s.sku || "—"} (
                              {s.created_at ? new Date(s.created_at).toLocaleDateString("ja-JP") : ""})
                              {s.unit_cost ? ` · ${Number(s.unit_cost).toLocaleString()}円` : ""}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleAdjustmentSettle(true)}
                      disabled={submitting || !data?.sku?.trim() || selectedAdjustmentStockId == null}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-emerald-700 text-white py-2.5 px-4 text-sm font-semibold hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "在庫を紐付けて消込する"}
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
