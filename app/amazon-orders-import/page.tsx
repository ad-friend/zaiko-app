"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { UploadCloud, ShieldCheck, RotateCcw } from "lucide-react";

type AmazonOrdersImportRow = {
  amazonOrderId: string;
  purchaseDate: string;
  sku: string;
  asin?: string;
  itemPrice?: number;
  quantity?: number;
  orderStatus?: string;
  itemStatus?: string;
};

type ParseResult = {
  rows: AmazonOrdersImportRow[];
  rowErrors: string[];
  headerMapping: Partial<Record<keyof AmazonOrdersImportRow, string>>;
};

const buttonClass =
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 h-10 px-6 py-2 shadow-sm active:scale-[0.98] duration-100";

function normalizeHeaderKey(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .replace(/[\-_.:()]/g, "")
    .replace(/\//g, "");
}

function pickHeaderKey(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers
    .map((h) => ({ actual: h, norm: normalizeHeaderKey(h) }))
    .filter((x) => x.norm.length > 0);

  for (const c of candidates) {
    const cand = normalizeHeaderKey(c);
    if (!cand) continue;

    // 完全一致 → 包含（括弧や補足が付くケース） の順
    const exact = normalizedHeaders.find((h) => h.norm === cand);
    if (exact) return exact.actual;

    const includes = normalizedHeaders.find((h) => h.norm.includes(cand));
    if (includes) return includes.actual;
  }

  return null;
}

function guessDelimiter(fileName: string, headerLine: string): "," | "\t" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return "\t";
  if (lower.endsWith(".csv")) return ",";

  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const tabCount = (headerLine.match(/\t/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function parseMoneyToNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function buildMappingAndRows(text: string, fileName: string): ParseResult {
  // 先頭数行からヘッダーっぽい1行を取り、区切り文字推定に使う
  const firstNonEmptyLine = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";

  const delimiter = guessDelimiter(fileName, firstNonEmptyLine);

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter: delimiter === "," ? "," : "\t",
    skipEmptyLines: "greedy",
  });

  const headers = (parsed.meta.fields ?? []).filter((h) => typeof h === "string") as string[];
  const headerMapping: ParseResult["headerMapping"] = {};

  const amazonOrderIdHeader = pickHeaderKey(headers, [
    "amazon-order-id",
    "amazon order id",
    "amazonorderid",
    "order-id",
    "order id",
    "orderid",
    "注文ID",
    "注文番号",
    "amazon注文id",
  ]);
  const purchaseDateHeader = pickHeaderKey(headers, [
    "purchase-date",
    "purchase date",
    "purchasedate",
    "order-date",
    "注文日",
    "購入日",
  ]);
  const skuHeader = pickHeaderKey(headers, ["sku", "seller-sku", "sellersku", "productsku", "SKU", "商品SKU", "出荷SKU"]);
  const asinHeader = pickHeaderKey(headers, ["asin", "ASIN", "商品ASIN"]);
  const itemPriceHeader = pickHeaderKey(headers, ["item-price", "item price", "itemprice", "price", "単価", "商品価格"]);
  const quantityHeader = pickHeaderKey(headers, ["quantity", "qty", "数量", "item-quantity", "item quantity", "数量(個)"]);
  const orderStatusHeader = pickHeaderKey(headers, [
    "order-status",
    "order status",
    "orderstatus",
    "注文ステータス",
    "注文のステータス",
    "status",
    "出荷ステータス",
  ]);
  const itemStatusHeader = pickHeaderKey(headers, [
    "item-status",
    "item status",
    "itemstatus",
    "明細ステータス",
    "商品ステータス",
  ]);

  if (amazonOrderIdHeader) headerMapping.amazonOrderId = amazonOrderIdHeader;
  if (purchaseDateHeader) headerMapping.purchaseDate = purchaseDateHeader;
  if (skuHeader) headerMapping.sku = skuHeader;
  if (asinHeader) headerMapping.asin = asinHeader;
  if (itemPriceHeader) headerMapping.itemPrice = itemPriceHeader;
  if (quantityHeader) headerMapping.quantity = quantityHeader;
  if (orderStatusHeader) headerMapping.orderStatus = orderStatusHeader;
  if (itemStatusHeader) headerMapping.itemStatus = itemStatusHeader;

  const rowErrors: string[] = [];
  const rows: AmazonOrdersImportRow[] = [];

  if (!amazonOrderIdHeader || !purchaseDateHeader || !skuHeader) {
    throw new Error("必須ヘッダーが見つかりません（amazonOrderId / purchaseDate / sku）。");
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || typeof r !== "object") continue;

    const amazonOrderId = toTrimmedString(r[amazonOrderIdHeader]);
    const purchaseDate = toTrimmedString(r[purchaseDateHeader]);
    const sku = toTrimmedString(r[skuHeader]);
    const asin = asinHeader ? toTrimmedString(r[asinHeader]) : "";
    const itemPrice =
      itemPriceHeader != null ? parseMoneyToNumber(toTrimmedString(r[itemPriceHeader])) ?? undefined : undefined;
    const quantity =
      quantityHeader != null ? parseMoneyToNumber(toTrimmedString(r[quantityHeader])) ?? undefined : undefined;
    const orderStatus = orderStatusHeader ? toTrimmedString(r[orderStatusHeader]) : "";
    const itemStatus = itemStatusHeader ? toTrimmedString(r[itemStatusHeader]) : "";

    if (!amazonOrderId || !purchaseDate || !sku) {
      rowErrors.push(`行 ${i + 2}: amazonOrderId/purchaseDate/sku のいずれかが空です。`);
      continue;
    }

    rows.push({
      amazonOrderId,
      purchaseDate,
      sku,
      asin: asin ? asin : undefined,
      itemPrice: itemPrice != null ? itemPrice : undefined,
      quantity: quantity != null ? quantity : undefined,
      orderStatus: orderStatus ? orderStatus : undefined,
      itemStatus: itemStatus ? itemStatus : undefined,
    });
  }

  return { rows, rowErrors, headerMapping };
}

