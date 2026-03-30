/**
 * Amazon 日付範囲別レポートのトランザクション CSV/TSV を sales_transactions に取り込む。
 * - 先頭のタイトル行をスキップしてからパース
 * - 1 CSV 行を金額列ごとに縦持ち（Finances API 相当: transaction_type=Order, amount_type=Charge/Fee）
 * - 同一 order_id × 内訳種別で分割発送行をマージ
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import Papa from "papaparse";
import { supabase } from "@/lib/supabase";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";

const UPSERT_CHUNK = 200;

/** 論理内訳（レスポンス・マージキー）。DB では amount_description に載せる */
type LogicalTxKind = "Principal" | "Tax" | "Commission" | "FBA Per Unit Fulfillment Fee" | "Other";

type DetailRow = {
  amazon_order_id: string;
  posted_iso: string;
  sku: string | null;
  transaction_type: "Order";
  amount_type: "Charge" | "Fee";
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

/** 先頭の説明行・空行を除き、実ヘッダー行から始まるテキストを返す（見つからなければ全文を返す） */
function sliceFromTransactionHeader(csvText: string): { body: string; skippedPrefixLines: number } {
  const bomStripped = csvText.replace(/^\uFEFF/, "");
  const lines = bomStripped.split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) {
    const line = lines[start];
    if (!line || !line.trim()) continue;
    if (lineLooksLikeTransactionHeader(line)) {
      return { body: lines.slice(start).join("\n"), skippedPrefixLines: start };
    }
  }
  return { body: bomStripped.trim(), skippedPrefixLines: 0 };
}

function lineLooksLikeTransactionHeader(line: string): boolean {
  const t = line.replace(/^\uFEFF/, "").trim();
  if (t.length < 8) return false;
  const n = t.normalize("NFKC");
  const hasOrder =
    /オーダー番号|注文番号|order[\s_-]*id|amazon[\s_-]*order[\s_-]*id|amazon-order-id/i.test(n) ||
    /"order\s*id"/i.test(n);
  const hasDate =
    /日付[\/／]時刻|(?<![\w])日付(?![\w])|posted\s*date|posting\s*date|transaction\s*date|date[\/／]time/i.test(
      n
    );
  return hasOrder && hasDate;
}

function isOrderKindRowType(raw: string): boolean {
  const t = raw.normalize("NFKC").trim().toLowerCase();
  if (!t) return false;
  if (/refund|返金|返品|chargeback|チャージバック/.test(t)) return false;
  if (
    /\border\b/.test(t) ||
    t.includes("注文") ||
    t.includes("shipment") ||
    t.includes("配送") ||
    t.includes("sale") ||
    t.includes("発送")
  ) {
    return true;
  }
  return false;
}

