"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileUp, Package, RefreshCcw, Banknote } from "lucide-react";

type OtherOrder = {
  id: string;
  order_id: string;
  platform: string;
  sku?: string | null;
  sell_price: number;
  jan_code: string | null;
  stock_id: number | null;
  status: string;
  reconciliation_status?: string | null;
  quantity?: number;
  condition_id?: string | null;
  created_at?: string;
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

function formatInboundOptionLabel(c: InboundCandidate): string {
  const jan = (c.jan_code ?? "").trim() || "—";
  const brand = (c.brand ?? "").trim() || "—";
  const model = (c.model_number ?? "").trim() || "—";
  const price = Number.isFinite(c.effective_unit_price) ? c.effective_unit_price : 0;
  return `ID:${c.id} / JAN:${jan} / ${brand} / ${model} / 原価:${price}`;
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

type CsvImportResult = {
  ok: boolean;
  ordersUpserted: number;
  salesUpserted: number;
  orderRows: number;
  salesRows: number;
  rowErrors: string[];
  message: string;
};

type CsvImportErrorDetails = {
  error: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
  step?: string;
  rowErrors?: string[];
  httpStatus?: number;
  rawBody?: string;
};

async function readApiJson(res: Response): Promise<{ data: Record<string, unknown> | null; raw: string }> {
  const raw = await res.text();
  try {
    return { data: JSON.parse(raw) as Record<string, unknown>, raw };
  } catch {
    return { data: null, raw };
  }
}

function pickString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function pickStringArray(data: Record<string, unknown>, key: string): string[] | undefined {
  const v = data[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function buildCsvImportErrorDetails(
  data: Record<string, unknown> | null,
  raw: string,
  res: Response,
  fallback: string
): CsvImportErrorDetails {
  if (!data) {
    return {
      error: `サーバー応答を解釈できません（HTTP ${res.status}）`,
      rawBody: raw.slice(0, 800) || undefined,
      httpStatus: res.status,
    };
  }
  return {
    error: pickString(data, "error") ?? fallback,
    details: pickString(data, "details") ?? null,
    hint: pickString(data, "hint") ?? null,
    code: pickString(data, "code") ?? null,
    step: pickString(data, "step"),
    rowErrors: pickStringArray(data, "rowErrors"),
    httpStatus: res.status,
  };
}

type ReconcileResult = {
  ok: boolean;
  message: string;
  processed: number;
  completed: number;
  manual_required: number;
  skipped_used_safety?: number;
};

type ReconcileSalesResult = {
  ok: boolean;
  message: string;
  processedOrders: number;
  reconciledCount: number;
  skippedCount: number;
};

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

const SAMPLE_CSV = `注文番号,プラットフォーム,SKU,数量,コンディション,注文日,決済日,JAN,商品売上,消費税,送料,プラットフォーム手数料,その他手数料
RK-20260706-0001,楽天,RAK-SKU-001,1,新品,2026-07-01,2026-07-05,4901234567890,2980,298,0,-358,0`;

export default function OtherSalesImportPage() {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [csvImportResult, setCsvImportResult] = useState<CsvImportResult | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvErrorDetails, setCsvErrorDetails] = useState<CsvImportErrorDetails | null>(null);
  const [csvRunning, setCsvRunning] = useState(false);

  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconcileRunning, setReconcileRunning] = useState(false);
  const [reconcileRound, setReconcileRound] = useState(0);

  const [salesResult, setSalesResult] = useState<ReconcileSalesResult | null>(null);
  const [salesError, setSalesError] = useState<string | null>(null);
  const [salesRunning, setSalesRunning] = useState(false);

  const [manualOrders, setManualOrders] = useState<OtherOrder[]>([]);
  const [manualLoading, setManualLoading] = useState(true);
  const [manualError, setManualError] = useState<string | null>(null);

  const fetchManualQueue = useCallback(async () => {
    setManualError(null);
    try {
      const res = await fetch("/api/other-sales-import?reconciliation_status=manual_required");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "手動キューの取得に失敗しました");
      setManualOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      setManualError(e instanceof Error ? e.message : "手動キューの取得に失敗しました");
      setManualOrders([]);
    } finally {
      setManualLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchManualQueue();
  }, [fetchManualQueue]);

  const handleCsvUpload = async (file: File) => {
    setCsvError(null);
    setCsvErrorDetails(null);
    setCsvImportResult(null);
    setCsvRunning(true);
    setSelectedFileName(file.name);

    try {
      const csvText = await file.text();
      const res = await fetch("/api/other-platform-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText }),
      });
      const { data, raw } = await readApiJson(res);

      if (!data || !res.ok || data.ok === false) {
        const details = buildCsvImportErrorDetails(data, raw, res, "CSV取込に失敗しました");
        setCsvErrorDetails(details);
        setCsvError(details.error);
        return;
      }

      setCsvImportResult(data as unknown as CsvImportResult);
      await fetchManualQueue();
    } catch (e) {
      const message = e instanceof Error ? e.message : "CSV取込に失敗しました";
      setCsvError(message);
      setCsvErrorDetails({ error: message });
    } finally {
      setCsvRunning(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleCsvUpload(file);
    e.target.value = "";
  };

  const downloadSample = () => {
    const blob = new Blob([`\uFEFF${SAMPLE_CSV}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "other-platform-import-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const runReconcileLoop = async () => {
    if (!confirm("在庫引当を実行しますか？（pending がなくなるまで繰り返します）")) return;
    setReconcileError(null);
    setReconcileResult(null);
    setReconcileRunning(true);

    let round = 0;
    let totalCompleted = 0;
    let totalManual = 0;
    let totalSkipped = 0;

    try {
      for (;;) {
        round += 1;
        setReconcileRound(round);
        const res = await fetch("/api/other-platform/reconcile", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "在庫引当に失敗しました");

        const processed = Number(data?.processed ?? 0);
        totalCompleted += Number(data?.completed ?? 0);
        totalManual += Number(data?.manual_required ?? 0);
        totalSkipped += Number(data?.skipped_used_safety ?? 0);

        if (processed === 0) {
          setReconcileResult({
            ok: true,
            message:
              round === 1 && totalCompleted === 0 && totalManual === 0
                ? "対象の pending 注文はありません。"
                : "在庫引当が完了しました。",
            processed: 0,
            completed: totalCompleted,
            manual_required: totalManual,
            skipped_used_safety: totalSkipped,
          });
          await fetchManualQueue();
          return;
        }

        if (round >= 12) {
          setReconcileResult({
            ok: true,
            message: "一部のみ実行されました（繰り返し上限に達しました）。再度実行できます。",
            processed,
            completed: totalCompleted,
            manual_required: totalManual,
            skipped_used_safety: totalSkipped,
          });
          await fetchManualQueue();
          return;
        }
      }
    } catch (e) {
      setReconcileError(e instanceof Error ? e.message : "在庫引当に失敗しました");
      await fetchManualQueue();
    } finally {
      setReconcileRunning(false);
      setReconcileRound(0);
    }
  };

  const runReconcileSales = async () => {
    if (!confirm("売上を本消込しますか？（在庫引当済みの注文のみ処理されます）")) return;
    setSalesError(null);
    setSalesResult(null);
    setSalesRunning(true);

    try {
      const res = await fetch("/api/other-platform/reconcile-sales", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "本消込に失敗しました");
      setSalesResult(data);
    } catch (e) {
      setSalesError(e instanceof Error ? e.message : "本消込に失敗しました");
    } finally {
      setSalesRunning(false);
    }
  };

  const flowSummary = useMemo(
    () => [
      { step: "1", label: "CSV取込", desc: "注文・売上データをDBに保存（消込はしない）" },
      { step: "2", label: "在庫引当", desc: "どの在庫か決める（まだ決済完了にはしない）" },
      { step: "3", label: "売上本消込", desc: "在庫と売上を結び付け、決済日を記録" },
    ],
    []
  );

  return (
    <main className="flex-1 py-8 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <FileUp className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">他販路 売上CSV 取込・消込</h1>
            <p className="text-sm text-slate-500">CSV取込 → 在庫引当 → 売上本消込（Amazonと同じ流れ・ボタンで段階実行）</p>
          </div>
        </div>

        <section className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
          <ol className="flex flex-col sm:flex-row gap-4 sm:gap-8 text-sm text-slate-700">
            {flowSummary.map((f) => (
              <li key={f.step} className="flex gap-2">
                <span className="font-bold text-primary shrink-0">STEP {f.step}</span>
                <span>
                  <span className="font-medium">{f.label}</span>
                  <span className="text-slate-500"> — {f.desc}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* STEP 1: CSV */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">STEP 1：CSV取込</h2>
          <p className="text-sm text-slate-600 mb-2">
            統合CSV（注文番号・プラットフォーム・売上内訳）をアップロードします。SKU が無い場合は JAN 列を埋めてください。
          </p>
          <p className="text-xs text-slate-500 mb-4 font-mono break-all">
            注文番号, プラットフォーム, SKU, 数量, コンディション, 注文日, 決済日, JAN, 商品売上, 消費税, 送料, プラットフォーム手数料, その他手数料
          </p>

          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input
              type="file"
              accept=".csv"
              onChange={onFileChange}
              disabled={csvRunning}
              className="block text-sm text-slate-700"
            />
            <button
              type="button"
              onClick={downloadSample}
              className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50`}
            >
              サンプルCSV
            </button>
          </div>
          {selectedFileName && <p className="text-xs text-slate-500 mb-2">選択: {selectedFileName}</p>}
          {csvRunning && <p className="text-sm text-slate-600">取込中...</p>}

          {csvError && (
            <ImportErrorPanel title="CSV取込エラー" summary={csvError} details={csvErrorDetails} />
          )}
          {csvImportResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-900">
              <p className="font-medium">{csvImportResult.message}</p>
              <p className="mt-1 text-xs">
                注文 {csvImportResult.ordersUpserted}件 / 売上行 {csvImportResult.salesUpserted}件
              </p>
              {csvImportResult.rowErrors?.length > 0 && (
                <ImportRowWarnings rowErrors={csvImportResult.rowErrors} />
              )}
            </div>
          )}
        </section>

        {/* STEP 2: 在庫引当 */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Package className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-bold text-slate-800">STEP 2：在庫引当</h2>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            CSV取込済みの注文について、在庫を紐付けます。結果を確認してから STEP 3 へ進んでください。
          </p>
          <button
            type="button"
            onClick={runReconcileLoop}
            disabled={reconcileRunning}
            className={`${buttonClass} bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-300`}
          >
            {reconcileRunning ? `在庫引当中... (${reconcileRound}回目)` : "在庫引当を実行"}
          </button>

          {reconcileError && (
            <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{reconcileError}</div>
          )}
          {reconcileResult && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="font-medium text-slate-800">{reconcileResult.message}</p>
              <p className="mt-1 text-slate-600">
                成功: {reconcileResult.completed}件 / 手動: {reconcileResult.manual_required}件
              </p>
            </div>
          )}
        </section>

        {/* STEP 3: 本消込 */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <Banknote className="h-5 w-5 text-slate-600" />
            <h2 className="text-lg font-bold text-slate-800">STEP 3：売上本消込</h2>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            在庫引当が完了した注文について、売上明細と在庫を正式に結び付けます。
          </p>
          <button
            type="button"
            onClick={runReconcileSales}
            disabled={salesRunning}
            className={`${buttonClass} bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300`}
          >
            {salesRunning ? "本消込中..." : "売上を本消込"}
          </button>

          {salesError && (
            <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{salesError}</div>
          )}
          {salesResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-900">
              <p className="font-medium">{salesResult.message}</p>
              <p className="mt-1 text-xs">
                処理注文: {salesResult.processedOrders} / 成功: {salesResult.reconciledCount} / 保留: {salesResult.skippedCount}
              </p>
            </div>
          )}
        </section>

        {/* 手動キュー */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-bold text-slate-800">手動引当が必要な注文</h2>
            <button
              type="button"
              onClick={fetchManualQueue}
              className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50`}
              disabled={manualLoading}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              更新
            </button>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            在庫を自動で見つけられなかった注文です。JAN に一致する在庫を選んで引当してください（本消込は STEP 3 で行います）。
          </p>

          {manualError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800 mb-4">{manualError}</div>
          )}

          {manualLoading ? (
            <p className="text-sm text-slate-500">読み込み中...</p>
          ) : manualOrders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 p-5 text-sm text-slate-600">
              手動引当対象の注文はありません。
            </div>
          ) : (
            <ManualOrderCards
              orders={manualOrders}
              onReconciled={(otherOrderId) => {
                setManualOrders((prev) => prev.filter((o) => o.id !== otherOrderId));
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function ImportErrorPanel({
  title,
  summary,
  details,
}: {
  title: string;
  summary: string;
  details: CsvImportErrorDetails | null;
}) {
  return (
    <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{summary}</p>
      {details?.step && (
        <p className="mt-2 text-xs">
          <span className="font-medium">処理段階:</span> {details.step}
        </p>
      )}
      {details?.code && (
        <p className="mt-1 text-xs font-mono">
          <span className="font-medium font-sans">DBコード:</span> {details.code}
        </p>
      )}
      {details?.details && (
        <p className="mt-1 text-xs break-all">
          <span className="font-medium">詳細:</span> {details.details}
        </p>
      )}
      {details?.hint && (
        <p className="mt-1 text-xs text-red-800">
          <span className="font-medium">ヒント:</span> {details.hint}
        </p>
      )}
      {details?.httpStatus != null && details.httpStatus >= 400 && (
        <p className="mt-1 text-xs text-red-700">HTTP {details.httpStatus}</p>
      )}
      {details?.rowErrors && details.rowErrors.length > 0 && (
        <ImportRowWarnings rowErrors={details.rowErrors} variant="error" />
      )}
      {details?.rawBody && (
        <pre className="mt-2 max-h-32 overflow-auto rounded bg-red-100/80 p-2 text-xs whitespace-pre-wrap break-all">
          {details.rawBody}
        </pre>
      )}
    </div>
  );
}

function ImportRowWarnings({
  rowErrors,
  variant = "warning",
}: {
  rowErrors: string[];
  variant?: "warning" | "error";
}) {
  const boxClass =
    variant === "error"
      ? "mt-3 rounded border border-red-300 bg-red-100/50 p-2"
      : "mt-3 rounded border border-amber-300 bg-amber-50 p-2";
  const titleClass = variant === "error" ? "font-medium text-red-900" : "font-medium text-amber-900";

  return (
    <div className={boxClass}>
      <p className={`text-xs ${titleClass}`}>行ごとのエラー（{rowErrors.length}件）</p>
      <ul className="mt-1 list-disc pl-5 text-xs space-y-0.5">
        {rowErrors.map((msg, i) => (
          <li key={`${i}-${msg}`}>{msg}</li>
        ))}
      </ul>
    </div>
  );
}

function ManualOrderCards({
  orders,
  onReconciled,
}: {
  orders: OtherOrder[];
  onReconciled: (otherOrderId: string) => void;
}) {
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {orders.map((order) => (
        <ManualOtherOrderCard key={order.id} order={order} onReconciled={onReconciled} />
      ))}
    </div>
  );
}

function ManualOtherOrderCard({
  order,
  onReconciled,
}: {
  order: OtherOrder;
  onReconciled: (otherOrderId: string) => void;
}) {
  const [candidates, setCandidates] = useState<InboundCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescueExtra, setRescueExtra] = useState<InboundCandidate[]>([]);
  const [rescueQuery, setRescueQuery] = useState(() => (order.jan_code ?? "").trim());
  const [rescueLoading, setRescueLoading] = useState(false);
  const [rescueError, setRescueError] = useState<string | null>(null);

  const mergedCandidates = useMemo(() => mergeInboundById(candidates, rescueExtra), [candidates, rescueExtra]);

  useEffect(() => {
    setRescueExtra([]);
    setRescueQuery((order.jan_code ?? "").trim());
    setRescueError(null);
    setSelectedId(null);
  }, [order.id, order.jan_code]);

  useEffect(() => {
    let cancelled = false;
    setLoadingCandidates(true);
    setError(null);
    const params = new URLSearchParams({
      other_order_id: order.id,
      order_id: order.order_id,
      platform: order.platform,
    });
    fetch(`/api/other-platform/orders/candidates?${params}`)
      .then(async (res) => {
        const raw = await res.json().catch(() => null);
        if (!res.ok) {
          const msg =
            raw && typeof raw === "object" && "error" in raw && typeof raw.error === "string"
              ? raw.error
              : "候補の取得に失敗しました";
          throw new Error(msg);
        }
        return Array.isArray(raw) ? raw : [];
      })
      .then((data) => {
        if (!cancelled) {
          setCandidates(data.map((r) => normalizeInboundCandidate(r as Record<string, unknown>)));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "候補の取得に失敗しました");
          setCandidates([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCandidates(false);
      });
    return () => {
      cancelled = true;
    };
  }, [order.id, order.order_id, order.platform]);

  const runRescueSearch = async () => {
    const q = rescueQuery.trim();
    if (!q) {
      setRescueError("JAN または商品名を入力してください。");
      return;
    }
    setRescueLoading(true);
    setRescueError(null);
    try {
      const params = new URLSearchParams({ search: q, order_id: order.order_id });
      const res = await fetch(`/api/other-platform/orders/candidates?${params}`);
      const raw: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          raw && typeof raw === "object" && "error" in raw && typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : "検索に失敗しました";
        throw new Error(msg);
      }
      const list = Array.isArray(raw) ? raw : [];
      const mapped = list.map((r) => normalizeInboundCandidate(r as Record<string, unknown>));
      setRescueExtra(mapped);
      if (mapped.length === 0) setRescueError("該当する在庫がありませんでした");
    } catch (e) {
      setRescueError(e instanceof Error ? e.message : "検索に失敗しました");
    } finally {
      setRescueLoading(false);
    }
  };

  const confirm = async () => {
    if (selectedId == null) {
      setError("在庫候補を選択してください。");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/other-platform/manual-reconcile-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherOrderId: order.id, stockId: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "手動引当に失敗しました");
      onReconciled(order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "手動引当に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
      <p className="text-sm font-mono font-bold text-slate-900 truncate" title={`${order.platform}/${order.order_id}`}>
        {order.platform} / {order.order_id}
      </p>
      <div className="mt-2 space-y-1 text-xs text-slate-600">
        <p>
          SKU: <span className="font-mono">{order.sku ?? "—"}</span>
        </p>
        <p>販売価格: {order.sell_price}</p>
        <p>
          JAN: <span className="font-mono">{order.jan_code ?? "—"}</span>
        </p>
        {order.condition_id && <p>コンディション: {order.condition_id}</p>}
      </div>

      {loadingCandidates ? (
        <p className="mt-3 text-xs text-slate-500">在庫候補を取得中…</p>
      ) : mergedCandidates.length === 0 ? (
        <div className="mt-3 space-y-2 rounded-lg border border-red-100 bg-red-50/50 p-3">
          <p className="text-xs font-semibold text-red-800">
            JAN に一致する在庫がありません。下の検索で JAN または商品名を試してください。
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-semibold text-slate-600">在庫候補を選択</label>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
            disabled={submitting}
            className="w-full rounded-md border-2 border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-800 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
          >
            <option value="">選択してください</option>
            {mergedCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {formatInboundOptionLabel(c)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-3 space-y-2">
        <label className="block text-xs font-semibold text-slate-600">JAN / 商品名で検索</label>
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
        {rescueError && <p className="text-[11px] font-medium text-red-700">{rescueError}</p>}
        {rescueExtra.length > 0 && (
          <p className="text-[11px] text-sky-800/90">検索で {rescueExtra.length} 件ヒット（候補に反映）</p>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

      <button
        type="button"
        disabled={submitting || selectedId == null}
        onClick={() => void confirm()}
        className={`${buttonClass} mt-3 w-full ${
          submitting || selectedId == null
            ? "bg-amber-300 cursor-not-allowed"
            : "bg-amber-500 text-white hover:bg-amber-600"
        } text-sm`}
      >
        {submitting ? "確定中..." : "この在庫で引当する"}
      </button>
    </div>
  );
}
