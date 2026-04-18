/**
 * Amazon 日付範囲別レポートのトランザクション CSV/TSV を sales_transactions に取り込む。
 * - フロントで PapaParse 済みの行オブジェクトを最大50件ずつ JSON POST する（タイムアウト回避）
 * - 1 CSV 行を金額列ごとに縦持ち（Finances API 相当: transaction_type=Order, amount_type=Charge/Fee）
 * - 同一 order_id × 内訳種別で分割発送行をマージ
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";

/** Vercel Hobby の上限。Pro では 300 などに変更可能 */
export const maxDuration = 60;

const UPSERT_CHUNK = 200;

type SalesTxUpsertRow = {
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string;
  amount: number;
  posted_date: string;
  amazon_event_hash: string;
  item_quantity: number;
  finance_line_group_id: string | null;
  needs_quantity_review: boolean;
};

/** 論理内訳（レスポンス・マージキー）。DB では amount_description に載せる */
type LogicalTxKind = "Principal" | "Tax" | "Commission" | "FBA Per Unit Fulfillment Fee" | "Other";

type DetailRow = {
  amazon_order_id: string | null;
  posted_iso: string;
  settlement_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string;
  amount: number;
};

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

/** 手数料符号などの正規化を行わず、CSV の符号をそのまま信用します */
function signedForKind(kind: LogicalTxKind, amount: number): number {
  // 重要: CSV の符号をそのまま信用する（Refund/手数料等も Math.abs で強制しない）
  return amount;
}

function normalizeTransactionType(rawType: string): "Order" | "Refund" | string {
  const t = rawType.normalize("NFKC").trim();
  if (!t) return "Order";
  const lower = t.toLowerCase();
  // Refund / 返金
  if (lower === "refund" || lower.includes("refund") || t === "返金" || t.includes("返金")) return "Refund";
  // Order / 注文
  if (lower === "order" || lower.includes("order") || t === "注文" || t.includes("注文")) return "Order";
  return t;
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

/** 同一注文・同一内訳で再インポートしても上書きできる安定ハッシュ */
function hashMergedDetail(orderId: string, amountType: string, amountDescription: string): string {
  const raw = ["AmazonTxCsvV3", orderId.trim(), amountType, amountDescription].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

/** 注文番号ありのイベント（Refund/調整など）も再インポートで重複しないよう安定ハッシュ化（posted_date/決済番号まで含める） */
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

/** チャンク分割時に seq が各チャンクでリセットされるため chunkIndex を含める */
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

const MAX_ROWS_PER_REQUEST = 50;

function coerceRowRecord(row: unknown): Record<string, string> | null {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.trim()) continue;
    out[k] = v == null ? "" : String(v);
  }
  return out;
}

function normalizeHeaderList(headers: unknown): string[] | null {
  if (!Array.isArray(headers)) return null;
  const out = headers.filter((h): h is string => typeof h === "string" && h.trim().length > 0);
  return out.length > 0 ? out : null;
}

/**
 * 分割送信（batchMode）の 2 本目以降: 同一 amazon_event_hash が既に DB にある場合は金額を加算（分割発送がチャンクをまたぐ場合）。
 * chunkIndex 0（または batchMode でない通常送信）は upsert のみ＝衝突時は上書き（全件1回の再インポート向け）。
 */
