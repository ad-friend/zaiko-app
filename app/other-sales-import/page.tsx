"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileUp, RefreshCcw } from "lucide-react";

type OtherOrder = {
  id: string;
  order_id: string;
  platform: string;
  sell_price: number;
  jan_code: string | null;
  stock_id: number | null;
  status: string;
  created_at?: string;
};

type AutoReconcileResult = {
  ok: true;
  input: {
    orderId: string;
    platform: string;
    sellPrice: number;
    janCode?: string;
    sku?: string;
  };
  otherOrderId: string | null;
  status: "completed" | "manual_required";
  matchedStockId?: number | null;
} | {
  ok: false;
  input: {
    orderId: string;
    platform: string;
    sellPrice: number;
    janCode?: string;
    sku?: string;
  };
  otherOrderId: string | null;
  status: "error";
  error: string;
};

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
};

const parseMoneyToNumber = (raw: string): number => {
  const cleaned = raw.trim().replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
};

const normalizeHeader = (s: string) => s.replace(/\s/g, "");

const parseOtherSalesCsv = (csvText: string) => {
  const lines = csvText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) throw new Error("CSVにデータ行がありません。");

  const header = parseCsvLine(lines[0]).map((h) => normalizeHeader(h));

  const idx = (label: string) => header.indexOf(normalizeHeader(label));
  const iOrder = idx("注文番号");
  const iPlatform = idx("プラットフォーム");
  const iSell = idx("販売価格");
  const iJan = idx("JAN");
  const iSku = idx("SKU");

  if (iOrder < 0 || iPlatform < 0 || iSell < 0) {
    throw new Error("ヘッダーが不正です。注文番号/プラットフォーム/販売価格を確認してください。");
  }

  const rows: Array<{ orderId: string; platform: string; sellPrice: number; janCode?: string; sku?: string }> = [];
  const rowErrors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const orderId = (cols[iOrder] ?? "").trim();
    const platform = (cols[iPlatform] ?? "").trim();
    const sellPriceRaw = (cols[iSell] ?? "").trim();
    const sellPrice = parseMoneyToNumber(sellPriceRaw);
    const janCode = iJan >= 0 ? (cols[iJan] ?? "").trim() : "";
    const sku = iSku >= 0 ? (cols[iSku] ?? "").trim() : "";

    if (!orderId || !platform) continue;
    if (!Number.isFinite(sellPrice)) {
      rowErrors.push(`行 ${i + 1}: 販売価格が数値として解釈できません`);
      continue;
    }

    const item: { orderId: string; platform: string; sellPrice: number; janCode?: string; sku?: string } = {
      orderId,
      platform,
      sellPrice,
    };

    if (janCode) item.janCode = janCode;
    if (sku) item.sku = sku;

    rows.push(item);
  }

  return { rows, rowErrors };
};

