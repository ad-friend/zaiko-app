"use client";

import { useEffect, useMemo, useState } from "react";
import { isPrincipalTaxOffsetQuad } from "@/lib/amazon-principal-tax-quad";
import { consolidatedInternalNoteForEdit } from "@/lib/amazon-pending-finance-internal-note";
import { isExpenseSkipTxForRefundOffset, toNumberAmount } from "@/lib/amazon-refund-offset-like";
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
  item_quantity?: number;
  finance_line_group_id?: string | null;
  needs_quantity_review?: boolean;
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
  needs_quantity_review?: boolean;
  /** API: pending-finances の分類追加（無い環境でも動くよう optional） */
  suggestedCategory?: "Refund" | "Adjustment" | "Mixed" | null;
  hasRefund?: boolean;
  hasAdjustment?: boolean;
  /** API: pending-finances が返す refund_qty（バックエンドを正） */
  refund_qty?: number;
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
  onToast?: (t: { message: string; variant: "success" | "error" }) => void;
};

type CardCategory = "Refund" | "Adjustment" | "Mixed" | "Other";

function toCardCategory(raw: unknown): CardCategory {
  const s = String(raw ?? "").trim();
  if (s === "Refund" || s === "Adjustment" || s === "Mixed") return s;
  return "Other";
}

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

type ApiCandidateRow = {
  id: number;
  sku: string | null;
  brand: string | null;
  model_number: string | null;
  condition: string | null;
  unit_cost: number;
  created_at: string | null;
  amazon_order_id: string | null;
};

function mapApiRowsToCandidateStocks(list: unknown): CandidateStock[] {
  if (!Array.isArray(list)) return [];
  return (list as ApiCandidateRow[])
    .map((r) => ({
      id: Number(r.id),
      sku: r.sku ?? null,
      condition: r.condition ?? null,
      unit_cost: Number(r.unit_cost ?? 0),
      amazon_order_id: r.amazon_order_id ?? null,
      product_name:
        [r.brand, r.model_number]
          .map((x) => String(x ?? "").trim())
          .filter(Boolean)
          .join(" / ") || null,
      created_at: r.created_at ?? null,
    }))
    .filter((x) => Number.isFinite(x.id) && x.id >= 1);
}

function mergeCandidateStocksById(base: CandidateStock[], extra: CandidateStock[]): CandidateStock[] {
  const m = new Map<number, CandidateStock>();
  for (const c of base) m.set(c.id, c);
  for (const c of extra) m.set(c.id, c);
  return [...m.values()].sort((a, b) => a.id - b.id);
}

