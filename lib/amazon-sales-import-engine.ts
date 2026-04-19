/**
 * Amazon トランザクション CSV（PapaParse 済み行）→ sales_transactions upsert 行の純粋変換。
 * DB 非依存。本番取込と preview で共有する。
 */
import { createHash } from "crypto";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";
import {
  formatAmountDescriptionForAmazonSalesDb,
  normalizeCsvFinancialTypesForSalesImport,
  normalizeTransactionType,
} from "@/lib/canonical-sales-transaction";
import { attachSalesTransactionIdempotency } from "@/lib/sales-transaction-idempotency";

export const MAX_ROWS_PER_REQUEST = 50;
const MAX_SKIPPED_ROWS_IN_RESPONSE = 100;

/** allowAdjustments=false のときの補填スキップ（skipped_rows / row_errors は行番号でユニーク化） */
export const ADJUSTMENT_CSV_SKIP_CODE = "ADJUSTMENT_CSV_SKIPPED";
export const ADJUSTMENT_CSV_SKIP_MESSAGE = "補填データのためスキップ";

export type AmazonSalesCsvUpsertRow = {
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  amazon_event_hash: string;
  item_quantity: number;
  finance_line_group_id: string | null;
  needs_quantity_review: boolean;
  dedupe_slot: number;
  idempotency_key: string;
};

type LogicalTxKind = "Principal" | "Tax" | "Commission" | "FBA Per Unit Fulfillment Fee" | "Other";

export type AmazonSalesImportCsvDetailRow = {
  amazon_order_id: string | null;
  posted_iso: string;
  settlement_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
};

type AmountColumnDef = { kind: LogicalTxKind; headerCandidates: string[] };

const AMOUNT_COLUMNS: AmountColumnDef[] = [
  {
    kind: "Principal",
    headerCandidates: [
      "商品売上",
      "product sales",
      "principal",
      "商品の売上",
      "product charges",
      "売上",
    ],
  },
  {
    kind: "Tax",
    headerCandidates: [
      "商品の売上税",
      "product sales tax",
      "tax",
      "売上税",
      "商品売上税",
    ],
  },
  {
    kind: "Commission",
    headerCandidates: [
      "Amazon手数料",
      "手数料",
      "amazon fees",
      "selling fees",
      "referral fee",
      "commission",
    ],
  },
  {
    kind: "FBA Per Unit Fulfillment Fee",
    headerCandidates: [
      "FBA 手数料",
      "FBA手数料",
      "fba fees",
      "fba fulfillment fee",
      "fba per unit fulfillment fee",
    ],
  },
  {
    kind: "Other",
    headerCandidates: [
      "その他トランザクション手数料",
      "その他のトランザクション手数料",
      "その他",
      "other transaction fees",
      "other fees",
      "miscellaneous",
    ],
  },
];

function normalizeHeaderKey(s: string): string {
  return s
    .normalize("NFKC")
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
    const exact = normalizedHeaders.find((h) => h.norm === cand);
    if (exact) return exact.actual;
    const includes = normalizedHeaders.find((h) => h.norm.includes(cand));
    if (includes) return includes.actual;
  }
  return null;
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

function signedForKind(_kind: LogicalTxKind, amount: number): number {
  return amount;
}

function logicalToAmountTypes(kind: LogicalTxKind): { amount_type: "Charge" | "Fee"; amount_description: string } {
  switch (kind) {
    case "Principal":
      return { amount_type: "Charge", amount_description: "Principal" };
    case "Tax":
      return { amount_type: "Charge", amount_description: "Tax" };
    case "Commission":
      return { amount_type: "Fee", amount_description: "Commission" };
    case "FBA Per Unit Fulfillment Fee":
      return { amount_type: "Fee", amount_description: "FBA Per Unit Fulfillment Fee" };
    case "Other":
    default:
      return { amount_type: "Fee", amount_description: "Other" };
  }
}

