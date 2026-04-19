"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { UploadCloud, ShieldCheck, RotateCcw, Banknote, ScanSearch } from "lucide-react";
import { sliceFromTransactionHeader } from "@/lib/amazon-transaction-csv-header";

/** 売上インポート: 1リクエストあたりのデータ行数（自動消込と同様のチャンク＋リトライ方針） */
const SALES_IMPORT_CHUNK_ROWS = 50;
const SALES_IMPORT_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSalesDataRowEmpty(r: Record<string, string>): boolean {
  return Object.values(r).every((v) => !String(v ?? "").trim());
}

/** 429 / 5xx / ネットワーク失敗時に指数バックオフで再試行 */
async function postAmazonSalesImportChunk(body: object): Promise<Response> {
  let lastNetworkError: Error | null = null;
  for (let attempt = 1; attempt <= SALES_IMPORT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/amazon-sales-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt === SALES_IMPORT_MAX_ATTEMPTS) return res;
      await sleep(400 * 2 ** (attempt - 1));
    } catch (e) {
      lastNetworkError = e instanceof Error ? e : new Error(String(e));
      if (attempt === SALES_IMPORT_MAX_ATTEMPTS) throw lastNetworkError;
      await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw lastNetworkError ?? new Error("通信に失敗しました");
}

async function postAmazonSalesPreviewChunk(body: object): Promise<Response> {
  let lastNetworkError: Error | null = null;
  for (let attempt = 1; attempt <= SALES_IMPORT_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/amazon-sales-import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt === SALES_IMPORT_MAX_ATTEMPTS) return res;
      await sleep(400 * 2 ** (attempt - 1));
    } catch (e) {
      lastNetworkError = e instanceof Error ? e : new Error(String(e));
      if (attempt === SALES_IMPORT_MAX_ATTEMPTS) throw lastNetworkError;
      await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw lastNetworkError ?? new Error("通信に失敗しました");
}

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