export default function ManualFinanceProcessModal({ isOpen, onClose, data, onSuccess, onToast }: Props) {
  const [processMode, setProcessMode] = useState<ProcessMode>("order_reconcile");
  const [cardCategory, setCardCategory] = useState<CardCategory>("Other");
  const [refundQty, setRefundQty] = useState(0);
  const [dispositions, setDispositions] = useState<{ new: number; used: number; junk: number }>({
    new: 0,
    used: 0,
    junk: 0,
  });
  const [candidateStocks, setCandidateStocks] = useState<CandidateStock[]>([]);
  const [adjustmentCandidates, setAdjustmentCandidates] = useState<CandidateStock[]>([]);
  const [selectedStockId, setSelectedStockId] = useState<number | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [loadingAdjustmentCandidates, setLoadingAdjustmentCandidates] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReleaseInbound, setShowReleaseInbound] = useState(false);
  const [internalNote, setInternalNote] = useState("");
  /** 本消込: Amazon 消込カードと同様の JAN/商品名レスキュー検索 */
  const [orderRescueQuery, setOrderRescueQuery] = useState("");
  const [orderRescueLoading, setOrderRescueLoading] = useState(false);
  const [orderRescueError, setOrderRescueError] = useState<string | null>(null);
  const [orderRescueExtra, setOrderRescueExtra] = useState<CandidateStock[]>([]);
  /** 補填・在庫紐付け: 同上 */
  const [adjustmentRescueQuery, setAdjustmentRescueQuery] = useState("");
  const [adjustmentRescueLoading, setAdjustmentRescueLoading] = useState(false);
  const [adjustmentRescueError, setAdjustmentRescueError] = useState<string | null>(null);
  const [adjustmentRescueExtra, setAdjustmentRescueExtra] = useState<CandidateStock[]>([]);
  /** 補填の正の明細行ごとの在庫 inbound_items.id */
  const [adjustmentStockByTxId, setAdjustmentStockByTxId] = useState<Record<number, number | null>>({});

  const details = data?.raw_details ?? [];
  const netAmount = data?.net_amount ?? 0;
  const isQuad = data != null && isQuadFromData(data);
  const isAdjustment = data != null && isAdjustmentGroupData(data);

  const dispositionSum = dispositions.new + dispositions.used + dispositions.junk;
  const dispositionSumOk = refundQty === 0 ? dispositionSum === 0 : dispositionSum === refundQty;

  const adjustmentAttachRows = useMemo(() => {
    return details.filter(
      (row) =>
        toNumberAmount(row.amount) > 0 &&
        !isExpenseSkipTxForRefundOffset({
          amount_type: row.amount_type,
          transaction_type: row.transaction_type,
          amount_description: row.amount_description,
        })
    );
  }, [details]);

  const modeOptions = data ? buildModeOptions(data) : [];

  const rawDetailsNoteSig = useMemo(
    () => (data?.raw_details ?? []).map((d) => `${d.id}:${String(d.internal_note ?? "")}`).join("|"),
    [data?.groupId, data?.raw_details]
  );

  const mergedOrderCandidates = useMemo(
    () => mergeCandidateStocksById(candidateStocks, orderRescueExtra),
    [candidateStocks, orderRescueExtra]
  );
  const mergedAdjustmentCandidates = useMemo(
    () => mergeCandidateStocksById(adjustmentCandidates, adjustmentRescueExtra),
    [adjustmentCandidates, adjustmentRescueExtra]
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

  async function runOrderRescueSearch() {
    if (!data?.amazon_order_id?.trim()) {
      setOrderRescueError("注文番号がありません。");
      return;
    }
    const q = orderRescueQuery.trim();
    if (!q) {
      setOrderRescueError("検索語を入力してください。");
      return;
    }
    setOrderRescueLoading(true);
    setOrderRescueError(null);
    try {
      const params = new URLSearchParams({ search: q, amazon_order_id: data.amazon_order_id.trim() });
      if (data.sku?.trim()) params.set("sku", data.sku.trim());
      const res = await fetch(`/api/amazon/candidate-stocks?${params}`);
      const raw: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          raw &&
          typeof raw === "object" &&
          "error" in raw &&
          typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : "検索に失敗しました。";
        throw new Error(msg);
      }
      const mapped = mapApiRowsToCandidateStocks(raw);
      setOrderRescueExtra(mapped);
      if (mapped.length === 0) setOrderRescueError("該当する在庫がありませんでした。");
    } catch (e) {
      setOrderRescueError(e instanceof Error ? e.message : "検索に失敗しました。");
    } finally {
      setOrderRescueLoading(false);
    }
  }

  async function runAdjustmentRescueSearch() {
    const q = adjustmentRescueQuery.trim();
    if (!q) {
      setAdjustmentRescueError("検索語を入力してください。");
      return;
    }
    setAdjustmentRescueLoading(true);
    setAdjustmentRescueError(null);
    try {
      const params = new URLSearchParams({ search: q });
      const oid = data?.amazon_order_id?.trim();
      if (oid) params.set("amazon_order_id", oid);
      const res = await fetch(`/api/amazon/candidate-stocks?${params}`);
      const raw: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          raw &&
          typeof raw === "object" &&
          "error" in raw &&
          typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : "検索に失敗しました。";
        throw new Error(msg);
      }
      const mapped = mapApiRowsToCandidateStocks(raw);
      setAdjustmentRescueExtra(mapped);
      if (mapped.length === 0) setAdjustmentRescueError("該当する在庫がありませんでした。");
    } catch (e) {
      setAdjustmentRescueError(e instanceof Error ? e.message : "検索に失敗しました。");
    } finally {
      setAdjustmentRescueLoading(false);
    }
  }

  useEffect(() => {
    if (!isOpen || !data) return;
    const opts = buildModeOptions(data);
    const allowed = new Set(opts.map((o) => o.id));
    const d = defaultProcessMode(data);
    setProcessMode(allowed.has(d) ? d : (opts[0]?.id ?? "order_reconcile"));
    setCardCategory(toCardCategory(data.suggestedCategory));
    {
      const q = Number((data as { refund_qty?: unknown }).refund_qty ?? 0);
      const qty = Number.isFinite(q) ? Math.max(0, Math.trunc(q)) : 0;
      setRefundQty(qty);
      setDispositions({ new: qty, used: 0, junk: 0 });
    }
    setSelectedStockId(null);
    {
      const m: Record<number, number | null> = {};
      for (const r of data.raw_details ?? []) {
        if (
          toNumberAmount(r.amount) > 0 &&
          !isExpenseSkipTxForRefundOffset({
            amount_type: r.amount_type,
            transaction_type: r.transaction_type,
            amount_description: r.amount_description,
          })
        ) {
          m[r.id] = null;
        }
      }
      setAdjustmentStockByTxId(m);
    }
    setError(null);
    setShowReleaseInbound(false);
    setInternalNote(consolidatedInternalNoteForEdit(data.raw_details ?? []));
    setOrderRescueQuery("");
    setOrderRescueError(null);
    setOrderRescueExtra([]);
    setAdjustmentRescueQuery("");
    setAdjustmentRescueError(null);
    setAdjustmentRescueExtra([]);
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
    data?.suggestedCategory,
    data?.refund_qty,
    rawDetailsNoteSig,
  ]);

  useEffect(() => {
    if (!isOpen || !data || processMode !== "order_reconcile" || !data.amazon_order_id || isQuad) {
      setCandidateStocks([]);
      setSelectedStockId(null);
      setOrderRescueExtra([]);
      setOrderRescueQuery("");
      setOrderRescueError(null);
      return;
    }
    setOrderRescueExtra([]);
    setOrderRescueQuery("");
    setOrderRescueError(null);
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
      setAdjustmentRescueExtra([]);
      setAdjustmentRescueQuery("");
      setAdjustmentRescueError(null);
      return;
    }
    setAdjustmentRescueExtra([]);
    setAdjustmentRescueQuery("");
    setAdjustmentRescueError(null);
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

  const handleRefundRelease = async () => {
    if (!data) return;
    const ids = details.map((d) => d.id).filter((n) => Number.isFinite(n) && n >= 1);
    if (ids.length === 0) {
      setError("明細IDが不正です。");
      return;
    }

    if (!dispositionSumOk) {
      setError(refundQty === 0 ? "返金数量が0のため、内訳数量はすべて 0 にしてください。" : "新品/中古/ジャンクの合計が返金数量と一致しません。");
      return;
    }

    const ok = window.confirm(
      "返金処理＆在庫戻しを実行します。\n" +
        "在庫は「未処理のものだけ」戻し、返品済み・フリー在庫はスキップされます。\n" +
        "続行しますか？"
    );
    if (!ok) return;

    setSubmitting(true);
    setError(null);
    try {
      await persistInternalNoteIfNeeded(ids);
      const res = await fetch("/api/amazon/manual-finance-refund-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesTransactionIds: ids,
          amazon_order_id: data.amazon_order_id ?? null,
          refund_qty: refundQty,
          dispositions,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(json.error ?? "処理に失敗しました");

      const updatedSales = Number(json.updated_sales_tx_count ?? 0);
      const updatedInbound = Number(json.updated_inbound_count ?? 0);
      const skipped = Number(json.skipped_total ?? (Number(json.skipped_already_free ?? 0) + Number(json.skipped_return_flagged ?? 0)));
      const updatedNew = Number(json.updated_inbound_new ?? 0);
      const updatedUsed = Number(json.updated_inbound_used ?? 0);
      const updatedJunk = Number(json.updated_inbound_junk ?? 0);

      onToast?.({
        variant: "success",
        message: `✅ ${updatedSales}件の明細を消込完了。在庫を${updatedInbound}件戻しました（新品: ${updatedNew}, 中古: ${updatedUsed}, ジャンク: ${updatedJunk} / スキップ: ${skipped}件）`,
      });

      onSuccess?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "処理に失敗しました";
      onToast?.({ variant: "error", message: `❌ ${msg}` });
      setError(msg);
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
    if (withStock) {
      if (adjustmentAttachRows.length === 0) {
        setError("在庫に紐付けられる正の明細がありません。");
        return;
      }
      const allPicked = adjustmentAttachRows.every(
        (r) => adjustmentStockByTxId[r.id] != null && Number(adjustmentStockByTxId[r.id]) >= 1
      );
      if (!allPicked) {
        setError("正の明細ごとに在庫を選択してください。");
        return;
      }
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
      // 補填APIは1明細に複数在庫可のため、代表明細ID（正の明細の先頭）に全選択在庫を紐づけて送る
      const allocations = withStock
        ? (() => {
            const repSalesTransactionId = adjustmentAttachRows[0]!.id;
            const stockIdSet = new Set<number>();
            for (const r of adjustmentAttachRows) {
              const inv = adjustmentStockByTxId[r.id];
              if (inv != null && Number(inv) >= 1) stockIdSet.add(Number(inv));
            }
            return [...stockIdSet].map((stockId) => ({
              salesTransactionId: repSalesTransactionId,
              stockId,
            }));
          })()
        : undefined;
      const res = await fetch("/api/amazon/manual-finance-adjustment-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesTransactionIds: ids,
          stockId: null,
          allocations: withStock ? allocations : undefined,
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

          {data ? (
            <div className="mb-5 rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-700 mb-2">種別（手動）</p>
              <select
                value={cardCategory}
                onChange={(e) => {
                  const next = e.target.value as CardCategory;
                  setCardCategory(next);
                  setError(null);
                  if (next === "Refund" || next === "Mixed") {
                    // Refundは専用APIで処理する（在庫戻し含む）
                    return;
                  }
                  if (next === "Adjustment") {
                    setProcessMode("adjustment_finance_only");
                  }
                }}
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800"
              >
                <option value="Refund">Refund（返金）</option>
                <option value="Adjustment">Adjustment（補填）</option>
                <option value="Mixed">Mixed（返品＆補填）</option>
                <option value="Other">Other</option>
              </select>
              <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                初期値は自動判別（pending-finances）です。モーダルを閉じるとリセットされます（DB保存しません）。
              </p>
            </div>
          ) : null}

          {/* 種別=Other のときのみ従来の処理モードを表示 */}
          {cardCategory === "Other" && modeOptions.length > 1 && (
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

          {/* 種別=Adjustment のときは補填モードを明示（JAN検索UIを有効化） */}
          {cardCategory === "Adjustment" && (
            <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
              <p className="text-xs font-semibold text-emerald-950 mb-2">補填モード</p>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 cursor-pointer text-sm text-emerald-950">
                  <input
                    type="radio"
                    name="adjustment-mode"
                    checked={processMode === "adjustment_finance_only"}
                    onChange={() => {
                      setProcessMode("adjustment_finance_only");
                      setError(null);
                    }}
                    className="mt-0.5 border-slate-300 text-emerald-600"
                  />
                  <span>補填・財務のみ完結</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer text-sm text-emerald-950">
                  <input
                    type="radio"
                    name="adjustment-mode"
                    checked={processMode === "adjustment_with_stock"}
                    onChange={() => {
                      setProcessMode("adjustment_with_stock");
                      setError(null);
                    }}
                    className="mt-0.5 border-slate-300 text-emerald-600"
                  />
                  <span>補填・在庫にも紐付け（JAN検索・引当）</span>
                </label>
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

          {(data?.needs_quantity_review === true || details.some((d) => d.needs_quantity_review === true)) && (
            <div className="mb-5 rounded-lg border border-amber-300 bg-amber-100/80 p-3">
              <p className="text-xs font-semibold text-amber-950">要確認</p>
              <p className="text-xs text-amber-950/95 mt-1 leading-relaxed">
                Amazon 明細で個数・単価・合計の「確実」条件を満たしていません。内容を確認してから消込してください。
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

              {(cardCategory === "Refund" || cardCategory === "Mixed") && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    返金処理＆在庫戻し
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600 leading-relaxed">
                      このグループの明細を消込完了にし、返金数量分だけ在庫の引当（order_id / settled_at）を解除します。
                      返品済み（return_inspection / disposed / junk_return）や既にフリーの在庫はスキップされます。
                    </p>

                    {refundQty === 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                        <p className="text-xs text-amber-950 leading-relaxed">
                          ※返金数量が特定できない（0）ため、在庫ステータスは更新されません（財務の消込のみ実行されます）。
                        </p>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-slate-200 bg-white p-3">
                        <p className="text-xs font-semibold text-slate-700 mb-2">返品後のコンディション内訳（数量）</p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          <label className="flex flex-col items-center rounded-md border border-slate-200 bg-slate-50/50 px-3 py-2">
                            <span className="text-xs font-medium text-slate-700">新品（new）</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={dispositions.new}
                              disabled={submitting}
                              onChange={(e) => {
                                const n = Math.max(0, Math.trunc(Number(e.target.value)));
                                setDispositions((prev) => ({ ...prev, new: Number.isFinite(n) ? n : 0 }));
                                setError(null);
                              }}
                              className="mt-1 w-full max-w-24 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 text-center tabular-nums"
                            />
                          </label>
                          <label className="flex flex-col items-center rounded-md border border-slate-200 bg-slate-50/50 px-3 py-2">
                            <span className="text-xs font-medium text-slate-700">中古（used）</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={dispositions.used}
                              disabled={submitting}
                              onChange={(e) => {
                                const n = Math.max(0, Math.trunc(Number(e.target.value)));
                                setDispositions((prev) => ({ ...prev, used: Number.isFinite(n) ? n : 0 }));
                                setError(null);
                              }}
                              className="mt-1 w-full max-w-24 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 text-center tabular-nums"
                            />
                          </label>
                          <label className="flex flex-col items-center rounded-md border border-slate-200 bg-slate-50/50 px-3 py-2">
                            <span className="text-xs font-medium text-slate-700">ジャンク（junk）</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={dispositions.junk}
                              disabled={submitting}
                              onChange={(e) => {
                                const n = Math.max(0, Math.trunc(Number(e.target.value)));
                                setDispositions((prev) => ({ ...prev, junk: Number.isFinite(n) ? n : 0 }));
                                setError(null);
                              }}
                              className="mt-1 w-full max-w-24 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 text-center tabular-nums"
                            />
                          </label>
                        </div>
                        <p className={`mt-2 text-[11px] leading-relaxed ${dispositionSumOk ? "text-slate-500" : "text-red-600 font-medium"}`}>
                          返金数量: {refundQty} / 入力合計: {dispositionSum}
                          {!dispositionSumOk ? "（合計が一致するよう調整してください）" : ""}
                        </p>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleRefundRelease()}
                      disabled={submitting || !dispositionSumOk}
                      className="w-full inline-flex items-center justify-center rounded-lg bg-amber-600 text-white py-2.5 px-4 text-sm font-semibold hover:bg-amber-700 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      {submitting ? "処理中..." : "返金処理＆在庫戻しを実行"}
                    </button>
                  </div>
                </>
              )}

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

              {cardCategory === "Other" && processMode === "order_reconcile" && Boolean(data?.amazon_order_id?.trim()) && (
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
                    ) : mergedOrderCandidates.length === 0 ? (
                      <div className="space-y-2 rounded-lg border border-red-100 bg-red-50/50 p-3">
                        <p className="text-xs font-semibold text-red-800 flex items-start gap-1.5 leading-snug">
                          <span className="shrink-0" aria-hidden>
                            ⚠
                          </span>
                          紐付け可能な在庫がありません。JAN / ASIN を確認し在庫を登録してください。
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                          <input
                            type="text"
                            value={orderRescueQuery}
                            onChange={(e) => setOrderRescueQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void runOrderRescueSearch();
                              }
                            }}
                            placeholder="例: 4901234567890 または 商品名の一部"
                            disabled={orderRescueLoading || submitting}
                            className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                          />
                          <button
                            type="button"
                            onClick={() => void runOrderRescueSearch()}
                            disabled={orderRescueLoading || submitting}
                            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-sky-700 px-4 text-xs font-medium text-white hover:bg-sky-800 disabled:bg-slate-300"
                          >
                            {orderRescueLoading ? "検索中…" : "検索"}
                          </button>
                        </div>
                        {orderRescueError ? <p className="text-[11px] font-medium text-red-700">{orderRescueError}</p> : null}
                        {orderRescueExtra.length > 0 ? (
                          <p className="text-[11px] text-sky-800/90">レスキュー検索で {orderRescueExtra.length} 件ヒット（下の候補に反映されます）</p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/50 p-3 max-h-56 overflow-y-auto">
                        {mergedOrderCandidates.map((s) => (
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
                    {mergedOrderCandidates.length > 0 && !loadingCandidates ? (
                      <div className="space-y-2 rounded-lg border border-sky-100 bg-sky-50/40 p-3">
                        <p className="text-[11px] text-slate-600 leading-snug">
                          自動候補に無い場合: JAN または商品名の一部で追加検索（STEP3 注文カードのレスキューと同じ API）。
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                          <input
                            type="text"
                            value={orderRescueQuery}
                            onChange={(e) => setOrderRescueQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void runOrderRescueSearch();
                              }
                            }}
                            placeholder="例: 4901234567890 または 商品名の一部"
                            disabled={orderRescueLoading || submitting}
                            className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                          />
                          <button
                            type="button"
                            onClick={() => void runOrderRescueSearch()}
                            disabled={orderRescueLoading || submitting}
                            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-sky-700 px-4 text-xs font-medium text-white hover:bg-sky-800 disabled:bg-slate-300"
                          >
                            {orderRescueLoading ? "検索中…" : "検索"}
                          </button>
                        </div>
                        {orderRescueError ? <p className="text-[11px] font-medium text-red-700">{orderRescueError}</p> : null}
                        {orderRescueExtra.length > 0 ? (
                          <p className="text-[11px] text-sky-800/90">レスキュー検索で {orderRescueExtra.length} 件を候補に反映しました</p>
                        ) : null}
                      </div>
                    ) : null}
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

              {cardCategory === "Other" && processMode === "refund_positive_offset" && Boolean(data?.amazon_order_id?.trim()) && (
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

              {(cardCategory === "Adjustment" || cardCategory === "Other") && processMode === "adjustment_finance_only" && isAdjustment && (
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

              {(cardCategory === "Adjustment" || cardCategory === "Other") && processMode === "adjustment_with_stock" && isAdjustment && (
                <>
                  <h3 className="bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">
                    補填・在庫にも紐付け
                  </h3>
                  <div className="p-4 space-y-4">
                    <p className="text-xs text-slate-600">
                      seller SKU から JAN を解き、該当 JAN の在庫候補を表示します。正の金額行に在庫と原価を付け、在庫に settled_at を立てます（order_id は変更しません）。
                      自動候補が空やズレる場合は、下の JAN / 商品名検索で STEP3 と同様に候補を追加できます。
                    </p>
                    {!data?.sku?.trim() ? (
                      <p className="text-xs text-amber-900 bg-amber-50 border border-amber-100 rounded px-2 py-1.5 leading-relaxed">
                        明細に SKU が無いため、SKU 経由の自動候補は出ません。JAN / 商品名の検索で在庫を選んでください。
                      </p>
                    ) : null}
                    {data?.sku?.trim() && loadingAdjustmentCandidates ? (
                      <p className="text-sm text-slate-500 py-4 text-center">在庫候補を取得中...</p>
                    ) : mergedAdjustmentCandidates.length === 0 ? (
                      <div className="space-y-2 rounded-lg border border-red-100 bg-red-50/50 p-3">
                        <p className="text-xs font-semibold text-red-800 flex items-start gap-1.5 leading-snug">
                          <span className="shrink-0" aria-hidden>
                            ⚠
                          </span>
                          紐付け可能な在庫がありません。JAN / ASIN を確認し在庫を登録するか、下で検索してください。
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                          <input
                            type="text"
                            value={adjustmentRescueQuery}
                            onChange={(e) => setAdjustmentRescueQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void runAdjustmentRescueSearch();
                              }
                            }}
                            placeholder="例: 4901234567890 または 商品名の一部"
                            disabled={adjustmentRescueLoading || submitting}
                            className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                          />
                          <button
                            type="button"
                            onClick={() => void runAdjustmentRescueSearch()}
                            disabled={adjustmentRescueLoading || submitting}
                            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-sky-700 px-4 text-xs font-medium text-white hover:bg-sky-800 disabled:bg-slate-300"
                          >
                            {adjustmentRescueLoading ? "検索中…" : "検索"}
                          </button>
                        </div>
                        {adjustmentRescueError ? <p className="text-[11px] font-medium text-red-700">{adjustmentRescueError}</p> : null}
                        {adjustmentRescueExtra.length > 0 ? (
                          <p className="text-[11px] text-sky-800/90">レスキュー検索で {adjustmentRescueExtra.length} 件ヒット（下の候補に反映されます）</p>
                        ) : null}
                      </div>
                    ) : adjustmentAttachRows.length === 0 ? (
                      <p className="text-xs text-slate-500">在庫に紐付ける正の明細がありません。</p>
                    ) : (
                      <div className="space-y-3 max-h-72 overflow-y-auto pr-0.5">
                        {adjustmentAttachRows.map((row) => (
                          <div key={row.id} className="rounded-lg border border-slate-200 bg-slate-50/50 p-2.5 space-y-2">
                            <p className="text-[11px] font-semibold text-slate-700">
                              明細 ID {row.id} · {toNumberAmount(row.amount).toLocaleString()} 円
                            </p>
                            <div className="space-y-1 max-h-36 overflow-y-auto">
                              {mergedAdjustmentCandidates.map((s) => (
                                <label key={`${row.id}-${s.id}`} className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={`adj-stock-${row.id}`}
                                    checked={adjustmentStockByTxId[row.id] === s.id}
                                    onChange={() => setAdjustmentStockByTxId((prev) => ({ ...prev, [row.id]: s.id }))}
                                    className="rounded-full border-slate-300 text-emerald-600"
                                  />
                                  <span className="text-xs text-slate-600">
                                    ID: {s.id} — {s.product_name || s.sku || "—"} (
                                    {s.created_at ? new Date(s.created_at).toLocaleDateString("ja-JP") : ""})
                                    {s.unit_cost ? ` · ${Number(s.unit_cost).toLocaleString()}円` : ""}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {mergedAdjustmentCandidates.length > 0 && !(data?.sku?.trim() && loadingAdjustmentCandidates) ? (
                      <div className="space-y-2 rounded-lg border border-sky-100 bg-sky-50/40 p-3">
                        <p className="text-[11px] text-slate-600 leading-snug">
                          一覧に無い在庫を探す: JAN または商品名の一部で検索（注文カードのレスキューと同じ API）。
                        </p>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                          <input
                            type="text"
                            value={adjustmentRescueQuery}
                            onChange={(e) => setAdjustmentRescueQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void runAdjustmentRescueSearch();
                              }
                            }}
                            placeholder="例: 4901234567890 または 商品名の一部"
                            disabled={adjustmentRescueLoading || submitting}
                            className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                          />
                          <button
                            type="button"
                            onClick={() => void runAdjustmentRescueSearch()}
                            disabled={adjustmentRescueLoading || submitting}
                            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-sky-700 px-4 text-xs font-medium text-white hover:bg-sky-800 disabled:bg-slate-300"
                          >
                            {adjustmentRescueLoading ? "検索中…" : "検索"}
                          </button>
                        </div>
                        {adjustmentRescueError ? <p className="text-[11px] font-medium text-red-700">{adjustmentRescueError}</p> : null}
                        {adjustmentRescueExtra.length > 0 ? (
                          <p className="text-[11px] text-sky-800/90">レスキュー検索で {adjustmentRescueExtra.length} 件を候補に反映しました</p>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleAdjustmentSettle(true)}
                      disabled={
                        submitting ||
                        adjustmentAttachRows.length === 0 ||
                        !adjustmentAttachRows.every(
                          (r) => adjustmentStockByTxId[r.id] != null && Number(adjustmentStockByTxId[r.id]) >= 1
                        )
                      }
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
