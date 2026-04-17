"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import ManualFinanceProcessModal, { type PendingFinanceGroupData } from "@/components/ManualFinanceProcessModal";
import ReturnInspectionQueueSection from "@/components/ReturnInspectionQueueSection";
import { consolidatedInternalNoteForEdit } from "@/lib/amazon-pending-finance-internal-note";
import { normalizeOrderCondition } from "@/lib/amazon-condition-match";

type AmazonOrder = {
  /** amazon_orders の主キー（UUID 文字列） */
  id: string;
  /** GET /api/amazon/orders が付与。`id` と同じ DB 主キー */
  order_row_id?: string;
  amazon_order_id: string;
  sku: string;
  /** 同一注文・同一SKUの明細行番号（fetch-orders の列順。未移行DBでは省略可） */
  line_index?: number;
  condition_id: string;
  reconciliation_status: string;
  quantity: number;
  jan_code: string | null;
  asin?: string | null;
  created_at: string;
  updated_at?: string | null;
};

type InboundCandidate = {
  id: number;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  effective_unit_price: number;
  condition_type: string | null;
  created_at: string;
  order_id: string | null;
};

function mergeInboundById(base: InboundCandidate[], extra: InboundCandidate[]): InboundCandidate[] {
  const m = new Map<number, InboundCandidate>();
  for (const c of base) m.set(c.id, c);
  for (const c of extra) m.set(c.id, c);
  return [...m.values()].sort((a, b) => a.id - b.id);
}

/** プルダウン表示: ID・メーカー・型番・原価（品名は出さない） */
function formatInboundOptionLabel(c: InboundCandidate): string {
  const brand = (c.brand ?? "").trim() || "—";
  const model = (c.model_number ?? "").trim() || "—";
  const price = Number.isFinite(c.effective_unit_price) ? c.effective_unit_price : 0;
  return `ID:${c.id} / ${brand} / ${model} / 原価:${price}`;
}

function normalizeInboundCandidate(r: Record<string, unknown>): InboundCandidate {
  return {
    id: Number(r.id),
    jan_code: r.jan_code != null ? String(r.jan_code) : null,
    brand: r.brand != null ? String(r.brand) : null,
    model_number: r.model_number != null ? String(r.model_number) : null,
    effective_unit_price: Number(r.effective_unit_price ?? 0),
    condition_type: r.condition_type != null ? String(r.condition_type) : null,
    created_at: r.created_at != null ? String(r.created_at) : "",
    order_id: r.order_id != null ? String(r.order_id) : null,
  };
}

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

async function readJsonAnySafe(res: Response): Promise<{ json: unknown | null; raw: string }> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed) return { json: null, raw };
  try {
    return { json: JSON.parse(trimmed), raw };
  } catch {
    return { json: null, raw };
  }
}

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