async function readJsonOrTextSafe<T = unknown>(
  res: Response
): Promise<{ okJson: boolean; data: T | null; raw: string }> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed) return { okJson: false, data: null, raw };
  try {
    return { okJson: true, data: JSON.parse(trimmed) as T, raw };
  } catch {
    return { okJson: false, data: null, raw };
  }
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
    duplicate_lines_merged?: number;
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

  const [salesFileName, setSalesFileName] = useState<string | null>(null);
  const [salesRunning, setSalesRunning] = useState(false);
  const [salesImportProgress, setSalesImportProgress] = useState<{ completedRows: number; totalRows: number } | null>(
    null
  );
  const [salesError, setSalesError] = useState<string | null>(null);
  const [salesResult, setSalesResult] = useState<{
    ok: boolean;
    rows_read?: number;
    rows_expanded?: number;
    rows_after_merge?: number;
    skipped_prefix_lines?: number;
    merged_split_payment_orders?: number;
    merged_split_payment_extra_rows?: number;
    message?: string;
    upserted?: number;
    row_errors?: string[];
    skipped_rows?: Array<{
      line: number;
      code: string;
      message: string;
      amazon_order_id?: string | null;
      detail?: string;
    }>;
  } | null>(null);

  type SalesResultSkippedRow = {
    line: number;
    code: string;
    message: string;
    amazon_order_id?: string | null;
    detail?: string;
  };

  type SalesPreparedPayload = {
    fileName: string;
    headerFields: string[];
    dataRows: Record<string, string>[];
    skippedPrefixLines: number;
  };
  const [salesPrepared, setSalesPrepared] = useState<SalesPreparedPayload | null>(null);
  /** 未チェック時は CSV の補填・調整行を取り込まない（Finances API 側を正とする） */
  const [allowAdjustments, setAllowAdjustments] = useState(false);
  const [salesPreviewRunning, setSalesPreviewRunning] = useState(false);
  const [salesPreviewError, setSalesPreviewError] = useState<string | null>(null);
  const [salesPreviewResult, setSalesPreviewResult] = useState<{
    ok: true;
    rows_read: number;
    rows_expanded: number;
    rows_after_merge: number;
    skipped_prefix_lines: number;
    merged_split_payment_orders: number;
    merged_split_payment_extra_rows: number;
    message: string;
    row_errors: string[];
    skipped_rows: SalesResultSkippedRow[];
    suspicious: Array<{ business_fingerprint: string; idempotency_keys: string[]; skus: (string | null)[] }>;
    chunks: number;
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
          duplicate_lines_merged: 0,
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

      const parsedRes = await readJsonOrTextSafe<{
        error?: string;
        received?: number;
        upserted?: number;
        skipped?: number;
        skipped_removal_orders?: number;
        duplicate_lines_merged?: number;
        skipped_cancelled?: number;
        skipped_cancelled_new?: number;
        cancellation_rollbacks?: number;
        errors?: unknown[];
      }>(res);

      const data = parsedRes.data;
      if (!res.ok) {
        const rawSnippet = parsedRes.raw.trim().slice(0, 400);
        const msg = (data && typeof data === "object" && typeof data.error === "string" ? data.error : null) ?? rawSnippet;
        setError(msg || "インポートに失敗しました");
        setResult({
          ok: false,
          received: data?.received ?? parsed.rows.length,
          upserted: data?.upserted ?? 0,
          skipped: data?.skipped ?? 0,
          skipped_removal_orders: data?.skipped_removal_orders,
          duplicate_lines_merged: data?.duplicate_lines_merged,
          skipped_cancelled: data?.skipped_cancelled,
          skipped_cancelled_new: data?.skipped_cancelled_new,
          cancellation_rollbacks: data?.cancellation_rollbacks,
          errors: parsed.rowErrors,
          rawErrors: data?.errors ?? (parsedRes.okJson ? [] : [parsedRes.raw]),
        });
        return;
      }

      if (!parsedRes.okJson || !data) {
        setError("サーバー応答が JSON ではありません。コンソールを確認してください。");
        console.warn("[amazon-orders-import] non-json response:", parsedRes.raw.slice(0, 300));
        return;
      }

      const rawErrors = (data.errors ?? []) as unknown[];
      setResult({
        ok: true,
        received: data.received ?? parsed.rows.length,
        upserted: data.upserted ?? 0,
        skipped: data.skipped ?? 0,
        skipped_removal_orders: data.skipped_removal_orders,
        duplicate_lines_merged: data.duplicate_lines_merged,
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

      const parsedRes = await readJsonOrTextSafe<{
        error?: string;
        ok?: boolean;
        total_rows_read?: number;
        unique_orders_in_file?: number;
        processed_returns?: number;
        skipped_unregistered?: number;
        skipped_already_processed?: number;
        row_parse_warnings?: number;
        errors?: string[];
      }>(res);
      const data = parsedRes.data;

      if (!res.ok) {
        const rawSnippet = parsedRes.raw.trim().slice(0, 400);
        const msg = (data && typeof data.error === "string" ? data.error : null) ?? rawSnippet;
        setReturnsError(msg || "返品インポートに失敗しました");
        setReturnsResult({
          ok: false,
          errors: data?.errors,
        });
        return;
      }

      if (!parsedRes.okJson || !data) {
        setReturnsError("サーバー応答が JSON ではありません。");
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

  const handleSalesFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSalesError(null);
    setSalesResult(null);
    setSalesPreviewError(null);
    setSalesPreviewResult(null);
    setSalesPrepared(null);
    setAllowAdjustments(false);
    setSalesFileName(file.name);
    setSalesRunning(false);
    setSalesImportProgress(null);

    try {
      const csvText = await file.text();
      const { body: slicedText, skippedPrefixLines } = sliceFromTransactionHeader(csvText);
      const firstNonEmptyLine =
        slicedText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? "";
      if (!firstNonEmptyLine) {
        setSalesError("ヘッダー行が見つかりません（日付・オーダー番号を含む行がありません）。");
        return;
      }

      const delimiter = guessDelimiter(file.name, firstNonEmptyLine);
      const parsed = Papa.parse<Record<string, string>>(slicedText, {
        header: true,
        delimiter: delimiter === "\t" ? "\t" : ",",
        skipEmptyLines: "greedy",
      });

      const critical = parsed.errors?.filter((err) => err.type === "FieldMismatch" || err.type === "Quotes") ?? [];
      if (critical.length) {
        setSalesError(`CSV パースエラー: ${critical.map((x) => x.message).join("; ")}`);
        return;
      }

      const headerFields = (parsed.meta.fields ?? []).filter(
        (h): h is string => typeof h === "string" && h.trim().length > 0
      );
      const rawRows = Array.isArray(parsed.data) ? parsed.data : [];
      const dataRows: Record<string, string>[] = [];
      for (const row of rawRows) {
        if (!row || typeof row !== "object") continue;
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(row)) {
          rec[k] = v == null ? "" : String(v);
        }
        if (!isSalesDataRowEmpty(rec)) dataRows.push(rec);
      }

      if (dataRows.length === 0) {
        setSalesError("取り込むデータ行がありません。");
        return;
      }

      setSalesPrepared({
        fileName: file.name,
        headerFields,
        dataRows,
        skippedPrefixLines,
      });
    } catch (err) {
      setSalesError(err instanceof Error ? err.message : "売上 CSV の読み取りに失敗しました");
    } finally {
      e.target.value = "";
    }
  };

  type SalesImportApi = {
    error?: string;
    ok?: boolean;
    rows_read?: number;
    rows_expanded?: number;
    rows_after_merge?: number;
    skipped_prefix_lines?: number;
    merged_split_payment_orders?: number;
    merged_split_payment_extra_rows?: number;
    message?: string;
    upserted?: number;
    row_errors?: string[];
    skipped_rows?: SalesResultSkippedRow[];
  };

  type SalesPreviewChunkApi = SalesImportApi & {
    suspicious_business_key_collisions?: Array<{
      business_fingerprint: string;
      idempotency_keys: string[];
      skus: (string | null)[];
    }>;
  };

  const handleSalesPreviewClick = async () => {
    if (!salesPrepared) return;
    setSalesPreviewError(null);
    setSalesPreviewResult(null);
    setSalesPreviewRunning(true);
    setSalesImportProgress({ completedRows: 0, totalRows: salesPrepared.dataRows.length });

    const { fileName, headerFields, dataRows, skippedPrefixLines } = salesPrepared;
    const totalChunks = Math.max(1, Math.ceil(dataRows.length / SALES_IMPORT_CHUNK_ROWS));
    const batchMode = totalChunks > 1;
    const totalRows = dataRows.length;

    let sumRowsRead = 0;
    let sumRowsExpanded = 0;
    let sumRowsAfterMerge = 0;
    let sumMergedOrders = 0;
    let sumMergedExtra = 0;
    const rowErrorsAll: string[] = [];
    const skippedRowsAll: SalesResultSkippedRow[] = [];
    const suspiciousAll: NonNullable<SalesPreviewChunkApi["suspicious_business_key_collisions"]> = [];
    let lastMessage = "";

    try {
      for (let ci = 0; ci < totalChunks; ci++) {
        const start = ci * SALES_IMPORT_CHUNK_ROWS;
        const chunkRows = dataRows.slice(start, start + SALES_IMPORT_CHUNK_ROWS);

        const res = await postAmazonSalesPreviewChunk({
          rows: chunkRows,
          headers: headerFields,
          fileName,
          batchMode,
          chunkIndex: ci,
          totalChunks,
          skippedPrefixLines,
          rowOffsetBase: start,
          allowAdjustments,
        });

        const parsedRes = await readJsonOrTextSafe<SalesPreviewChunkApi>(res);
        const data = parsedRes.data;

        if (!res.ok) {
          const rawSnippet = parsedRes.raw.trim().slice(0, 400);
          const msg = (data && typeof data.error === "string" ? data.error : null) ?? rawSnippet;
          setSalesPreviewError(
            totalChunks > 1
              ? `${msg || "プレビューに失敗しました"}（チャンク ${ci + 1}/${totalChunks}）`
              : msg || "プレビューに失敗しました"
          );
          return;
        }

        if (!parsedRes.okJson || !data) {
          setSalesPreviewError(
            totalChunks > 1
              ? `サーバー応答が JSON ではありません。（チャンク ${ci + 1}/${totalChunks}）`
              : "サーバー応答が JSON ではありません。"
          );
          return;
        }

        setSalesImportProgress({ completedRows: Math.min(start + chunkRows.length, totalRows), totalRows });

        sumRowsRead += data.rows_read ?? 0;
        sumRowsExpanded += data.rows_expanded ?? 0;
        sumRowsAfterMerge += data.rows_after_merge ?? 0;
        sumMergedOrders += data.merged_split_payment_orders ?? 0;
        sumMergedExtra += data.merged_split_payment_extra_rows ?? 0;
        if (data.row_errors?.length) rowErrorsAll.push(...data.row_errors);
        if (data.skipped_rows?.length) skippedRowsAll.push(...data.skipped_rows);
        if (data.suspicious_business_key_collisions?.length) suspiciousAll.push(...data.suspicious_business_key_collisions);
        if (typeof data.message === "string" && data.message) lastMessage = data.message;
      }

      setSalesPreviewResult({
        ok: true,
        rows_read: sumRowsRead,
        rows_expanded: sumRowsExpanded,
        rows_after_merge: sumRowsAfterMerge,
        skipped_prefix_lines: skippedPrefixLines,
        merged_split_payment_orders: sumMergedOrders,
        merged_split_payment_extra_rows: sumMergedExtra,
        message: lastMessage || "プレビュー完了（DB は未更新）。",
        row_errors: rowErrorsAll.slice(0, 50),
        skipped_rows: skippedRowsAll.slice(0, 100),
        suspicious: suspiciousAll.slice(0, 50),
        chunks: totalChunks,
      });
    } catch (err) {
      setSalesPreviewError(err instanceof Error ? err.message : "プレビューに失敗しました");
    } finally {
      setSalesPreviewRunning(false);
      setSalesImportProgress(null);
    }
  };

  const handleSalesImportClick = async () => {
    if (!salesPrepared) return;
    setSalesError(null);
    setSalesResult(null);
    setSalesRunning(true);
    setSalesImportProgress({ completedRows: 0, totalRows: salesPrepared.dataRows.length });

    const { fileName, headerFields, dataRows, skippedPrefixLines } = salesPrepared;
    const totalChunks = Math.max(1, Math.ceil(dataRows.length / SALES_IMPORT_CHUNK_ROWS));
    const batchMode = totalChunks > 1;
    const totalRows = dataRows.length;

    let sumUpserted = 0;
    let sumRowsRead = 0;
    let sumRowsExpanded = 0;
    let sumRowsAfterMerge = 0;
    let sumMergedOrders = 0;
    let sumMergedExtra = 0;
    const rowErrorsAll: string[] = [];
    const skippedRowsAll: SalesResultSkippedRow[] = [];
    let lastMessage = "";

    try {
      for (let ci = 0; ci < totalChunks; ci++) {
        const start = ci * SALES_IMPORT_CHUNK_ROWS;
        const chunkRows = dataRows.slice(start, start + SALES_IMPORT_CHUNK_ROWS);

        const res = await postAmazonSalesImportChunk({
          rows: chunkRows,
          headers: headerFields,
          fileName,
          batchMode,
          chunkIndex: ci,
          totalChunks,
          skippedPrefixLines,
          rowOffsetBase: start,
          allowAdjustments,
        });

        const parsedRes = await readJsonOrTextSafe<SalesImportApi>(res);
        const data = parsedRes.data;

        if (!res.ok) {
          const rawSnippet = parsedRes.raw.trim().slice(0, 400);
          const msg = (data && typeof data.error === "string" ? data.error : null) ?? rawSnippet;
          setSalesError(
            totalChunks > 1
              ? `${msg || "売上データのインポートに失敗しました"}（チャンク ${ci + 1}/${totalChunks}・最大 ${SALES_IMPORT_CHUNK_ROWS} 行）`
              : msg || "売上データのインポートに失敗しました"
          );
          setSalesResult({ ok: false });
          return;
        }

        if (!parsedRes.okJson || !data) {
          setSalesError(
            totalChunks > 1
              ? `サーバー応答が JSON ではありません。（チャンク ${ci + 1}/${totalChunks}）`
              : "サーバー応答が JSON ではありません。"
          );
          return;
        }

        setSalesImportProgress({ completedRows: Math.min(start + chunkRows.length, totalRows), totalRows });

        sumUpserted += data.upserted ?? 0;
        sumRowsRead += data.rows_read ?? 0;
        sumRowsExpanded += data.rows_expanded ?? 0;
        sumRowsAfterMerge += data.rows_after_merge ?? 0;
        sumMergedOrders += data.merged_split_payment_orders ?? 0;
        sumMergedExtra += data.merged_split_payment_extra_rows ?? 0;
        if (data.row_errors?.length) rowErrorsAll.push(...data.row_errors);
        if (data.skipped_rows?.length) skippedRowsAll.push(...data.skipped_rows);
        if (typeof data.message === "string" && data.message) lastMessage = data.message;
      }

      const batchNote =
        totalChunks > 1
          ? ` ${totalChunks} チャンク（各最大 ${SALES_IMPORT_CHUNK_ROWS} 行）で送信しました。注文行がチャンク境界をまたぐ場合はサーバー側で金額を合算します。同じファイルを繰り返し分割取り込みすると二重計上の恐れがあるため、再取り込みは可能なら一括でやり直すか DB を確認してください。`
          : "";

      setSalesResult({
        ok: true,
        rows_read: sumRowsRead,
        rows_expanded: sumRowsExpanded,
        rows_after_merge: sumRowsAfterMerge,
        skipped_prefix_lines: skippedPrefixLines,
        merged_split_payment_orders: sumMergedOrders,
        merged_split_payment_extra_rows: sumMergedExtra,
        message: `${lastMessage || "取り込みが完了しました。"}${batchNote}`,
        upserted: sumUpserted,
        row_errors: rowErrorsAll.slice(0, 50),
        skipped_rows: skippedRowsAll.slice(0, 100),
      });
    } catch (err) {
      setSalesError(err instanceof Error ? err.message : "売上データのインポートに失敗しました");
    } finally {
      setSalesRunning(false);
      setSalesImportProgress(null);
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
              注文レポート・返品レポート・トランザクション売上CSVをアップロードできます（返品は在庫巻き戻しと{" "}
              <span className="font-mono">returned</span> 更新）
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
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-amber-50 p-2 text-amber-800">
              <Banknote className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-slate-800">Amazon 売上データ（トランザクションレポート CSV/TSV）</h2>
          </div>
          <p className="text-sm text-slate-600 mb-4">
            日付範囲別レポート等のトランザクション形式。必須列: 日付（<span className="font-mono">date</span> /{" "}
            <span className="font-mono">posted date</span> 等）、注文番号（<span className="font-mono">order id</span>{" "}
            等）、合計金額（<span className="font-mono">total</span> 等）。任意: <span className="font-mono">type</span>、
            <span className="font-mono">sku</span>。
            <br />
            <span className="text-slate-500">
              ファイル選択でブラウザがパースします。次に「プレビュー」で DB に触れず検証するか、「DBに取り込む」で最大 50 行ずつ API に送信します（タイムアウト回避・失敗時は自動リトライ）。先頭のタイトル行は自動でスキップします。金額列は
              Principal / Tax / 手数料などに縦展開し、同一注文×種別は合算して{" "}
              <span className="font-mono">sales_transactions</span> に保存します。
            </span>
          </p>

          <div className="flex flex-col lg:flex-row items-start lg:items-center gap-4">
            <div className="flex-1 min-w-0">
              <input
                type="file"
                accept=".csv,.tsv,.txt"
                onChange={handleSalesFileChange}
                disabled={salesRunning || salesPreviewRunning}
                className="block w-full text-sm text-slate-700"
              />
              {salesFileName && <p className="mt-2 text-xs text-slate-500">選択: {salesFileName}</p>}
              {salesPrepared && (
                <p className="mt-2 text-sm text-emerald-800/95">
                  パース済み <span className="font-semibold tabular-nums">{salesPrepared.dataRows.length}</span>{" "}
                  行。プレビューまたは取り込みを選んでください。
                </p>
              )}
              {salesPrepared && (
                <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={allowAdjustments}
                    onChange={(e) => setAllowAdjustments(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>補填・調整データも取り込む</span>
                </label>
              )}
            </div>
            <div className="flex shrink-0 flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <button
                type="button"
                disabled={!salesPrepared || salesPreviewRunning || salesRunning}
                onClick={handleSalesPreviewClick}
                className={`${buttonClass} inline-flex items-center gap-2 bg-slate-100 text-slate-800 border border-slate-200 hover:bg-slate-200`}
              >
                <ScanSearch className="h-4 w-4 shrink-0" />
                {salesPreviewRunning ? "プレビュー中…" : "プレビュー"}
              </button>
              <button
                type="button"
                disabled={!salesPrepared || salesPreviewRunning || salesRunning}
                onClick={handleSalesImportClick}
                className={`${buttonClass} bg-amber-600 text-white hover:bg-amber-700 border border-amber-700`}
              >
                {salesRunning ? "取り込み中…" : "DBに取り込む"}
              </button>
            </div>
          </div>

          {(salesRunning || salesPreviewRunning) && (
            <p className="mt-3 text-sm font-medium text-amber-800" aria-live="polite">
              {salesPreviewRunning ? "プレビュー送信中…" : "売上データを取り込み中…"}
              {salesImportProgress && (
                <span className="ml-2 tabular-nums">
                  進捗 {salesImportProgress.completedRows} / 全 {salesImportProgress.totalRows} 件
                </span>
              )}
            </p>
          )}

          {salesError && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{salesError}</div>
          )}

          {salesPreviewError && (
            <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-800">{salesPreviewError}</div>
          )}

          {salesPreviewResult?.ok ? (
            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50/80 p-4">
              <p className="font-medium text-sky-950">売上プレビュー（DB 未更新）</p>
              <p className="mt-1 text-sm tabular-nums text-sky-900/90">
                データ行 {salesPreviewResult.rows_read} / 縦展開 {salesPreviewResult.rows_expanded} / マージ後{" "}
                {salesPreviewResult.rows_after_merge}（{salesPreviewResult.chunks} チャンク）
              </p>
              <p className="mt-2 text-sm text-sky-950/90">{salesPreviewResult.message}</p>
              {salesPreviewResult.suspicious.length > 0 && (
                <div className="mt-3 text-xs text-amber-900">
                  <p className="font-medium">疑わしい idempotency 分裂（チャンク内）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1 max-h-28 overflow-auto">
                    {salesPreviewResult.suspicious.slice(0, 8).map((s, idx) => (
                      <li key={idx}>
                        keys {s.idempotency_keys.length} 件 / skus: {s.skus.filter(Boolean).join(", ") || "—"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {salesPreviewResult.skipped_rows.length > 0 && (
                <div className="mt-3 text-xs text-sky-950/90">
                  <p className="font-medium">スキップ行（先頭）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1 max-h-32 overflow-auto">
                    {salesPreviewResult.skipped_rows.slice(0, 12).map((s, idx) => (
                      <li key={idx}>
                        <span className="font-mono text-[10px]">{s.code}</span> 行 {s.line}: {s.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}

          {salesResult?.ok ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4">
              <p className="font-medium text-amber-950">売上データインポート完了</p>
              <p className="mt-1 text-sm tabular-nums text-amber-900/90">
                全 {salesResult.rows_read ?? 0} データ行の取り込み処理が終了しました（縦展開後 {salesResult.rows_expanded ?? 0}{" "}
                行 → DB 反映 {salesResult.upserted ?? 0} 件）。
              </p>
              <p className="mt-2 text-sm text-amber-950/95">{salesResult.message}</p>
              <dl className="mt-3 grid gap-2 text-sm text-amber-950 sm:grid-cols-2">
                {(salesResult.skipped_prefix_lines ?? 0) > 0 && (
                  <p className="text-xs text-amber-900/80 mb-2">
                    先頭の説明行を {salesResult.skipped_prefix_lines} 行スキップしました。
                  </p>
                )}
                <div className="flex justify-between gap-2 rounded-md bg-white/80 px-3 py-2 border border-amber-100">
                  <dt className="text-amber-900/85">データ行 / 縦展開 / Upsert行</dt>
                  <dd className="font-semibold tabular-nums">
                    {salesResult.rows_read ?? 0} / {salesResult.rows_expanded ?? 0} / {salesResult.rows_after_merge ?? 0}
                  </dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/80 px-3 py-2 border border-amber-100">
                  <dt className="text-amber-900/85">Upsert 件数</dt>
                  <dd className="font-semibold tabular-nums">{salesResult.upserted ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/80 px-3 py-2 border border-amber-100">
                  <dt className="text-amber-900/85">分割決済をマージした注文数</dt>
                  <dd className="font-semibold tabular-nums">{salesResult.merged_split_payment_orders ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-2 rounded-md bg-white/80 px-3 py-2 border border-amber-100">
                  <dt className="text-amber-900/85">合算した余分行数</dt>
                  <dd className="font-semibold tabular-nums">{salesResult.merged_split_payment_extra_rows ?? 0}</dd>
                </div>
              </dl>
              {salesResult.row_errors && salesResult.row_errors.length > 0 && (
                <div className="mt-3 text-xs text-amber-950/90">
                  <p className="font-medium">行レベル警告（先頭）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1 max-h-32 overflow-auto">
                    {salesResult.row_errors.slice(0, 10).map((x, idx) => (
                      <li key={idx}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
              {salesResult.skipped_rows && salesResult.skipped_rows.length > 0 && (
                <div className="mt-3 text-xs text-amber-950/90">
                  <p className="font-medium">スキップした行（コード付き・先頭）</p>
                  <ul className="list-disc pl-5 mt-1 space-y-1 max-h-40 overflow-auto">
                    {salesResult.skipped_rows.slice(0, 15).map((s, idx) => (
                      <li key={idx}>
                        <span className="font-mono text-[10px] text-amber-900/80">{s.code}</span> 行 {s.line}: {s.message}
                        {s.amazon_order_id ? `（注文 ${s.amazon_order_id}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}
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
                {(result.duplicate_lines_merged ?? 0) > 0 ? (
                  <span className="text-emerald-800/90" title="同一注文ID・同一SKUの行を1行にまとめました（数量は合算）">
                    ファイル内の重複行を統合: {result.duplicate_lines_merged}件
                  </span>
                ) : null}
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
                {(result.duplicate_lines_merged ?? 0) > 0 ? (
                  <span title="同一注文ID・同一SKUの行を1行にまとめました">
                    ファイル内の重複行を統合: {result.duplicate_lines_merged}件
                  </span>
                ) : null}
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