export default function OtherSalesImportPage() {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<ReturnType<typeof parseOtherSalesCsv> | null>(null);
  const [autoResult, setAutoResult] = useState<{
    ok: boolean;
    processed: number;
    completed: number;
    manual_required: number;
    results: AutoReconcileResult[];
  } | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [manualOrders, setManualOrders] = useState<OtherOrder[]>([]);
  const [manualLoading, setManualLoading] = useState(true);
  const [manualError, setManualError] = useState<string | null>(null);

  const fetchManualQueue = useCallback(async () => {
    setManualError(null);
    try {
      const res = await fetch("/api/other-sales-import?status=manual_required");
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

  const parsedSummary = useMemo(() => {
    const previewRows = selectedPreview?.rows?.length ?? 0;
    const previewErrors = selectedPreview?.rowErrors?.length ?? 0;
    return { previewRows, previewErrors };
  }, [selectedPreview]);

  const handleCsvUpload = async (file: File) => {
    setAutoError(null);
    setAutoResult(null);
    setAutoRunning(true);
    setSelectedFileName(file.name);

    try {
      const text = await file.text();
      const parsed = parseOtherSalesCsv(text);
      setSelectedPreview(parsed);

      if (parsed.rowErrors.length > 0) {
        setAutoError(`CSVパースで一部エラー: ${parsed.rowErrors.slice(0, 3).join(" / ")}${parsed.rowErrors.length > 3 ? `(+${parsed.rowErrors.length - 3})` : ""}`);
      }

      if (!parsed.rows.length) {
        setAutoResult({
          ok: true,
          processed: 0,
          completed: 0,
          manual_required: 0,
          results: [],
        });
        return;
      }

      const res = await fetch("/api/other-sales-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.rows),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "自動消込の実行に失敗しました");

      setAutoResult(data);
      await fetchManualQueue();
    } catch (e) {
      setAutoError(e instanceof Error ? e.message : "自動消込に失敗しました");
    } finally {
      setAutoRunning(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await handleCsvUpload(file);
    // 同じファイルを再選択できるように初期化
    e.target.value = "";
  };

  return (
    <main className="flex-1 py-8 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <FileUp className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">他販路 売上CSV 自動消込</h1>
            <p className="text-sm text-slate-500">CSV一括アップロード → 在庫引当 → 自動消込 / エラーは手動へ</p>
          </div>
        </div>

        {/* セクションA */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">セクションA：CSVアップロード</h2>
          <p className="text-sm text-slate-600 mb-4">
            CSVヘッダー要件: <span className="font-mono">注文番号, プラットフォーム, 販売価格, JAN, SKU</span>
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <input type="file" accept=".csv" onChange={onFileChange} disabled={autoRunning} className="block w-full text-sm text-slate-700" />
              {selectedFileName && <p className="mt-2 text-xs text-slate-500">選択: {selectedFileName}</p>}
            </div>
            <div className="shrink-0">
              <button
                type="button"
                disabled
                className={`${buttonClass} bg-slate-100 text-slate-400 border border-slate-200`}
                title="ファイル選択後、自動で実行します"
              >
                {autoRunning ? "処理中..." : "自動実行"}
              </button>
            </div>
          </div>

          {selectedPreview && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700">
              <p className="font-medium">パース結果</p>
              <p className="mt-1 text-xs text-slate-500">有効行: {parsedSummary.previewRows}件 / パース警告: {parsedSummary.previewErrors}件</p>
            </div>
          )}

          {autoError && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
              {autoError}
            </div>
          )}

          {autoResult && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-emerald-50/60 p-4">
              <p className="font-medium text-emerald-800">自動消込結果</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-emerald-900">
                <span>処理: {autoResult.processed}件</span>
                <span>成功: {autoResult.completed}件</span>
                <span>手動: {autoResult.manual_required}件</span>
              </div>
              {autoResult.results?.length > 0 && (
                <div className="mt-4 max-h-[220px] overflow-y-auto pr-0.5">
                  <ul className="space-y-2">
                    {autoResult.results.slice(0, 30).map((r, idx) => (
                      <li key={idx} className="rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate font-mono" title={r.input.orderId}>
                            {r.input.platform} / {r.input.orderId}
                          </p>
                          <p className={`font-semibold ${r.ok && r.status === "completed" ? "text-emerald-700" : r.ok && r.status === "manual_required" ? "text-amber-700" : "text-red-700"}`}>
                            {r.ok ? r.status : "error"}
                          </p>
                        </div>
                        <p className="mt-1">
                          販売価格: {r.input.sellPrice}
                          {" / "}
                          JAN: {" "}
                          {r.input.janCode ?? "—"}
                          {" / "}
                          SKU: {" "}
                          {r.input.sku ?? "—"}
                          {" / "}
                          引当在庫ID: {" "}
                          {r.ok && r.status === "completed" ? r.matchedStockId ?? "—" : "—"}
                        </p>
                        {!r.ok && <p className="mt-1 text-red-700">エラー: {r.error}</p>}
                      </li>
                    ))}
                  </ul>
                  {autoResult.results.length > 30 && <p className="mt-2 text-xs text-slate-500">結果表示は先頭30件のみです。</p>}
                </div>
              )}
            </div>
          )}
        </section>

        {/* セクションB */}
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-lg font-bold text-slate-800">セクションB：手動処理が必要なカード一覧</h2>
            <button
              type="button"
              onClick={fetchManualQueue}
              className={`${buttonClass} bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300`}
              disabled={manualLoading}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              更新
            </button>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            自動消込で在庫が見つからなかった注文（status: <span className="font-mono">manual_required</span>）を、正しい在庫IDで手動紐付けしてください。
          </p>

          {manualError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800 mb-4">
              {manualError}
            </div>
          )}

          {manualLoading ? (
            <p className="text-sm text-slate-500">読み込み中...</p>
          ) : manualOrders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 p-5 text-sm text-slate-600">
              手動処理対象の注文はありません。
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

function ManualOrderCards({
  orders,
  onReconciled,
}: {
  orders: OtherOrder[];
  onReconciled: (otherOrderId: string) => void;
}) {
  const [cardSubmitting, setCardSubmitting] = useState<Record<string, boolean>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string | null>>({});
  const [selectedStockByOrderId, setSelectedStockByOrderId] = useState<Record<string, string>>({});

  useEffect(() => {
    // 初期値: other_orders に既に保存されている stock_id（ある場合）
    const next: Record<string, string> = {};
    for (const o of orders) {
      next[o.id] = o.stock_id != null ? String(o.stock_id) : "";
    }
    setSelectedStockByOrderId(next);
  }, [orders]);

  const confirm = async (order: OtherOrder) => {
    const input = selectedStockByOrderId[order.id] ?? "";
    const stockId = Number(input);
    if (!Number.isFinite(stockId) || stockId < 1) {
      setCardErrors((p) => ({ ...p, [order.id]: "有効な在庫IDを入力してください。" }));
      return;
    }
    setCardErrors((p) => ({ ...p, [order.id]: null }));
    setCardSubmitting((p) => ({ ...p, [order.id]: true }));

    try {
      const res = await fetch("/api/other-sales-import/manual-reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherOrderId: order.id, stockId }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "手動消込に失敗しました");

      onReconciled(order.id);
    } catch (e) {
      setCardErrors((p) => ({ ...p, [order.id]: e instanceof Error ? e.message : "手動消込に失敗しました" }));
    } finally {
      setCardSubmitting((p) => ({ ...p, [order.id]: false }));
    }
  };

  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      {orders.map((order) => (
        <div key={order.id} className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-mono font-bold text-slate-900 truncate" title={`${order.platform}/${order.order_id}`}>
                {order.platform} / {order.order_id}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                販売価格: {order.sell_price}
              </p>
            </div>
          </div>

          <div className="space-y-2 text-xs text-slate-600">
            <p>
              JAN: <span className="font-mono">{order.jan_code ?? "—"}</span>
            </p>
            <p>
              指定在庫ID: <span className="font-mono">{order.stock_id ?? "—"}</span>
            </p>
          </div>

          <div className="mt-3">
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              紐付け先の在庫ID
            </label>
            <input
              value={selectedStockByOrderId[order.id] ?? ""}
              onChange={(e) => setSelectedStockByOrderId((p) => ({ ...p, [order.id]: e.target.value }))}
              inputMode="numeric"
              placeholder="例: 123"
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
          </div>

          {cardErrors[order.id] && (
            <p className="mt-2 text-xs text-red-700">
              {cardErrors[order.id]}
            </p>
          )}

          <button
            type="button"
            disabled={cardSubmitting[order.id]}
            onClick={() => confirm(order)}
            className={`${buttonClass} mt-3 w-full ${
              cardSubmitting[order.id] ? "bg-amber-300 text-amber-50 cursor-not-allowed" : "bg-amber-500 text-white hover:bg-amber-600"
            } text-sm`}
          >
            {cardSubmitting[order.id] ? "確定中..." : "この在庫で紐付ける"}
          </button>
        </div>
      ))}
    </div>
  );
}