export default function AmazonReconcileManager() {
  const [manualOrders, setManualOrders] = useState<AmazonOrder[]>([]);
  const [loading, setLoading] = useState(true);
  /** reconciled/completed だが inbound_items.order_id が無い行（STEP 3-2） */
  const [inconsistentOrders, setInconsistentOrders] = useState<AmazonOrder[]>([]);
  const [inconsistentLoading, setInconsistentLoading] = useState(true);
  const [inconsistentError, setInconsistentError] = useState<string | null>(null);
  const [repairingOrderRowId, setRepairingOrderRowId] = useState<string | null>(null);
  
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
  const [orderEndDate, setOrderEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  });
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
  const [expandedMemoGroupId, setExpandedMemoGroupId] = useState<string | null>(null);
  const [memoDraftByGroupId, setMemoDraftByGroupId] = useState<Record<string, string>>({});
  const [memoSavingGroupId, setMemoSavingGroupId] = useState<string | null>(null);
  const [memoFlashByGroupId, setMemoFlashByGroupId] = useState<Record<string, { type: "ok" | "err"; text: string }>>({});

  const [error, setError] = useState<string | null>(null);
  const [showOnlyNoStock, setShowOnlyNoStock] = useState(false);
  const [candidateCountByOrderId, setCandidateCountByOrderId] = useState<Record<string, number>>({});

  const fetchManualOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/amazon/orders?status=manual_required");
      const { json, raw } = await readJsonAnySafe(res);
      if (!res.ok) {
        const msg = (json && typeof json === "object" && "error" in json && typeof (json as any).error === "string" ? (json as any).error : null) ?? raw.slice(0, 300);
        throw new Error(msg || "注文一覧の取得に失敗しました");
      }
      setManualOrders(Array.isArray(json) ? (json as AmazonOrder[]) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
      setManualOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInconsistentOrders = useCallback(async () => {
    setInconsistentLoading(true);
    setInconsistentError(null);
    try {
      const res = await fetch("/api/amazon/orders?status=inconsistent_reconciled");
      const { json, raw } = await readJsonAnySafe(res);
      if (!res.ok) {
        const msg =
          (json && typeof json === "object" && "error" in json && typeof (json as any).error === "string"
            ? (json as any).error
            : null) ?? raw.slice(0, 300);
        throw new Error(msg || "不整合注文の取得に失敗しました");
      }
      setInconsistentOrders(Array.isArray(json) ? (json as AmazonOrder[]) : []);
    } catch (e) {
      setInconsistentError(e instanceof Error ? e.message : "不整合注文の取得に失敗しました");
      setInconsistentOrders([]);
    } finally {
      setInconsistentLoading(false);
    }
  }, []);

  const refreshStep3Orders = useCallback(async () => {
    await Promise.all([fetchManualOrders(), fetchInconsistentOrders()]);
  }, [fetchManualOrders, fetchInconsistentOrders]);

  useEffect(() => {
    void refreshStep3Orders();
  }, [refreshStep3Orders]);

  const handleCandidatesLoaded = useCallback((orderKey: string, count: number) => {
    setCandidateCountByOrderId((prev) => ({ ...prev, [orderKey]: count }));
  }, []);

  const handleOrderConditionUpdated = useCallback((rowId: string, condition_id: string) => {
    setManualOrders((prev) =>
      prev.map((o) => {
        const oid = resolveOrderRowIdString(o);
        const samePk = rowId.length > 0 && oid != null && oid === rowId;
        return samePk ? { ...o, condition_id } : o;
      })
    );
  }, []);

  const handleOrderDeleted = useCallback((removedId: string) => {
    setManualOrders((prev) => prev.filter((o) => o.id !== removedId));
    setCandidateCountByOrderId((prev) => {
      const next = { ...prev };
      delete next[`pk:${removedId}`];
      return next;
    });
    void fetchInconsistentOrders();
  }, [fetchInconsistentOrders]);

  const handleOrderCancellationExcluded = useCallback((amazonOrderId: string) => {
    const want = String(amazonOrderId).trim();
    setManualOrders((prev) => prev.filter((o) => String(o.amazon_order_id).trim() !== want));
    void fetchInconsistentOrders();
  }, [fetchInconsistentOrders]);

  const filteredManualOrders = showOnlyNoStock
    ? manualOrders.filter((o) => (candidateCountByOrderId[orderStableKey(o)] ?? -1) === 0)
    : manualOrders;
  const noStockCount = manualOrders.filter((o) => (candidateCountByOrderId[orderStableKey(o)] ?? -1) === 0).length;

  const fetchPendingFinances = useCallback(async () => {
    setIsLoadingPendingFinances(true);
    try {
      const res = await fetch("/api/amazon/pending-finances");
      const { json, raw } = await readJsonAnySafe(res);
      if (!res.ok) {
        const msg = (json && typeof json === "object" && "error" in json && typeof (json as any).error === "string" ? (json as any).error : null) ?? raw.slice(0, 300);
        throw new Error(msg || "未処理財務データの取得に失敗しました");
      }
      setPendingFinances(Array.isArray(json) ? (json as PendingFinanceGroupData[]) : []);
    } catch {
      setPendingFinances([]);
    } finally {
      setIsLoadingPendingFinances(false);
    }
  }, []);

  const toggleMemoEditor = useCallback((g: PendingFinanceGroupData) => {
    setExpandedMemoGroupId((prev) => {
      const closing = prev === g.groupId;
      if (!closing) {
        setMemoDraftByGroupId((draft) => ({
          ...draft,
          [g.groupId]: consolidatedInternalNoteForEdit(g.raw_details ?? []),
        }));
      }
      return closing ? null : g.groupId;
    });
  }, []);

  const saveMemoOnlyForGroup = useCallback(
    async (g: PendingFinanceGroupData) => {
      const ids = (g.raw_details ?? []).map((d) => d.id).filter((n) => Number.isFinite(n) && n >= 1);
      if (ids.length === 0) return;
      const note = (memoDraftByGroupId[g.groupId] ?? "").trim();
      setMemoSavingGroupId(g.groupId);
      setMemoFlashByGroupId((f) => {
        const next = { ...f };
        delete next[g.groupId];
        return next;
      });
      try {
        const res = await fetch("/api/amazon/sales-transactions/internal-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ salesTransactionIds: ids, internal_note: note.length > 0 ? note : null }),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "保存に失敗しました");
        setMemoFlashByGroupId((f) => ({ ...f, [g.groupId]: { type: "ok", text: "メモを保存しました" } }));
        await fetchPendingFinances();
      } catch (e) {
        setMemoFlashByGroupId((f) => ({
          ...f,
          [g.groupId]: { type: "err", text: e instanceof Error ? e.message : "保存に失敗しました" },
        }));
      } finally {
        setMemoSavingGroupId(null);
      }
    },
    [memoDraftByGroupId, fetchPendingFinances]
  );

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
      const { json, raw } = await readJsonAnySafe(res);
      const data = json as any;
      if (!res.ok) {
        const msg = (data && typeof data.error === "string" ? data.error : null) ?? raw.slice(0, 300);
        throw new Error(msg || "データ取得に失敗しました");
      }
      setFetchResult(`${data?.message ?? "取得完了"} (新規/更新: ${data?.rowsUpserted ?? 0}件)`);
      void refreshStep3Orders();
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
      const { json, raw } = await readJsonAnySafe(res);
      const data = json as any;
      if (!res.ok) {
        const msg = (data && typeof data.error === "string" ? data.error : null) ?? raw.slice(0, 300);
        throw new Error(msg || "売上データの取得に失敗しました");
      }
      const total = data?.totalFetched ?? 0;
      const inserted = data?.rowsInserted ?? 0;
      const skipped = data?.rowsSkipped ?? 0;
      let message = `取得成功: ${total}件 (新規: ${inserted}件, スキップ: ${skipped}件)`;

      const RECONCILE_SALES_MAX_ROUNDS = 300;
      let totalReconciled = 0;
      let totalSkippedReconcile = 0;

      for (let round = 0; round < RECONCILE_SALES_MAX_ROUNDS; round += 1) {
        const reconcileRes = await fetch("/api/amazon/reconcile-sales", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const reconcileParsed = await readJsonAnySafe(reconcileRes);
        const reconcileData = reconcileParsed.json as any;
        if (!reconcileRes.ok) {
          const msg =
            reconcileData && typeof reconcileData.error === "string"
              ? reconcileData.error
              : reconcileParsed.raw.slice(0, 300);
          message += ` / 自動消込: 失敗 (${msg || "エラー"})`;
          break;
        }

        const processedOrders = Number(reconcileData?.processedOrders ?? 0);
        totalReconciled += Number(reconcileData?.reconciledCount ?? 0);
        totalSkippedReconcile += Number(reconcileData?.skippedCount ?? 0);

        if (processedOrders <= 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      message += ` / 自動消込: ${totalReconciled}件成功 (保留: ${totalSkippedReconcile}件)`;
      await fetchPendingFinances();

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
      const RECONCILE_SALES_MAX_ROUNDS = 300;
      let totalReconciled = 0;
      let totalSkipped = 0;
      let lastServerMessage = "";

      for (let round = 0; round < RECONCILE_SALES_MAX_ROUNDS; round += 1) {
        const res = await fetch("/api/amazon/reconcile-sales", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const { json, raw } = await readJsonAnySafe(res);
        const data = json as any;
        if (!res.ok) {
          const msg = data && typeof data.error === "string" ? data.error : raw.slice(0, 300);
          throw new Error(msg || "本消込に失敗しました");
        }
        const processedOrders = Number(data?.processedOrders ?? 0);
        const roundReconciled = Number(data?.reconciledCount ?? 0);
        const roundSkipped = Number(data?.skippedCount ?? 0);
        totalReconciled += roundReconciled;
        totalSkipped += roundSkipped;
        if (typeof data?.message === "string") lastServerMessage = data.message;
        // 処理対象注文が 0 なら打ち止め（未紐付きなし／在庫引当済みのバッチが組めない）
        if (processedOrders <= 0) break;
        await new Promise((r) => setTimeout(r, 150));
      }

      const detail =
        totalReconciled === 0 && totalSkipped === 0 && lastServerMessage
          ? ` ${lastServerMessage}`
          : "";
      setFinanceResult({
        type: "success",
        message: `本消込: ${totalReconciled}件成功（保留: ${totalSkipped}件）${detail}`,
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

  const repairInconsistentOrderRow = async (orderRowId: string) => {
    if (
      !confirm(
        "この行を手動確認（manual_required）に戻し、同一注文番号の在庫引当（order_id / settled_at）を解除しますか？\n※同一 amazon_order_id の reconciled / completed 行はまとめて manual_required になります。"
      )
    ) {
      return;
    }
    setRepairingOrderRowId(orderRowId);
    setInconsistentError(null);
    try {
      const res = await fetch("/api/amazon/orders/repair-inconsistent-reconciled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderRowId }),
      });
      const { json, raw } = await readJsonAnySafe(res);
      if (!res.ok) {
        const msg =
          (json && typeof json === "object" && "error" in json && typeof (json as any).error === "string"
            ? (json as any).error
            : null) ?? raw.slice(0, 300);
        throw new Error(msg || "復旧に失敗しました");
      }
      await refreshStep3Orders();
    } catch (e) {
      setInconsistentError(e instanceof Error ? e.message : "復旧に失敗しました");
    } finally {
      setRepairingOrderRowId(null);
    }
  };

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
        const { json, raw } = await readJsonAnySafe(res);
        const data = json as any;
        if (!res.ok) {
          const msg = data && typeof data.error === "string" ? data.error : raw.slice(0, 300);
          throw new Error(msg || "消込に失敗しました");
        }

        const processed = Number(data?.processed ?? 0);
        totalCompleted += Number(data?.completed ?? 0);
        totalManual += Number(data?.manual_required ?? 0);
        totalSkippedUsed += Number(data?.skipped_used_safety ?? 0);

        if (processed === 0) {
          const idleFirstRound = round === 1 && totalCompleted === 0 && totalManual === 0 && totalSkippedUsed === 0;
          setReconcileResult({
            message: idleFirstRound
              ? "処理対象の pending 注文はありません（すでに処理済み、または対象外です）。"
              : "🎉 全ての自動消込が完了しました！",
            completed: totalCompleted,
            manual_required: totalManual,
            skipped_used_safety: totalSkippedUsed,
            rounds: round,
            allComplete: true,
          });
          await refreshStep3Orders();
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
          await refreshStep3Orders();
          return;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "消込処理に失敗しました");
      await refreshStep3Orders();
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
                  <p className="mt-1">
                    中古安全装置により自動確定せず手動確認へ: {reconcileResult.skipped_used_safety} 件
                  </p>
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
                    onConfirmed={refreshStep3Orders}
                    onCandidatesLoaded={handleCandidatesLoaded}
                    onConditionUpdated={handleOrderConditionUpdated}
                    onDeleted={handleOrderDeleted}
                    onCancellationExcluded={handleOrderCancellationExcluded}
                  />
                ))}
              </div>
            )}
          </div>

          {/* STEP 3-2: reconciled だが在庫に order_id が無い不整合 */}
          <div className="rounded-xl border border-amber-300 bg-amber-50/40 p-7 lg:p-8 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-amber-600" />
            <h3 className="text-lg lg:text-xl font-bold text-slate-900 mb-2">STEP 3-2: 不整合（仮消込済みだが在庫紐付けなし）</h3>
            <p className="text-sm text-slate-700 mb-4 leading-relaxed max-w-4xl">
              <code className="rounded bg-white/80 px-1 py-0.5 text-xs">reconciled</code> または{" "}
              <code className="rounded bg-white/80 px-1 py-0.5 text-xs">completed</code> なのに、
              <code className="rounded bg-white/80 px-1 py-0.5 text-xs">inbound_items.order_id</code> に該当注文番号が無い行です。
              直近更新の上位500件の reconciled/completed 行のみを走査します（それより古い不整合は別途SQLで確認してください）。
            </p>
            {inconsistentError && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{inconsistentError}</div>
            )}
            {inconsistentLoading ? (
              <p className="text-slate-600">読み込み中...</p>
            ) : inconsistentOrders.length === 0 ? (
              <p className="text-slate-600">不整合は検出されませんでした。</p>
            ) : (
              <ul className="space-y-3">
                {inconsistentOrders.map((o) => {
                  const rowId = resolveOrderRowIdString(o) ?? o.id;
                  const updated = o.updated_at
                    ? new Date(o.updated_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                    : "—";
                  return (
                    <li
                      key={o.id}
                      className="flex flex-col gap-2 rounded-lg border border-amber-200/80 bg-white/90 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 text-sm text-slate-800">
                        <p className="font-mono font-semibold break-all">{o.amazon_order_id}</p>
                        <p className="mt-1 text-xs text-slate-600 break-all">
                          SKU: {o.sku} / JAN: {o.jan_code ?? "—"} / 条件: {o.condition_id} / 行: {o.line_index ?? 0} /{" "}
                          <span className="font-mono">{o.reconciliation_status}</span>
                        </p>
                        <p className="mt-1 text-xs text-slate-500">updated_at（表示: 東京）: {updated}</p>
                      </div>
                      <button
                        type="button"
                        disabled={repairingOrderRowId === rowId}
                        onClick={() => void repairInconsistentOrderRow(rowId)}
                        className={`${buttonClass} shrink-0 border border-amber-700 bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50 text-sm h-9 px-4`}
                      >
                        {repairingOrderRowId === rowId ? "処理中..." : "手動確認に戻す（引当解除）"}
                      </button>
                    </li>
                  );
                })}
              </ul>
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
                        className="flex flex-col gap-1.5 rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-slate-800" title={g.amazon_order_id ?? g.sku ?? g.groupId}>
                              {g.amazon_order_id ?? g.sku ?? g.groupId}
                            </p>
                            <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                              <span
                                className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                  g.group_kind === "offset_principal_tax"
                                    ? "bg-violet-100 text-violet-800"
                                    : g.group_kind === "adjustment_like"
                                      ? "bg-emerald-100 text-emerald-800"
                                      : g.group_kind === "order" || g.transaction_type === "Order"
                                        ? "bg-blue-100 text-blue-700"
                                        : g.group_kind === "refund" || g.transaction_type === "Refund"
                                          ? "bg-amber-100 text-amber-700"
                                          : "bg-slate-200 text-slate-700"
                                }`}
                              >
                                {g.display_label ?? g.transaction_type}
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
                            <div className="mt-1 flex flex-wrap justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => toggleMemoEditor(g)}
                                className={`inline-flex items-center justify-center rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                                  expandedMemoGroupId === g.groupId
                                    ? "bg-amber-200 text-amber-950"
                                    : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-100"
                                }`}
                              >
                                メモ
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedPendingFinance(g);
                                  setIsModalOpen(true);
                                }}
                                className="inline-flex items-center justify-center rounded bg-slate-200 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-300 transition-colors"
                              >
                                手動処理
                              </button>
                            </div>
                          </div>
                        </div>
                        {g.internal_note_summary ? (
                          <p className="text-[10px] text-slate-600 truncate pl-0.5" title={g.internal_note_summary}>
                            メモ: {g.internal_note_summary}
                          </p>
                        ) : null}
                        {expandedMemoGroupId === g.groupId ? (
                          <div className="w-full border-t border-slate-200 pt-2 space-y-1.5">
                            <textarea
                              value={memoDraftByGroupId[g.groupId] ?? ""}
                              onChange={(e) => setMemoDraftByGroupId((d) => ({ ...d, [g.groupId]: e.target.value }))}
                              rows={3}
                              placeholder="社内メモ（このグループの全明細に同じ内容で保存）"
                              className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300/40"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                disabled={memoSavingGroupId === g.groupId}
                                onClick={() => void saveMemoOnlyForGroup(g)}
                                className="inline-flex items-center justify-center rounded bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-slate-900 disabled:opacity-50"
                              >
                                {memoSavingGroupId === g.groupId ? "保存中…" : "メモだけ保存"}
                              </button>
                            </div>
                            {memoFlashByGroupId[g.groupId] ? (
                              <p
                                className={`text-[10px] ${
                                  memoFlashByGroupId[g.groupId].type === "ok" ? "text-emerald-700" : "text-red-600"
                                }`}
                              >
                                {memoFlashByGroupId[g.groupId].text}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
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
  onConditionUpdated?: (rowId: string, condition_id: string) => void;
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
  /** 数量>1・非セット時: スロットごとのレスキュー検索ヒット */
  const [rescueExtraBySlot, setRescueExtraBySlot] = useState<Record<number, InboundCandidate[]>>({});
  const [rescueQueryBySlot, setRescueQueryBySlot] = useState<Record<number, string>>({});
  const [rescueLoadingSlot, setRescueLoadingSlot] = useState<number | null>(null);
  const [rescueErrorBySlot, setRescueErrorBySlot] = useState<Record<number, string | null>>({});

  const qty = Math.max(1, Number(order.quantity) || 1);
  const [setMode, setSetMode] = useState(false);
  const [sellerSkuForSet, setSellerSkuForSet] = useState(order.sku);
  const [setComposition, setSetComposition] = useState<{
    is_set: boolean;
    total_units: number;
    slots: { jan_code: string; label: string }[];
  } | null>(null);
  const [setCompositionLoading, setSetCompositionLoading] = useState(false);
  const [setCompositionError, setSetCompositionError] = useState<string | null>(null);
  const [multiSelected, setMultiSelected] = useState<(number | null)[]>(() => Array.from({ length: qty }, () => null));

  useEffect(() => {
    setSellerSkuForSet(order.sku);
  }, [order.sku, order.id]);

  useEffect(() => {
    if (!setMode) {
      setMultiSelected(Array.from({ length: qty }, () => null));
    }
  }, [order.id, qty, setMode]);

  useEffect(() => {
    let cancelled = false;
    if (!setMode) {
      setSetComposition(null);
      setSetCompositionError(null);
      return;
    }
    const sku = sellerSkuForSet.trim();
    if (!sku) {
      setSetComposition(null);
      return;
    }
    setSetCompositionLoading(true);
    setSetCompositionError(null);
    fetch(
      `/api/amazon/set-composition?sku=${encodeURIComponent(sku)}&platform=Amazon&order_qty=${encodeURIComponent(String(qty))}`
    )
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { error?: string; is_set?: boolean; total_units?: number; slots?: { jan_code: string; label: string }[] };
        if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "構成の取得に失敗しました");
        return j;
      })
      .then((j) => {
        if (cancelled) return;
        const total = Math.max(0, Number(j.total_units) || 0);
        const slots = Array.isArray(j.slots) ? j.slots : [];
        setSetComposition({
          is_set: Boolean(j.is_set),
          total_units: total,
          slots,
        });
        setMultiSelected(Array.from({ length: total }, () => null));
      })
      .catch((e) => {
        if (!cancelled) {
          setSetCompositionError(e instanceof Error ? e.message : "エラー");
          setSetComposition(null);
        }
      })
      .finally(() => {
        if (!cancelled) setSetCompositionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setMode, sellerSkuForSet, qty, order.id]);

  useEffect(() => {
    setConditionId(order.condition_id);
  }, [order.id, order.condition_id]);

  const orderCondNorm = normalizeOrderCondition(conditionId);
  const isUsedDisplay = orderCondNorm === "used";

  const mergedCandidates = useMemo(() => mergeInboundById(candidates, rescueExtra), [candidates, rescueExtra]);

  const isPerSlotRescue = qty > 1 && !setMode;

  const showNoStockStyle =
    !loadingCandidates && (isPerSlotRescue ? candidates.length === 0 : mergedCandidates.length === 0);

  const poolForMultiSlot = useCallback(
    (slotIndex: number) => {
      const extra = rescueExtraBySlot[slotIndex] ?? [];
      const merged = mergeInboundById(candidates, extra);
      const takenElsewhere = new Set<number>();
      multiSelected.forEach((id, j) => {
        if (j !== slotIndex && id != null) takenElsewhere.add(id);
      });
      return merged.filter((c) => !takenElsewhere.has(c.id) || multiSelected[slotIndex] === c.id);
    },
    [candidates, rescueExtraBySlot, multiSelected]
  );

  const poolForSetSlot = useCallback(
    (slotIndex: number, wantJan: string) => {
      const base =
        wantJan.length > 0
          ? mergedCandidates.filter((c) => (c.jan_code ?? "").trim() === wantJan)
          : mergedCandidates;
      const takenElsewhere = new Set<number>();
      multiSelected.forEach((id, j) => {
        if (j !== slotIndex && id != null) takenElsewhere.add(id);
      });
      return base.filter((c) => !takenElsewhere.has(c.id) || multiSelected[slotIndex] === c.id);
    },
    [mergedCandidates, multiSelected]
  );

  useEffect(() => {
    setRescueExtra([]);
    setRescueQuery("");
    setRescueError(null);
    setRescueExtraBySlot({});
    setRescueQueryBySlot({});
    setRescueErrorBySlot({});
    setRescueLoadingSlot(null);
  }, [order.id, order.amazon_order_id, order.sku, candidatesRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoadingCandidates(true);
    setError(null);
    const params = new URLSearchParams({ amazon_order_id: order.amazon_order_id });
    if (order.sku) params.set("sku", order.sku);
    const rowIdForCandidates = resolveOrderRowIdString(order);
    if (rowIdForCandidates) params.set("order_row_id", rowIdForCandidates);
    fetch(`/api/amazon/orders/candidates?${params}`)
      .then(async (res) => {
        if (!res.ok) return [];
        const { json } = await readJsonAnySafe(res);
        return Array.isArray(json) ? json : [];
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        if (!cancelled) {
          const normalized = list.map((r) => normalizeInboundCandidate(r as Record<string, unknown>));
          setCandidates(normalized);
          onCandidatesLoaded?.(orderStableKey(order), normalized.length);
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
      onConditionUpdated?.(serverRowId, saved);
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

  const rowUuidForPayload = resolveOrderRowIdString(order);

  const confirmSelection = async () => {
    if (!setMode && qty <= 1 && selectedId == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const base: Record<string, unknown> = {
        amazon_order_id: order.amazon_order_id,
        sku: order.sku,
      };
      if (rowUuidForPayload) base.amazon_order_db_id = rowUuidForPayload;

      let body: Record<string, unknown> = base;
      if (setMode) {
        if (!setComposition?.is_set) {
          throw new Error("この出品SKUはマスタ上セット構成ではありません。");
        }
        const ids = multiSelected.filter((x): x is number => x != null);
        if (ids.length !== setComposition.total_units) {
          throw new Error(`セット構成どおり ${setComposition.total_units} 件すべて選択してください。`);
        }
        body = {
          ...base,
          set_reconcile: true,
          seller_sku: sellerSkuForSet.trim(),
          inbound_item_ids: ids,
        };
      } else if (qty > 1) {
        const ids = multiSelected.filter((x): x is number => x != null);
        if (ids.length !== qty) {
          throw new Error(`在庫を ${qty} 件選択してください。`);
        }
        body = { ...base, inbound_item_ids: ids };
      } else {
        body = { ...base, inbound_item_id: selectedId as number };
      }

      const res = await fetch("/api/amazon/reconcile/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const { json, raw } = await readJsonAnySafe(res);
      const data = json as any;
      if (!res.ok) {
        const msg = data && typeof data.error === "string" ? data.error : raw.slice(0, 300);
        throw new Error(msg || "確定に失敗しました");
      }
      onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "確定に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDisabled =
    submitting ||
    conditionSaving ||
    (setMode
      ? !setComposition?.is_set ||
        setCompositionLoading ||
        multiSelected.length !== setComposition.total_units ||
        multiSelected.some((x) => x == null)
      : qty > 1
        ? multiSelected.length !== qty || multiSelected.some((x) => x == null)
        : selectedId == null);

  const runRescueSearch = async (slotIndex: number | "global" = "global") => {
    const q =
      slotIndex === "global"
        ? rescueQuery.trim()
        : (rescueQueryBySlot[slotIndex] ?? "").trim();
    if (q.length < 1) {
      if (slotIndex === "global") setRescueError("検索語を入力してください");
      else setRescueErrorBySlot((prev) => ({ ...prev, [slotIndex]: "検索語を入力してください" }));
      return;
    }
    if (slotIndex === "global") {
      setRescueLoading(true);
      setRescueError(null);
    } else {
      setRescueLoadingSlot(slotIndex);
      setRescueErrorBySlot((prev) => ({ ...prev, [slotIndex]: null }));
    }
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
        brand: string | null;
        model_number: string | null;
        condition: string | null;
        unit_cost: number;
        created_at: string | null;
        amazon_order_id: string | null;
      };
      const mapped: InboundCandidate[] = (list as ApiCand[]).map((r) => ({
        id: r.id,
        jan_code: r.sku,
        brand: r.brand ?? null,
        model_number: r.model_number ?? null,
        effective_unit_price: Number(r.unit_cost ?? 0),
        condition_type: r.condition,
        created_at: r.created_at ?? "",
        order_id: r.amazon_order_id,
      }));
      if (slotIndex === "global") {
        setRescueExtra(mapped);
        if (mapped.length === 0) setRescueError("該当する在庫がありませんでした");
      } else {
        setRescueExtraBySlot((prev) => ({ ...prev, [slotIndex]: mapped }));
        if (mapped.length === 0) {
          setRescueErrorBySlot((prev) => ({ ...prev, [slotIndex]: "該当する在庫がありませんでした" }));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "検索に失敗しました";
      if (slotIndex === "global") setRescueError(msg);
      else setRescueErrorBySlot((prev) => ({ ...prev, [slotIndex]: msg }));
    } finally {
      if (slotIndex === "global") setRescueLoading(false);
      else setRescueLoadingSlot(null);
    }
  };

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
        showNoStockStyle
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

        <div className="flex flex-col gap-2 text-xs text-slate-700">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={setMode}
              onChange={(e) => {
                setSetMode(e.target.checked);
                setSelectedId(null);
              }}
              disabled={submitting || conditionSaving}
              className="rounded border-slate-300"
            />
            <span>セットとして消込（構成SKUごとに在庫を選択）</span>
          </label>
          {setMode ? (
            <div className="space-y-1 pl-6">
              <span className="block text-[10px] font-medium text-slate-500">セット用 出品SKU</span>
              <input
                type="text"
                value={sellerSkuForSet}
                onChange={(e) => setSellerSkuForSet(e.target.value)}
                disabled={submitting || conditionSaving}
                className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-slate-800"
              />
              {setCompositionLoading ? <p className="text-[11px] text-slate-500">構成を取得中…</p> : null}
              {setCompositionError ? <p className="text-[11px] font-medium text-red-700">{setCompositionError}</p> : null}
              {setComposition && !setComposition.is_set && !setCompositionLoading ? (
                <p className="text-[11px] font-medium text-amber-800">このSKUはマスタ上セットではありません。</p>
              ) : null}
            </div>
          ) : null}
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
        ) : !isPerSlotRescue && mergedCandidates.length === 0 ? (
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
                      void runRescueSearch("global");
                    }
                  }}
                  placeholder="例: 4901234567890 または 商品名の一部"
                  disabled={rescueLoading || submitting}
                  className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                />
                <button
                  type="button"
                  onClick={() => void runRescueSearch("global")}
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
        ) : isPerSlotRescue ? (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <span className="block text-xs font-bold text-slate-700">在庫候補を選択（点数ごと）</span>
            {candidates.length === 0 ? (
              <p className="text-[11px] text-amber-900 bg-amber-50/90 border border-amber-100 rounded-md px-2 py-1.5 leading-snug">
                自動候補がありません。各点数のレスキューで JAN・商品名などを検索し、プルダウンに追加してください。
              </p>
            ) : null}
            {multiSelected.map((slotVal, i) => (
              <div key={i} className="space-y-1.5 rounded-md border border-slate-100 bg-slate-50/60 p-2.5">
                <label className="block text-[10px] font-medium text-slate-500">{i + 1}点目</label>
                <select
                  value={slotVal ?? ""}
                  onChange={(e) => {
                    const v = e.target.value ? Number(e.target.value) : null;
                    setMultiSelected((prev) => {
                      const next = [...prev];
                      if (v != null) {
                        for (let j = 0; j < next.length; j++) {
                          if (j !== i && next[j] === v) next[j] = null;
                        }
                      }
                      next[i] = v;
                      return next;
                    });
                  }}
                  className="w-full rounded-md border-2 border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                >
                  <option value="">選択してください</option>
                  {poolForMultiSlot(i).map((c: InboundCandidate) => (
                    <option key={c.id} value={c.id}>
                      {formatInboundOptionLabel(c)}
                    </option>
                  ))}
                </select>
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-stretch">
                  <input
                    type="text"
                    value={rescueQueryBySlot[i] ?? ""}
                    onChange={(e) => setRescueQueryBySlot((prev) => ({ ...prev, [i]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void runRescueSearch(i);
                      }
                    }}
                    placeholder={`${i + 1}点目用: JAN / 商品名`}
                    disabled={rescueLoadingSlot !== null || submitting}
                    className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                  />
                  <button
                    type="button"
                    onClick={() => void runRescueSearch(i)}
                    disabled={rescueLoadingSlot !== null || submitting}
                    className={`${buttonClass} h-9 shrink-0 bg-sky-700 text-white hover:bg-sky-800 text-xs px-4 disabled:bg-slate-300`}
                  >
                    {rescueLoadingSlot === i ? "検索中…" : "検索"}
                  </button>
                </div>
                {rescueErrorBySlot[i] ? (
                  <p className="text-[11px] font-medium text-red-700">{rescueErrorBySlot[i]}</p>
                ) : null}
                {(rescueExtraBySlot[i]?.length ?? 0) > 0 ? (
                  <p className="text-[11px] text-sky-800/90">
                    この点数に {rescueExtraBySlot[i]!.length} 件をプルダウンへ反映しました
                  </p>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={() => void confirmSelection()}
              disabled={confirmDisabled}
              className={`${buttonClass} h-10 w-full bg-amber-600 text-sm font-bold text-white shadow-sm hover:bg-amber-700 disabled:bg-slate-300 disabled:text-slate-500`}
            >
              {submitting ? "確定中…" : "この在庫で確定"}
            </button>
          </div>
        ) : (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <span className="block text-xs font-bold text-slate-700">在庫候補を選択</span>
            {setMode ? (
              setCompositionLoading ? (
                <p className="text-xs text-slate-500">構成に合わせて選択欄を表示します…</p>
              ) : setComposition?.is_set ? (
                <div className="space-y-2">
                  {multiSelected.map((slotVal, i) => {
                    const wantJan = (setComposition.slots[i]?.jan_code ?? "").trim();
                    const pool = poolForSetSlot(i, wantJan);
                    const label = setComposition.slots[i]?.label?.trim() || `スロット ${i + 1}`;
                    return (
                      <div key={i} className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-slate-500">{label}</label>
                        <select
                          value={slotVal ?? ""}
                          onChange={(e) => {
                            const v = e.target.value ? Number(e.target.value) : null;
                            setMultiSelected((prev) => {
                              const next = [...prev];
                              if (v != null) {
                                for (let j = 0; j < next.length; j++) {
                                  if (j !== i && next[j] === v) next[j] = null;
                                }
                              }
                              next[i] = v;
                              return next;
                            });
                          }}
                          className="w-full rounded-md border-2 border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                        >
                          <option value="">選択してください</option>
                          {pool.map((c: InboundCandidate) => (
                            <option key={c.id} value={c.id}>
                              {formatInboundOptionLabel(c)}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              ) : null
            ) : (
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-md border-2 border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
              >
                <option value="">選択してください</option>
                {mergedCandidates.map((c: InboundCandidate) => (
                  <option key={c.id} value={c.id}>
                    {formatInboundOptionLabel(c)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void confirmSelection()}
              disabled={confirmDisabled}
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
                      void runRescueSearch("global");
                    }
                  }}
                  placeholder="例: 4901234567890 または 商品名の一部"
                  disabled={rescueLoading || submitting}
                  className="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-300/40"
                />
                <button
                  type="button"
                  onClick={() => void runRescueSearch("global")}
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