/** 手数料は負数で統一（Finances API と同様） */
function signedForKind(kind: LogicalTxKind, amount: number): number {
  if (kind === "Principal" || kind === "Tax") return amount;
  const a = Math.abs(amount);
  return -a;
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
      "other transaction fees",
      "other fees",
      "miscellaneous",
    ],
  },
];

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { csvText?: unknown; fileName?: unknown };
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    const fileName = typeof body.fileName === "string" ? body.fileName : "upload.csv";

    if (!csvText.trim()) {
      return NextResponse.json({ error: "csvText にファイル内容を渡してください。" }, { status: 400 });
    }

    const { body: slicedText, skippedPrefixLines } = sliceFromTransactionHeader(csvText);

    const firstNonEmptyLine =
      slicedText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";

    if (!firstNonEmptyLine) {
      return NextResponse.json({ error: "ヘッダー行が見つかりません（日付・オーダー番号を含む行がありません）。" }, { status: 400 });
    }

    const delimiter = guessDelimiter(fileName, firstNonEmptyLine);

    const parsed = Papa.parse<Record<string, string>>(slicedText, {
      header: true,
      delimiter: delimiter === "\t" ? "\t" : ",",
      skipEmptyLines: "greedy",
    });

    if (parsed.errors?.length) {
      const critical = parsed.errors.filter((e) => e.type === "FieldMismatch" || e.type === "Quotes");
      if (critical.length) {
        const msg = critical.map((e) => e.message).join("; ");
        return NextResponse.json(
          {
            error: `CSV パースエラー: ${msg}`,
            hint: skippedPrefixLines > 0 ? `先頭 ${skippedPrefixLines} 行をスキップ済みです。` : undefined,
          },
          { status: 400 }
        );
      }
    }

    const headers = (parsed.meta.fields ?? []).filter((h): h is string => typeof h === "string" && h.trim().length > 0);

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

    const amountHeaderByKind = new Map<LogicalTxKind, string>();
    for (const col of AMOUNT_COLUMNS) {
      const key = pickHeaderKey(headers, col.headerCandidates);
      if (key) amountHeaderByKind.set(col.kind, key);
    }

    if (!hDate || !hOrder) {
      return NextResponse.json(
        {
          error:
            "必須列が見つかりません。日付（日付/時刻・日付・posted date 等）とオーダー番号（オーダー番号・order id 等）が必要です。",
        },
        { status: 400 }
      );
    }

    if (amountHeaderByKind.size === 0) {
      return NextResponse.json(
        {
          error:
            "金額列が1つも見つかりません。商品売上・商品の売上税・Amazon手数料・FBA 手数料・その他トランザクション手数料等の列が必要です。",
        },
        { status: 400 }
      );
    }

    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const rowErrors: string[] = [];
    const expanded: DetailRow[] = [];

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (!r || typeof r !== "object") continue;

      const orderId = toTrimmedString(r[hOrder]);
      const dateRaw = toTrimmedString(r[hDate]);
      const typeRaw = hType ? toTrimmedString(r[hType]) : "";

      if (!orderId) {
        rowErrors.push(`行 ${i + 2 + skippedPrefixLines}: オーダー番号が空です。`);
        continue;
      }
      if (!dateRaw) {
        rowErrors.push(`行 ${i + 2 + skippedPrefixLines}: 日付が空です（注文 ${orderId}）。`);
        continue;
      }

      if (hType && !isOrderKindRowType(typeRaw)) {
        continue;
      }

      const postedIso =
        parseFlexiblePostedDateToIso(dateRaw) ??
        (Date.parse(dateRaw) ? new Date(Date.parse(dateRaw)).toISOString() : null);
      if (!postedIso) {
        rowErrors.push(`行 ${i + 2 + skippedPrefixLines}: 日付を解釈できません（${dateRaw}）。`);
        continue;
      }

      const skuRaw = hSku ? toTrimmedString(r[hSku]) : "";
      const sku = skuRaw ? skuRaw : null;

      for (const [kind, headerName] of amountHeaderByKind) {
        const rawCell = toTrimmedString(r[headerName]);
        if (!rawCell) continue;
        const num = parseMoneyToNumber(rawCell);
        if (num == null) {
          rowErrors.push(
            `行 ${i + 2 + skippedPrefixLines}: 金額が数値として解釈できません（${orderId} / ${headerName}）。`
          );
          continue;
        }
        if (num === 0) continue;

        const signed = signedForKind(kind, num);
        const { amount_type, amount_description } = logicalToAmountTypes(kind);

        expanded.push({
          amazon_order_id: orderId,
          posted_iso: postedIso,
          sku,
          transaction_type: "Order",
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
      { amount: number; posted_iso: string; sku: string | null; amount_type: string; amount_description: string }
    >();

    const mergeKeyOf = (d: DetailRow): MergeKey =>
      [d.amazon_order_id.trim(), d.transaction_type, d.amount_type, d.amount_description].join("\u0001");

    let mergeExtraRows = 0;
    const ordersThatMerged = new Set<string>();
    for (const d of expanded) {
      const k = mergeKeyOf(d);
      const cur = mergeMap.get(k);
      if (!cur) {
        mergeMap.set(k, {
          amount: d.amount,
          posted_iso: d.posted_iso,
          sku: d.sku,
          amount_type: d.amount_type,
          amount_description: d.amount_description,
        });
      } else {
        cur.amount += d.amount;
        if (Date.parse(d.posted_iso) < Date.parse(cur.posted_iso)) {
          cur.posted_iso = d.posted_iso;
        }
        if (!cur.sku && d.sku) cur.sku = d.sku;
        mergeExtraRows += 1;
        ordersThatMerged.add(d.amazon_order_id.trim());
      }
    }

    const mergedSplitPaymentOrders = ordersThatMerged.size;
    const mergedSplitPaymentExtraRows = mergeExtraRows;

    const insertPayload = [...mergeMap.entries()].map(([key, v]) => {
      const orderId = key.split("\u0001")[0] ?? "";
      return {
        amazon_order_id: orderId,
        sku: v.sku,
        transaction_type: "Order" as const,
        amount_type: v.amount_type,
        amount_description: `Transaction report CSV — ${v.amount_description}`,
        amount: Math.round(v.amount * 100) / 100,
        posted_date: v.posted_iso,
        amazon_event_hash: hashMergedDetail(orderId, v.amount_type, v.amount_description),
      };
    });

    console.log(
      `[amazon-sales-import] skipped_prefix=${skippedPrefixLines} csv_rows=${data.length} expanded=${expanded.length} merged_out=${insertPayload.length} merged_orders=${mergedSplitPaymentOrders} merged_extra=${mergedSplitPaymentExtraRows}`
    );

    let upserted = 0;
    for (let i = 0; i < insertPayload.length; i += UPSERT_CHUNK) {
      const chunk = insertPayload.slice(i, i + UPSERT_CHUNK);
      const { data: upData, error: upErr } = await supabase
        .from("sales_transactions")
        .upsert(chunk, { onConflict: "amazon_event_hash" })
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
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "売上データのインポートに失敗しました。";
    console.error("[amazon-sales-import]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