async function mergeUpsertChunkWithExisting(
  chunk: SalesTxUpsertRow[],
  batchMode: boolean,
  chunkIndex: number | null
): Promise<SalesTxUpsertRow[]> {
  if (!batchMode || chunk.length === 0) return chunk;
  if (chunkIndex == null || chunkIndex === 0) return chunk;
  const hashes = [...new Set(chunk.map((r) => r.amazon_event_hash).filter(Boolean))];
  if (hashes.length === 0) return chunk;

  const { data: existingRows, error } = await supabase
    .from("sales_transactions")
    .select("amazon_event_hash, amount, posted_date, sku")
    .in("amazon_event_hash", hashes);

  if (error) throw error;

  const byHash = new Map((existingRows ?? []).map((e) => [e.amazon_event_hash as string, e]));

  return chunk.map((row) => {
    const h = row.amazon_event_hash;
    const ex = h ? byHash.get(h) : undefined;
    if (!ex) return row;
    const exAmt = Number(ex.amount);
    const newAmt = Number(row.amount);
    const exMs = Date.parse(String(ex.posted_date));
    const rowMs = Date.parse(String(row.posted_date));
    const usePosted = Number.isFinite(exMs) && Number.isFinite(rowMs) && exMs <= rowMs ? ex.posted_date : row.posted_date;
    return {
      ...row,
      amount: Math.round((exAmt + newAmt) * 100) / 100,
      posted_date: usePosted as string,
      sku: row.sku ?? (ex.sku as string | null),
    };
  });
}

