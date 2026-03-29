"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { UploadCloud, ShieldCheck } from "lucide-react";

type AmazonOrdersImportRow = {
  amazonOrderId: string;
  purchaseDate: string;
  sku: string;
  asin?: string;
  itemPrice?: number;
  quantity?: number;
  orderStatus?: string;
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
  const orderStatusHeader = pickHeaderKey(headers, ["order-status", "order status", "status", "注文ステータス", "出荷ステータス"]);

  if (amazonOrderIdHeader) headerMapping.amazonOrderId = amazonOrderIdHeader;
  if (purchaseDateHeader) headerMapping.purchaseDate = purchaseDateHeader;
  if (skuHeader) headerMapping.sku = skuHeader;
  if (asinHeader) headerMapping.asin = asinHeader;
  if (itemPriceHeader) headerMapping.itemPrice = itemPriceHeader;
  if (quantityHeader) headerMapping.quantity = quantityHeader;
  if (orderStatusHeader) headerMapping.orderStatus = orderStatusHeader;

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
    errors?: string[];
    rawErrors?: unknown[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsePreview, setParsePreview] = useState<{
    previewRows: number;
    previewErrors: number;
    mapping: ParseResult["headerMapping"];
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
        setResult({ ok: true, received: 0, upserted: 0, skipped: 0, errors: parsed.rowErrors });
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
        errors?: unknown[];
      };

      if (!res.ok) {
        setError(data?.error ?? "インポートに失敗しました");
        setResult({
          ok: false,
          received: data?.received ?? parsed.rows.length,
          upserted: data?.upserted ?? 0,
          skipped: data?.skipped ?? 0,
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

  return (
    <main className="flex-1 py-8 w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="rounded-xl bg-primary/10 p-3 text-primary">
            <UploadCloud className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Amazon 注文レポート一括インポート</h1>
            <p className="text-sm text-slate-500">CSV/TSVをアップロードすると自動で `amazon_orders` に登録します</p>
          </div>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-bold text-slate-800 mb-3">1) ファイル選択</h2>
          <p className="text-sm text-slate-600 mb-4">
            必須ヘッダー: <span className="font-mono">amazonOrderId / purchaseDate / sku</span>
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
          <h2 className="text-lg font-bold text-slate-800 mb-3">2) 結果</h2>

          {!result ? (
            <p className="text-sm text-slate-500">ファイルを選択すると結果が表示されます。</p>
          ) : result.ok ? (
            <div className="rounded-lg border border-slate-200 bg-emerald-50/60 p-4">
              <p className="font-medium text-emerald-800">インポート完了</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-emerald-900">
                <span>受信: {result.received}件</span>
                <span>登録: {result.upserted}件</span>
                <span>スキップ: {result.skipped}件</span>
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