function hashMergedDetail(orderId: string, amountType: string, amountDescription: string): string {
  const raw = ["AmazonTxCsvV3", orderId.trim(), amountType, amountDescription].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function hashOrderEventDetail(opts: {
  orderId: string;
  transactionType: string;
  amountType: string;
  amountDescription: string;
  postedIso: string;
  settlementId: string | null;
}): string {
  const raw = [
    "AmazonTxCsvOrderEventV1",
    opts.orderId.trim(),
    opts.transactionType.trim(),
    opts.amountType.trim(),
    opts.amountDescription,
    opts.postedIso,
    opts.settlementId ? opts.settlementId.trim() : "",
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function hashStandaloneExpense(
  txType: string,
  amountType: string,
  postedIso: string,
  amount: number,
  seq: number,
  chunkIndex: number
): string {
  const raw = ["AmazonTxCsvExpenseV2", txType.trim(), amountType.trim(), postedIso, String(amount), String(seq), String(chunkIndex)].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export function coerceRowRecord(row: unknown): Record<string, string> | null {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.trim()) continue;
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

export function normalizeHeaderList(headers: unknown): string[] | null {
  if (!Array.isArray(headers)) return null;
  const out = headers.filter((h): h is string => typeof h === "string" && h.trim().length > 0);
  return out.length > 0 ? out : null;
}

/** チャンク内で取り込まなかった行（他行はそのまま upsert 対象） */
export type AmazonSalesCsvSkippedRow = {
  line: number;
  code: string;
  message: string;
  amazon_order_id?: string | null;
  /** 推定失敗時の参照用（長すぎる場合は切り詰め） */
  detail?: string;
};

function dedupeSkippedRowsByCsvLine(rows: AmazonSalesCsvSkippedRow[]): AmazonSalesCsvSkippedRow[] {
  const seen = new Set<number>();
  const out: AmazonSalesCsvSkippedRow[] = [];
  for (const row of rows) {
    if (seen.has(row.line)) continue;
    seen.add(row.line);
    out.push(row);
  }
  return out;
}

/** `行 N: ...` を元 CSV 行番号でユニーク化（先勝ち） */
function dedupeRowErrorsByCsvLine(errors: string[]): string[] {
  const seen = new Set<number>();
  const out: string[] = [];
  const re = /^行 (\d+):/;
  for (const err of errors) {
    const m = err.match(re);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || seen.has(n)) continue;
      seen.add(n);
    }
    out.push(err);
  }
  return out;
}

export type AmazonSalesImportRequestBody = {
  rows?: unknown;
  headers?: unknown;
  fileName?: unknown;
  batchMode?: unknown;
  chunkIndex?: unknown;
  totalChunks?: unknown;
  skippedPrefixLines?: unknown;
  rowOffsetBase?: unknown;
  /** true のときのみ正規化後 Adjustment を CSV から取り込む（デフォルトは未指定=false） */
  allowAdjustments?: unknown;
};

export type AmazonSalesCsvBuildOk = {
  ok: true;
  skipped_prefix_lines: number;
  row_offset_base: number;
  chunk_index: number | null;
  total_chunks: number | null;
  batch_mode: boolean;
  rows_read: number;
  rows_expanded: number;
  rows_after_merge: number;
  merged_split_payment_orders: number;
  merged_split_payment_extra_rows: number;
  merge_message: string;
  row_errors: string[];
  /** 行単位スキップ（未知パターン・パース不能・金額列なし等）。最大 MAX_SKIPPED_ROWS_IN_RESPONSE 件 */
  skipped_rows: AmazonSalesCsvSkippedRow[];
  insert_payload: AmazonSalesCsvUpsertRow[];
};

export type AmazonSalesCsvBuildErr = { ok: false; status: number; error: string };

export type AmazonSalesCsvBuildResult = AmazonSalesCsvBuildOk | AmazonSalesCsvBuildErr;

/**
 * 同一ビジネス指紋（注文・秒単位日時・金額・説明・取引種別）に複数の idempotency_key が付くチャンク内行を検出。
 * SKU や dedupe_slot の差でキーが分岐した疑いがあるときのヒント用。
 */
export function findSuspiciousBusinessKeyCollisions(rows: AmazonSalesCsvUpsertRow[]): Array<{
  business_fingerprint: string;
  idempotency_keys: string[];
  skus: (string | null)[];
}> {
  const byFp = new Map<string, { keys: Set<string>; skus: Set<string | null> }>();
  const postedNorm = (iso: string) => {
    const t = String(iso ?? "").trim();
    return t.length >= 19 ? t.slice(0, 19) : t;
  };
  for (const r of rows) {
    const fp = [
      (r.amazon_order_id ?? "").trim(),
      postedNorm(r.posted_date),
      (Math.round(Number(r.amount) * 100) / 100).toFixed(2),
      (r.amount_description ?? "").trim(),
      String(r.transaction_type ?? "").trim(),
    ].join("\u0002");
    if (!byFp.has(fp)) byFp.set(fp, { keys: new Set(), skus: new Set() });
    const g = byFp.get(fp)!;
    g.keys.add(r.idempotency_key);
    g.skus.add(r.sku);
  }
  const out: Array<{ business_fingerprint: string; idempotency_keys: string[]; skus: (string | null)[] }> = [];
  for (const [fp, g] of byFp) {
    if (g.keys.size <= 1) continue;
    out.push({
      business_fingerprint: fp,
      idempotency_keys: [...g.keys],
      skus: [...g.skus],
    });
  }
  return out;
}

export function buildAmazonSalesCsvImportFromBody(body: AmazonSalesImportRequestBody): AmazonSalesCsvBuildResult {
  const batchMode = body.batchMode === true;
  const chunkIndex = typeof body.chunkIndex === "number" && Number.isFinite(body.chunkIndex) ? body.chunkIndex : null;
  const totalChunks = typeof body.totalChunks === "number" && Number.isFinite(body.totalChunks) ? body.totalChunks : null;
  const skippedPrefixLines =
    typeof body.skippedPrefixLines === "number" && Number.isFinite(body.skippedPrefixLines) && body.skippedPrefixLines >= 0
      ? Math.floor(body.skippedPrefixLines)
      : 0;
  const rowOffsetBase =
    typeof body.rowOffsetBase === "number" && Number.isFinite(body.rowOffsetBase) && body.rowOffsetBase >= 0
      ? Math.floor(body.rowOffsetBase)
      : 0;
  const allowAdjustments = body.allowAdjustments === true;

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `rows に1〜${MAX_ROWS_PER_REQUEST}件のオブジェクト配列を渡してください（ブラウザでパース済みの行）。`,
    };
  }
  if (body.rows.length > MAX_ROWS_PER_REQUEST) {
    return {
      ok: false,
      status: 400,
      error: `1リクエストあたり最大 ${MAX_ROWS_PER_REQUEST} 行までです（現在 ${body.rows.length} 行）。`,
    };
  }

  const rowsArr = body.rows as unknown[];
  type RowPacket = { r: Record<string, string>; sourceIdx: number };
  const rowPackets: RowPacket[] = [];
  const skipped_rows: AmazonSalesCsvSkippedRow[] = [];
  const rowErrors: string[] = [];
  const pushSkip = (line: number, code: string, message: string, amazon_order_id?: string | null, detail?: string) => {
    if (skipped_rows.length < MAX_SKIPPED_ROWS_IN_RESPONSE) {
      skipped_rows.push({
        line,
        code,
        message,
        amazon_order_id: amazon_order_id ?? undefined,
        detail: detail?.slice(0, 400),
      });
    }
    rowErrors.push(`行 ${line}: ${message}`);
  };

  for (let si = 0; si < rowsArr.length; si++) {
    const coerced = coerceRowRecord(rowsArr[si]);
    if (!coerced) {
      const lineNo = rowOffsetBase + si + 2 + skippedPrefixLines;
      pushSkip(lineNo, "INVALID_ROW_OBJECT", "行オブジェクトがオブジェクトではないか、列がありません。", null);
      continue;
    }
    rowPackets.push({ r: coerced, sourceIdx: si });
  }
  if (rowPackets.length === 0) {
    return { ok: false, status: 400, error: "rows に有効な行オブジェクトがありません。" };
  }

  const headerListFromBody = normalizeHeaderList(body.headers);
  const headerKeysFromRows = rowPackets.length > 0 ? Object.keys(rowPackets[0].r) : [];
  const headers =
    headerListFromBody ?? headerKeysFromRows.filter((h) => typeof h === "string" && h.trim().length > 0);
  if (headers.length === 0) {
    return { ok: false, status: 400, error: "headers（列名配列）が空です。PapaParse の meta.fields を渡してください。" };
  }

  const hDate = pickHeaderKey(headers, [
    "日付/時刻",
    "日付／時刻",
    "日付",
    "date",
    "posted date",
    "posteddate",
    "transaction date",
    "posting date",
    "settlement date",
    "date/time",
    "決済日",
    "トランザクション日付",
  ]);
  const hOrder = pickHeaderKey(headers, [
    "オーダー番号",
    "注文番号",
    "order id",
    "orderid",
    "amazon order id",
    "amazon-order-id",
    "amazonorderid",
    "注文id",
  ]);
  const hType = pickHeaderKey(headers, [
    "トランザクションの種類",
    "type",
    "transaction type",
    "transactiontype",
    "種類",
    "トランザクションタイプ",
    "タイプ",
  ]);
  const hSku = pickHeaderKey(headers, ["sku", "seller-sku", "sellersku", "SKU", "出品者sku", "商品sku"]);
  const hSettlement = pickHeaderKey(headers, [
    "決済番号",
    "settlement id",
    "settlementid",
    "transaction id",
    "transactionid",
    "決済id",
  ]);
  const hDescription = pickHeaderKey(headers, [
    "説明",
    "description",
    "詳細",
    "メモ",
    "memo",
    "product details",
    "transaction description",
    "内訳説明",
  ]);

  const amountHeaderByKind = new Map<LogicalTxKind, string>();
  for (const col of AMOUNT_COLUMNS) {
    const key = pickHeaderKey(headers, col.headerCandidates);
    if (key) amountHeaderByKind.set(col.kind, key);
  }

  const hTotalFallback = pickHeaderKey(headers, ["total", "amount", "合計", "合計金額", "金額", "total amount"]);

  if (!hDate || !hOrder) {
    return {
      ok: false,
      status: 400,
      error:
        "必須列が見つかりません。日付（日付/時刻・日付・posted date 等）とオーダー番号（オーダー番号・order id 等）が必要です。",
    };
  }

  if (amountHeaderByKind.size === 0 && !hTotalFallback) {
    return {
      ok: false,
      status: 400,
      error:
        "金額列が1つも見つかりません。商品売上・商品の売上税・Amazon手数料・FBA 手数料・その他トランザクション手数料等の列が必要です。",
    };
  }

  const expanded: AmazonSalesImportCsvDetailRow[] = [];

  for (let i = 0; i < rowPackets.length; i++) {
    const { r, sourceIdx } = rowPackets[i];
    const orderId = toTrimmedString(r[hOrder]);
    const dateRaw = toTrimmedString(r[hDate]);
    const typeRaw = hType ? toTrimmedString(r[hType]) : "";
    const settlementIdRaw = hSettlement ? toTrimmedString(r[hSettlement]) : "";
    const settlementId = settlementIdRaw ? settlementIdRaw : null;

    const lineNo = rowOffsetBase + sourceIdx + 2 + skippedPrefixLines;

    if (!dateRaw) {
      pushSkip(lineNo, "DATE_EMPTY", `日付が空です（注文 ${orderId}）。`, orderId || null);
      continue;
    }

    const postedIso =
      parseFlexiblePostedDateToIso(dateRaw) ??
      (Date.parse(dateRaw) ? new Date(Date.parse(dateRaw)).toISOString() : null);
    if (!postedIso) {
      pushSkip(lineNo, "DATE_UNPARSEABLE", `日付を解釈できません（${dateRaw}）。`, orderId || null, dateRaw);
      continue;
    }

    const skuRaw = hSku ? toTrimmedString(r[hSku]) : "";
    const sku = skuRaw ? skuRaw : null;
    const descRaw = hDescription ? toTrimmedString(r[hDescription]) : "";

    if (!orderId) {
      if (!hTotalFallback) {
        pushSkip(
          lineNo,
          "NO_TOTAL_FOR_EMPTY_ORDER",
          "オーダー番号が空で、かつ金額列（total等）も見つかりません。",
          null
        );
        continue;
      }
      const rawCell = toTrimmedString(r[hTotalFallback]);
      const num = rawCell ? parseMoneyToNumber(rawCell) : null;
      if (num == null) {
        pushSkip(lineNo, "BAD_TOTAL_MONEY", "オーダー番号が空ですが、金額が空/不正です。", null);
        continue;
      }
      if (num === 0) continue;
      const tt = normalizeTransactionType(typeRaw || "Adjustment");
      const norm = normalizeCsvFinancialTypesForSalesImport({
        amazon_order_id: null,
        rawTransactionType: typeRaw || "Adjustment",
        amountType: tt,
        amountDescription: "",
        descriptionColumn: descRaw,
      });
      if (!allowAdjustments && norm.transaction_type === "Adjustment") {
        pushSkip(lineNo, ADJUSTMENT_CSV_SKIP_CODE, ADJUSTMENT_CSV_SKIP_MESSAGE, null);
        continue;
      }
      expanded.push({
        amazon_order_id: null,
        posted_iso: postedIso,
        settlement_id: settlementId,
        sku,
        transaction_type: norm.transaction_type,
        amount_type: norm.amount_type,
        amount_description: norm.amount_description,
        amount: Math.round(num * 100) / 100,
      });
      continue;
    }

    let producedForRow = false;
    for (const [kind, headerName] of amountHeaderByKind) {
      const rawCell = toTrimmedString(r[headerName]);
      if (!rawCell) continue;
      const num = parseMoneyToNumber(rawCell);
      if (num == null) {
        pushSkip(
          lineNo,
          "BAD_CELL_MONEY",
          `金額が数値として解釈できません（${orderId} / ${headerName}）。`,
          orderId,
          headerName
        );
        continue;
      }
      if (num === 0) continue;

      const signed = signedForKind(kind, num);
      const { amount_type, amount_description } = logicalToAmountTypes(kind);
      const norm = normalizeCsvFinancialTypesForSalesImport({
        amazon_order_id: orderId,
        rawTransactionType: typeRaw,
        amountType: amount_type,
        amountDescription: amount_description,
        descriptionColumn: descRaw,
      });

      if (!allowAdjustments && norm.transaction_type === "Adjustment") {
        pushSkip(lineNo, ADJUSTMENT_CSV_SKIP_CODE, ADJUSTMENT_CSV_SKIP_MESSAGE, orderId);
        continue;
      }

      if (
        allowAdjustments &&
        orderId &&
        norm.transaction_type === "Adjustment" &&
        norm.amount_type === "Adjustment" &&
        norm.amount_description == null
      ) {
        const hay = [typeRaw, amount_type, amount_description, descRaw].filter(Boolean).join(" | ");
        pushSkip(
          lineNo,
          "UNKNOWN_FINANCIAL_PATTERN",
          "取引種別・説明から手数料コードを特定できずスキップしました（他の金額列は取り込みます）。",
          orderId,
          hay
        );
        continue;
      }

      expanded.push({
        amazon_order_id: orderId,
        posted_iso: postedIso,
        settlement_id: settlementId,
        sku,
        transaction_type: norm.transaction_type,
        amount_type: norm.amount_type,
        amount_description: norm.amount_description ?? amount_description,
        amount: signed,
      });
      producedForRow = true;
    }

    if (orderId && !producedForRow) {
      pushSkip(
        lineNo,
        "NO_EXTRACTABLE_AMOUNTS",
        "注文番号はあるが、対象の金額列がすべて空または 0 でした。",
        orderId
      );
    }
  }

  if (!expanded.length) {
    return {
      ok: true,
      skipped_prefix_lines: skippedPrefixLines,
      row_offset_base: rowOffsetBase,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      batch_mode: batchMode,
      rows_read: rowsArr.length,
      rows_expanded: 0,
      rows_after_merge: 0,
      merged_split_payment_orders: 0,
      merged_split_payment_extra_rows: 0,
      merge_message: "取り込む有効行がありません（注文種別の行に金額が無い、または列が空です）。",
      row_errors: dedupeRowErrorsByCsvLine(rowErrors).slice(0, 50),
      skipped_rows: dedupeSkippedRowsByCsvLine(skipped_rows),
      insert_payload: [],
    };
  }

  type MergeKey = string;
  const mergeMap = new Map<
    MergeKey,
    {
      amount: number;
      posted_iso: string;
      settlement_id: string | null;
      sku: string | null;
      amount_type: string;
      amount_description: string | null;
    }
  >();

  const mergeKeyOf = (d: AmazonSalesImportCsvDetailRow): MergeKey => {
    const base = [d.amazon_order_id ?? "", d.transaction_type, d.amount_type, d.amount_description ?? ""];
    if (d.transaction_type !== "Order") base.push(d.posted_iso);
    return base.join("\u0001");
  };

  let mergeExtraRows = 0;
  const ordersThatMerged = new Set<string>();
  for (const d of expanded) {
    const k = mergeKeyOf(d);
    const cur = mergeMap.get(k);
    if (!cur) {
      mergeMap.set(k, {
        amount: d.amount,
        posted_iso: d.posted_iso,
        settlement_id: d.settlement_id,
        sku: d.sku,
        amount_type: d.amount_type,
        amount_description: d.amount_description,
      });
    } else {
      cur.amount += d.amount;
      if (Date.parse(d.posted_iso) < Date.parse(cur.posted_iso)) {
        cur.posted_iso = d.posted_iso;
      }
      if (!cur.settlement_id && d.settlement_id) cur.settlement_id = d.settlement_id;
      if (!cur.sku && d.sku) cur.sku = d.sku;
      mergeExtraRows += 1;
      if (d.amazon_order_id) ordersThatMerged.add(d.amazon_order_id.trim());
    }
  }

  const mergedSplitPaymentOrders = ordersThatMerged.size;
  const mergedSplitPaymentExtraRows = mergeExtraRows;

  const chunkIdxSafe = chunkIndex ?? 0;
  let expenseSeq = 0;
  const insertPayloadRaw: Omit<AmazonSalesCsvUpsertRow, "idempotency_key">[] = [...mergeMap.entries()].map(([key, v]) => {
    const parts = key.split("\u0001");
    const orderId = parts[0] ?? "";
    const txType = parts[1] ?? "Order";
    const amountType = parts[2] ?? v.amount_type;
    const amountDesc = parts[3] ?? v.amount_description;
    const postedIsoFromKey = txType !== "Order" ? (parts[4] ?? v.posted_iso) : v.posted_iso;
    if (!orderId || txType !== "Order") expenseSeq += 1;
    const amount_description = formatAmountDescriptionForAmazonSalesDb(txType, v.amount_type, v.amount_description);
    return {
      amazon_order_id: orderId || null,
      sku: v.sku,
      transaction_type: txType,
      amount_type: v.amount_type,
      amount_description,
      amount: Math.round(v.amount * 100) / 100,
      posted_date: postedIsoFromKey,
      amazon_event_hash:
        orderId
          ? txType === "Order"
            ? hashMergedDetail(orderId, v.amount_type, v.amount_description ?? "")
            : hashOrderEventDetail({
                orderId,
                transactionType: txType,
                amountType: amountType,
                amountDescription: amountDesc ?? "",
                postedIso: postedIsoFromKey,
                settlementId: v.settlement_id,
              })
          : hashStandaloneExpense(txType, v.amount_type, postedIsoFromKey, v.amount, expenseSeq, chunkIdxSafe),
      item_quantity: 1,
      finance_line_group_id: null,
      needs_quantity_review: false,
      dedupe_slot: 0,
    };
  });

  const insert_payload = insertPayloadRaw.map((r) => attachSalesTransactionIdempotency(r));

  const mergeMessage =
    mergedSplitPaymentExtraRows > 0
      ? `${mergedSplitPaymentExtraRows}件の明細をマージしました（分割発送等・${mergedSplitPaymentOrders}注文）。内訳は order_id × 種別ごとに合算済みです。`
      : "分割発送による明細マージはありませんでした。";

  return {
    ok: true,
    skipped_prefix_lines: skippedPrefixLines,
    row_offset_base: rowOffsetBase,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
    batch_mode: batchMode,
    rows_read: rowsArr.length,
    rows_expanded: expanded.length,
    rows_after_merge: insert_payload.length,
    merged_split_payment_orders: mergedSplitPaymentOrders,
    merged_split_payment_extra_rows: mergedSplitPaymentExtraRows,
    merge_message: mergeMessage,
    row_errors: dedupeRowErrorsByCsvLine(rowErrors).slice(0, 50),
    skipped_rows: dedupeSkippedRowsByCsvLine(skipped_rows),
    insert_payload,
  };
}