type AmountColumnDef = {
  kind: LogicalTxKind;
  headerCandidates: string[];
};

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

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      rows?: unknown;
      headers?: unknown;
      fileName?: unknown;
      batchMode?: unknown;
      chunkIndex?: unknown;
      totalChunks?: unknown;
      skippedPrefixLines?: unknown;
      rowOffsetBase?: unknown;
    };

    const fileName = typeof body.fileName === "string" ? body.fileName : "upload.csv";
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

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return NextResponse.json(
        { error: `rows に1〜${MAX_ROWS_PER_REQUEST}件のオブジェクト配列を渡してください（ブラウザでパース済みの行）。` },
        { status: 400 }
      );
    }
    if (body.rows.length > MAX_ROWS_PER_REQUEST) {
      return NextResponse.json(
        { error: `1リクエストあたり最大 ${MAX_ROWS_PER_REQUEST} 行までです（現在 ${body.rows.length} 行）。` },
        { status: 400 }
      );
    }

    const data: Record<string, string>[] = [];
    for (const rawRow of body.rows) {
      const coerced = coerceRowRecord(rawRow);
      if (coerced) data.push(coerced);
    }
    if (data.length === 0) {
      return NextResponse.json({ error: "rows に有効な行オブジェクトがありません。" }, { status: 400 });
    }

    const headerListFromBody = normalizeHeaderList(body.headers);
    const headerKeysFromRows = data.length > 0 ? Object.keys(data[0]) : [];
    const headers =
      headerListFromBody ??
      headerKeysFromRows.filter((h) => typeof h === "string" && h.trim().length > 0);
    if (headers.length === 0) {
      return NextResponse.json({ error: "headers（列名配列）が空です。PapaParse の meta.fields を渡してください。" }, { status: 400 });
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

    const amountHeaderByKind = new Map<LogicalTxKind, string>();
    for (const col of AMOUNT_COLUMNS) {
      const key = pickHeaderKey(headers, col.headerCandidates);
      if (key) amountHeaderByKind.set(col.kind, key);
    }

    // オーダー番号が空の行（送金/調整/経費など）の取り込み用。レポートによっては金額列が total しか無いケースがある。
    const hTotalFallback = pickHeaderKey(headers, ["total", "amount", "合計", "合計金額", "金額", "total amount"]);

    if (!hDate || !hOrder) {
      return NextResponse.json(
        {
          error:
            "必須列が見つかりません。日付（日付/時刻・日付・posted date 等）とオーダー番号（オーダー番号・order id 等）が必要です。",
        },
        { status: 400 }
      );
    }

    if (amountHeaderByKind.size === 0 && !hTotalFallback) {
      return NextResponse.json(
        {
          error:
            "金額列が1つも見つかりません。商品売上・商品の売上税・Amazon手数料・FBA 手数料・その他トランザクション手数料等の列が必要です。",
        },
        { status: 400 }
      );
    }

    const rowErrors: string[] = [];
    const expanded: DetailRow[] = [];

    for (let i = 0; i < data.length; i++) {
      const r = data[i];

      const orderId = toTrimmedString(r[hOrder]);
      const dateRaw = toTrimmedString(r[hDate]);
      const typeRaw = hType ? toTrimmedString(r[hType]) : "";
      const settlementIdRaw = hSettlement ? toTrimmedString(r[hSettlement]) : "";
      const settlementId = settlementIdRaw ? settlementIdRaw : null;

      const lineNo = rowOffsetBase + i + 2 + skippedPrefixLines;

      if (!dateRaw) {
        rowErrors.push(`行 ${lineNo}: 日付が空です（注文 ${orderId}）。`);
        continue;
      }

      const postedIso =
        parseFlexiblePostedDateToIso(dateRaw) ??
        (Date.parse(dateRaw) ? new Date(Date.parse(dateRaw)).toISOString() : null);
      if (!postedIso) {
        rowErrors.push(`行 ${lineNo}: 日付を解釈できません（${dateRaw}）。`);
        continue;
      }

      const skuRaw = hSku ? toTrimmedString(r[hSku]) : "";
      const sku = skuRaw ? skuRaw : null;

      if (!orderId) {
        // オーダー番号が空でも取り込みは許可（集計用）。
        // ただし金額が取れないと意味がないので total/amount にフォールバックする。
        if (!hTotalFallback) {
          rowErrors.push(`行 ${lineNo}: オーダー番号が空で、かつ金額列（total等）も見つかりません。`);
          continue;
        }
        const rawCell = toTrimmedString(r[hTotalFallback]);
        const num = rawCell ? parseMoneyToNumber(rawCell) : null;
        if (num == null) {
          rowErrors.push(`行 ${lineNo}: オーダー番号が空ですが、金額が空/不正です。`);
          continue;
        }
        if (num === 0) continue;
        const tt = normalizeTransactionType(typeRaw || "Adjustment");
        expanded.push({
          amazon_order_id: null,
          posted_iso: postedIso,
          settlement_id: settlementId,
          sku,
          transaction_type: tt,
          amount_type: tt, // 文字列仕分け（PostageBilling/ServiceFee/adj_ 等）に使う
          amount_description: `Transaction report CSV — ${tt}`,
          amount: Math.round(num * 100) / 100,
        });
        continue;
      }

      for (const [kind, headerName] of amountHeaderByKind) {
        const rawCell = toTrimmedString(r[headerName]);
        if (!rawCell) continue;
        const num = parseMoneyToNumber(rawCell);
        if (num == null) {
          rowErrors.push(`行 ${lineNo}: 金額が数値として解釈できません（${orderId} / ${headerName}）。`);
          continue;
        }
        if (num === 0) continue;

        const signed = signedForKind(kind, num); // 現在は identity（CSV 符号をそのまま）
        const { amount_type, amount_description } = logicalToAmountTypes(kind);

        expanded.push({
          amazon_order_id: orderId,
          posted_iso: postedIso,
          settlement_id: settlementId,
          sku,
          transaction_type: normalizeTransactionType(typeRaw || "Order"),
          amount_type,
          amount_description,
          amount: signed,
        });
      }
    }

    if (!expanded.length) {
      return NextResponse.json({
        ok: true,
        skipped_prefix_lines: skippedPrefixLines,
        rows_read: data.length,
        rows_expanded: 0,
        rows_after_merge: 0,
        merged_split_payment_orders: 0,
        merged_split_payment_extra_rows: 0,
        message: "取り込む有効行がありません（注文種別の行に金額が無い、または列が空です）。",
        upserted: 0,
        row_errors: rowErrors.slice(0, 50),
      });
    }

    /** order_id × transaction_type(内訳は amount_description) × amount_type でマージ */
    type MergeKey = string;
    const mergeMap = new Map<
      MergeKey,
      { amount: number; posted_iso: string; settlement_id: string | null; sku: string | null; amount_type: string; amount_description: string }
    >();

    const mergeKeyOf = (d: DetailRow): MergeKey => {
      const base = [d.amazon_order_id ?? "", d.transaction_type, d.amount_type, d.amount_description];
      // 重要: Refund 等は「同一注文・同一内訳でも別日時で複数回あり得る」ため、posted_date で分離する
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
    const insertPayload: SalesTxUpsertRow[] = [...mergeMap.entries()].map(([key, v]) => {
      const parts = key.split("\u0001");
      const orderId = parts[0] ?? "";
      const txType = parts[1] ?? "Order";
      const amountType = parts[2] ?? v.amount_type;
      const amountDesc = parts[3] ?? v.amount_description;
      // non-Order の場合は mergeKey に posted_iso が入る（分離用）
      const postedIsoFromKey = txType !== "Order" ? (parts[4] ?? v.posted_iso) : v.posted_iso;
      if (!orderId || txType !== "Order") expenseSeq += 1;
      return {
        amazon_order_id: orderId || null,
        sku: v.sku,
        transaction_type: txType,
        amount_type: v.amount_type,
        amount_description: `Transaction report CSV — ${v.amount_description}`,
        amount: Math.round(v.amount * 100) / 100,
        posted_date: postedIsoFromKey,
        amazon_event_hash:
          orderId
            ? txType === "Order"
              ? hashMergedDetail(orderId, v.amount_type, v.amount_description)
              : hashOrderEventDetail({
                  orderId,
                  transactionType: txType,
                  amountType: amountType,
                  amountDescription: amountDesc,
                  postedIso: postedIsoFromKey,
                  settlementId: v.settlement_id,
                })
            : hashStandaloneExpense(txType, v.amount_type, postedIsoFromKey, v.amount, expenseSeq, chunkIdxSafe),
        item_quantity: 1,
        finance_line_group_id: null,
        needs_quantity_review: false,
      };
    });

    console.log(
      `[amazon-sales-import] chunk=${chunkIdxSafe}/${totalChunks ?? 1} skipped_prefix=${skippedPrefixLines} csv_rows=${data.length} expanded=${expanded.length} merged_out=${insertPayload.length} merged_orders=${mergedSplitPaymentOrders} merged_extra=${mergedSplitPaymentExtraRows}`
    );

    let upserted = 0;
    for (let i = 0; i < insertPayload.length; i += UPSERT_CHUNK) {
      const chunk = insertPayload.slice(i, i + UPSERT_CHUNK);
      const toUpsert = await mergeUpsertChunkWithExisting(chunk, batchMode, chunkIndex);
      // amazon_event_hash 一意のため、再インポート時の上書き・分割チャンク間の合算に upsert を使用
      const { data: upData, error: upErr } = await supabase
        .from("sales_transactions")
        .upsert(toUpsert, { onConflict: "amazon_event_hash" })
        .select("id");

      if (upErr) {
        if (upErr.code === "42P01") {
          return NextResponse.json(
            {
              error:
                "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。",
            },
            { status: 500 }
          );
        }
        throw upErr;
      }
      upserted += Array.isArray(upData) ? upData.length : 0;
    }

    const mergeMessage =
      mergedSplitPaymentExtraRows > 0
        ? `${mergedSplitPaymentExtraRows}件の明細をマージしました（分割発送等・${mergedSplitPaymentOrders}注文）。内訳は order_id × 種別ごとに合算済みです。`
        : "分割発送による明細マージはありませんでした。";

    return NextResponse.json({
      ok: true,
      skipped_prefix_lines: skippedPrefixLines,
      rows_read: data.length,
      rows_expanded: expanded.length,
      rows_after_merge: insertPayload.length,
      merged_split_payment_orders: mergedSplitPaymentOrders,
      merged_split_payment_extra_rows: mergedSplitPaymentExtraRows,
      message: mergeMessage,
      upserted,
      row_errors: rowErrors.slice(0, 50),
      batch_mode: batchMode,
      batch_chunk_index: chunkIndex,
      batch_total_chunks: totalChunks,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "売上データのインポートに失敗しました。";
    console.error("[amazon-sales-import]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