export default function AmazonOrdersImportPage() {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    received: number;
    upserted: number;
    skipped: number;
    skipped_removal_orders?: number;
    skipped_cancelled?: number;
    skipped_cancelled_new?: number;
    cancellation_rollbacks?: number;
    errors?: string[];
    rawErrors?: unknown[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsePreview, setParsePreview] = useState<{
    previewRows: number;
    previewErrors: number;
    mapping: ParseResult["headerMapping"];
  } | null>(null);

  const [returnsFileName, setReturnsFileName] = useState<string | null>(null);
  const [returnsRunning, setReturnsRunning] = useState(false);
  const [returnsError, setReturnsError] = useState<string | null>(null);
  const [returnsResult, setReturnsResult] = useState<{
    ok: boolean;
    total_rows_read?: number;
    unique_orders_in_file?: number;
    processed_returns?: number;
    skipped_unregistered?: number;
    skipped_already_processed?: number;
    row_parse_warnings?: number;
    errors?: string[];
  } | null>(null);
  const parsedSummary = useMemo(() => {
    if (!parsePreview) return null;
    return `有効行: ${parsePreview.previewRows}件 / パース警告: ${parsePreview.previewErrors}件`;
  }, [parsePreview]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);
    setSelectedFileName(file.name);
    setAutoRunning(true);

    try {
      const text = await file.text();
      const parsed = buildMappingAndRows(text, file.name);

      setParsePreview({
        previewRows: parsed.rows.length,
        previewErrors: parsed.rowErrors.length,
        mapping: parsed.headerMapping,
      });

      if (!parsed.rows.length) {
        setResult({
          ok: true,
          received: 0,
          upserted: 0,
          skipped: 0,
          skipped_removal_orders: 0,
          skipped_cancelled: 0,
          errors: parsed.rowErrors,
        });
        return;
      }

      const res = await fetch("/api/amazon-orders-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.rows),
      });

      const data = (await res.json()) as {
        error?: string;
        received?: number;
        upserted?: number;
        skipped?: number;
        skipped_removal_orders?: number;
        skipped_cancelled?: number;
        skipped_cancelled_new?: number;
        cancellation_rollbacks?: number;
        errors?: unknown[];
      };

      if (!res.ok) {
        setError(data?.error ?? "インポートに失敗しました");
        setResult({
          ok: false,
          received: data?.received ?? parsed.rows.length,
          upserted: data?.upserted ?? 0,
          skipped: data?.skipped ?? 0,
          skipped_removal_orders: data?.skipped_removal_orders,
          skipped_cancelled: data?.skipped_cancelled,
          skipped_cancelled_new: data?.skipped_cancelled_new,
          cancellation_rollbacks: data?.cancellation_rollbacks,
          errors: parsed.rowErrors,
          rawErrors: data?.errors ?? [],
        });
        return;
      }

      const rawErrors = (data.errors ?? []) as unknown[];
      setResult({
        ok: true,
        received: data.received ?? parsed.rows.length,
        upserted: data.upserted ?? 0,
        skipped: data.skipped ?? 0,
        skipped_removal_orders: data.skipped_removal_orders,
        skipped_cancelled: data.skipped_cancelled,
        skipped_cancelled_new: data.skipped_cancelled_new,
        cancellation_rollbacks: data.cancellation_rollbacks,
        rawErrors,
        errors: [
          ...parsed.rowErrors,
          ...rawErrors
            .slice(0, 10)
            .map((x) => {
              if (typeof x === "string") return x;
              const maybeErr = (x as { error?: unknown } | null | undefined)?.error;
              return typeof maybeErr === "string" ? maybeErr : "";
            })
            .filter(Boolean),
        ],
      });
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "インポートに失敗しました");
    } finally {
      setAutoRunning(false);
      e.target.value = "";
    }
  };

  const handleReturnsFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setReturnsError(null);
    setReturnsResult(null);
    setReturnsFileName(file.name);
    setReturnsRunning(true);

    try {
      const form = new FormData();
      form.set("file", file);

      const res = await fetch("/api/amazon/returns-import", {
        method: "POST",
        body: form,
      });

      const data = (await res.json()) as {
        error?: string;
        ok?: boolean;
        total_rows_read?: number;
        unique_orders_in_file?: number;
        processed_returns?: number;
        skipped_unregistered?: number;
        skipped_already_processed?: number;
        row_parse_warnings?: number;
        errors?: string[];
      };

      if (!res.ok) {
        setReturnsError(data?.error ?? "返品インポートに失敗しました");
        setReturnsResult({
          ok: false,
          errors: data?.errors,
        });
        return;
      }

      setReturnsResult({
        ok: true,
        total_rows_read: data.total_rows_read,
        unique_orders_in_file: data.unique_orders_in_file,
        processed_returns: data.processed_returns,
        skipped_unregistered: data.skipped_unregistered,
        skipped_already_processed: data.skipped_already_processed,
        row_parse_warnings: data.row_parse_warnings,
        errors: data.errors,
      });
    } catch (err) {
      setReturnsError(err instanceof Error ? err.message : "返品インポートに失敗しました");
    } finally {
      setReturnsRunning(false);
      e.target.value = "";
    }
  };

  return (
    <main className="flex-1 py-8 w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <UploadCloud className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Amazon 注文レポート一括インポート</h1>
            <p className="text-sm text-slate-500">
              注文レポート・返品レポートをそれぞれアップロードできます（返品は在庫巻き戻しと `returned` 更新）
            </p>
          </div>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-violet-50 p-2 text-violet-700">
              <RotateCcw className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-slate-800">返品レポート（FBA 返品等）</h2>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            必須: 注文ID列（<span className="font-mono">order-id</span> / <span className="font-mono">amazon-order-id</span> 等）。
            任意: <span className="font-mono">disposition</span>（現状はすべて販売可能扱いで巻き戻し。将来 Sellable / Defective で分岐予定）。
            <br />
            <span className="text-slate-500">
              DB にない注文はスキップします。キャンセル・返品済みは再実行しても安全です。
            </span>
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <input
                type="file"
                accept=".csv,.tsv,.txt"
                onChange={handleReturnsFileChange}
                disabled={returnsRunning}
                className="block w-full text-sm text-slate-700"
              />
              {returnsFileName && <p className="mt-2 text-xs text-slate-500">選択: {returnsFileName}</p>}
            </div>
          </div>

          {returnsRunning && (
            <p className="mt-3 text-sm font-medium text-violet-700" aria-live="polite">
              返品インポートを実行中…
            </p>
          )}

          {returnsError && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{returnsError}</div>
          )}

          {returnsResult?.ok ? (
            <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50/60 p-4">
              <p className="font-medium text-violet-900">返品インポート完了</p>
              <dl className="mt-3 grid gap-2 text-sm text-violet-950 sm:grid-cols-2">
                <div className="flex justify-between gap-2 rounded-md bg-white/70 px-3 py-2 border border-violet-100">
                  <dt className="text-violet-800/90">処理した返品（注文単位）</dt>
                  <dd className="font-semibold tabular-nums">{returnsResult.processed_returns ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/70 px-3 py-2 border border-violet-100">
                  <dt className="text-violet-800/90">未登録でスキップ</dt>
                  <dd className="font-semibold tabular-nums">{returnsResult.skipped_unregistered ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/70 px-3 py-2 border border-violet-100">
                  <dt className="text-violet-800/90">処理済みでスキップ</dt>
                  <dd className="font-semibold tabular-nums">{returnsResult.skipped_already_processed ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/70 px-3 py-2 border border-violet-100">
                  <dt className="text-violet-800/90">ファイル内の行 / ユニーク注文</dt>
                  <dd className="font-semibold tabular-nums">
                    {returnsResult.total_rows_read ?? 0} / {returnsResult.unique_orders_in_file ?? 0}
                  </dd>
                </div>
              </dl>
              {(returnsResult.row_parse_warnings ?? 0) > 0 && (
                <p className="mt-2 text-xs text-violet-800/80">パース警告: {returnsResult.row_parse_warnings} 件</p>
              )}
              {returnsResult.errors && returnsResult.errors.length > 0 && (
                <div className="mt-3 text-xs text-violet-900/90">
                  <p className="font-medium">メッセージ（先頭）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1 max-h-32 overflow-auto">
                    {returnsResult.errors.slice(0, 10).map((x, idx) => (
                      <li key={idx}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">1) 注文レポート — ファイル選択</h2>
          <p className="text-sm text-slate-600 mb-4">
            必須ヘッダー: <span className="font-mono">amazon-order-id</span> または{" "}
            <span className="font-mono">order-id</span>、<span className="font-mono">purchaseDate</span>、
            <span className="font-mono">sku</span>
            <br />
            <span className="text-slate-500">
              FBA の手元返送オーダー（注文番号が <span className="font-mono">S##-#######-#######</span> 形式）は自動で除外します。
            </span>
            <br />
            コンディション・JAN は自社 DB（sku_mappings / products 等）照合のみです。外部 SP-API は呼び出しません。
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-1">
              <input
                type="file"
                accept=".csv,.tsv,.txt"
                onChange={handleFileChange}
                disabled={autoRunning}
                className="block w-full text-sm text-slate-700"
              />
              {selectedFileName && <p className="mt-2 text-xs text-slate-500">選択: {selectedFileName}</p>}
            </div>
            <div className="shrink-0">
              <button
                type="button"
                disabled
                className={`${buttonClass} bg-slate-100 text-slate-400 border border-slate-200`}
                title="ファイル選択後、自動で実行します"
              >
                {autoRunning ? "インポートを実行中..." : "自動実行"}
              </button>
            </div>
          </div>

          {autoRunning && (
            <p className="mt-3 text-sm font-medium text-primary" aria-live="polite">
              インポートを実行中...
            </p>
          )}

          {parsePreview && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-white border border-slate-200 p-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-700" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">パース結果</p>
                  <p className="mt-1 text-xs text-slate-500">{parsedSummary}</p>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">
              {error}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">2) 注文レポート — 結果</h2>

          {!result ? (
            <p className="text-sm text-slate-500">ファイルを選択すると結果が表示されます。</p>
          ) : result.ok ? (
            <div className="rounded-lg border border-slate-200 bg-emerald-50/60 p-4">
              <p className="font-medium text-emerald-800">インポート完了</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-emerald-900">
                <span>受信: {result.received}件</span>
                <span>登録: {result.upserted}件</span>
                <span>スキップ: {result.skipped}件</span>
                <span>
                  返送等の非標準オーダー（スキップ）: {result.skipped_removal_orders ?? 0}件
                </span>
                {(result.skipped_cancelled ?? 0) > 0 || (result.cancellation_rollbacks ?? 0) > 0 ? (
                  <span className="text-emerald-800/90">
                    キャンセル行 {result.skipped_cancelled ?? 0}件（うちDB未登録で破棄: {result.skipped_cancelled_new ?? 0}件） / 在庫巻き戻しした注文:{" "}
                    {result.cancellation_rollbacks ?? 0}件
                  </span>
                ) : null}
              </div>
              {result.errors && result.errors.length > 0 && (
                <div className="mt-3 text-xs text-emerald-900/80">
                  <p className="font-medium">警告（先頭10件）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1">
                    {result.errors.slice(0, 10).map((x: string, idx: number) => (
                      <li key={idx}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-red-50/60 p-4">
              <p className="font-medium text-red-800">インポート失敗</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-red-900">
                <span>受信: {result.received}件</span>
                <span>登録: {result.upserted}件</span>
                <span>スキップ: {result.skipped}件</span>
                <span>
                  返送等の非標準オーダー（スキップ）: {result.skipped_removal_orders ?? 0}件
                </span>
                {(result.skipped_cancelled ?? 0) > 0 || (result.cancellation_rollbacks ?? 0) > 0 ? (
                  <span>
                    キャンセル行 {result.skipped_cancelled ?? 0}件 / 巻き戻し {result.cancellation_rollbacks ?? 0}件
                  </span>
                ) : null}
              </div>
              {result.rawErrors?.length ? (
                <pre className="mt-3 text-xs overflow-auto rounded border border-red-200 bg-white p-2 text-red-800">
                  {JSON.stringify(result.rawErrors.slice(0, 5), null, 2)}
                </pre>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

