/**
 * Amazon 日付範囲別レポート等の「トランザクション」CSV/TSV を sales_transactions に取り込む。
 * 同一注文・Order 系の分割行は金額合算して1行にマージ（二重計上防止）。
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import Papa from "papaparse";
import { supabase } from "@/lib/supabase";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";

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

/** 売上系は同一注文でマージ対象（FBA 分割発送の複数 Order 行など） */
function shouldMergeSplitPayments(classified: "Order" | "Refund" | "Fee" | "Other"): boolean {
  return classified === "Order";
}

function classifyTransactionType(raw: string): "Order" | "Refund" | "Fee" | "Other" {
  const t = raw.trim().toLowerCase();
  if (!t) return "Order";
  if (t.includes("refund")) return "Refund";
  if (t.includes("fee") || t.includes("commission") || t.includes("subscription") || t.includes("chargeback")) {
    return "Fee";
  }
  if (
    t.includes("order") ||
    t.includes("shipment") ||
    t === "sale" ||
    (t.includes("sale") && !t.includes("refund"))
  ) {
    return "Order";
  }
  return "Other";
}

function dbTransactionType(c: "Order" | "Refund" | "Fee" | "Other"): string {
  if (c === "Other") return "Adjustment";
  return c;
}

function dbAmountType(c: "Order" | "Refund" | "Fee" | "Other"): string {
  if (c === "Order") return "Sell";
  if (c === "Refund") return "Refund";
  if (c === "Fee") return "Fee";
  return "Other";
}

/** マージ済み Order 行は注文単位で安定したハッシュ（再取込で上書き） */
function hashMergedOrder(amazonOrderId: string): string {
  const raw = ["AmazonTxReportMergedV1", "Order", "Sell", amazonOrderId.trim()].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

function hashStandaloneRow(
  amazonOrderId: string,
  transactionType: string,
  amountType: string,
  postedIso: string,
  amount: number,
  seq: number
): string {
  const raw = ["AmazonTxReportRowV1", amazonOrderId, transactionType, amountType, postedIso, String(amount), String(seq)].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

type ParsedRow = {
  amazon_order_id: string;
  posted_raw: string;
  posted_iso: string;
  amount: number;
  classified: ReturnType<typeof classifyTransactionType>;
  sku: string | null;
};

const UPSERT_CHUNK = 150;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { csvText?: unknown; fileName?: unknown };
    const csvText = typeof body.csvText === "string" ? body.csvText : "";
    const fileName = typeof body.fileName === "string" ? body.fileName : "upload.csv";

    if (!csvText.trim()) {
      return NextResponse.json({ error: "csvText にファイル内容を渡してください。" }, { status: 400 });
    }

    const firstNonEmptyLine =
      csvText
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";

    const delimiter = guessDelimiter(fileName, firstNonEmptyLine);

    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      delimiter: delimiter === "\t" ? "\t" : ",",
      skipEmptyLines: "greedy",
    });

    if (parsed.errors?.length) {
      const msg = parsed.errors.map((e) => e.message).join("; ");
      return NextResponse.json({ error: `CSV パースエラー: ${msg}` }, { status: 400 });
    }

    const headers = (parsed.meta.fields ?? []).filter((h): h is string => typeof h === "string" && h.trim().length > 0);

    const hDate = pickHeaderKey(headers, [
      "date",
      "posted date",
      "posteddate",
      "transaction date",
      "posting date",
      "settlement date",
      "日付",
      "決済日",
      "投稿日",
      "トランザクション日付",
    ]);
    const hOrder = pickHeaderKey(headers, [
      "order id",
      "orderid",
      "amazon order id",
      "amazon-order-id",
      "amazonorderid",
      "注文番号",
      "注文id",
    ]);
    const hTotal = pickHeaderKey(headers, [
      "total",
      "amount",
      "product sales",
      "product sales price",
      "total amount",
      "合計",
      "金額",
      "売上",
      "product charges",
    ]);
    const hType = pickHeaderKey(headers, [
      "type",
      "transaction type",
      "transactiontype",
      "種類",
      "トランザクションタイプ",
      "タイプ",
    ]);
    const hSku = pickHeaderKey(headers, ["sku", "seller-sku", "sellersku", "SKU", "商品sku"]);

    if (!hDate || !hOrder || !hTotal) {
      return NextResponse.json(
        {
          error:
            "必須列が見つかりません。日付（date / posted date 等）・注文番号（order id 等）・合計金額（total 等）の列が必要です。",
        },
        { status: 400 }
      );
    }

    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const rowErrors: string[] = [];
    const parsedRows: ParsedRow[] = [];

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (!r || typeof r !== "object") continue;

      const orderId = toTrimmedString(r[hOrder]);
      const dateRaw = toTrimmedString(r[hDate]);
      const totalRaw = toTrimmedString(r[hTotal]);
      const typeRaw = hType ? toTrimmedString(r[hType]) : "";
      const skuRaw = hSku ? toTrimmedString(r[hSku]) : "";

      if (!orderId) {
        rowErrors.push(`行 ${i + 2}: 注文番号が空です。`);
        continue;
      }
      if (!dateRaw) {
        rowErrors.push(`行 ${i + 2}: 日付が空です（注文 ${orderId}）。`);
        continue;
      }

      const postedIso = parseFlexiblePostedDateToIso(dateRaw) ?? (Date.parse(dateRaw) ? new Date(Date.parse(dateRaw)).toISOString() : null);
      if (!postedIso) {
        rowErrors.push(`行 ${i + 2}: 日付を解釈できません（${dateRaw}）。`);
        continue;
      }

      const amount = parseMoneyToNumber(totalRaw);
      if (amount == null) {
        rowErrors.push(`行 ${i + 2}: 金額が数値として解釈できません（注文 ${orderId}）。`);
        continue;
      }

      const classified = classifyTransactionType(typeRaw);

      parsedRows.push({
        amazon_order_id: orderId,
        posted_raw: dateRaw,
        posted_iso: postedIso,
        amount,
        classified,
        sku: skuRaw ? skuRaw : null,
      });
    }

    if (!parsedRows.length) {
      return NextResponse.json({
        ok: true,
        rows_read: 0,
        rows_after_merge: 0,
        merged_split_payment_orders: 0,
        merged_split_payment_extra_rows: 0,
        message: "取り込む有効行がありません。",
        upserted: 0,
        row_errors: rowErrors.slice(0, 50),
      });
    }

    /** マージ: Order かつ同一 amazon_order_id */
    const orderMergeMap = new Map<string, { amount: number; posted_iso: string; sku: string | null }>();
    const nonMergeRows: ParsedRow[] = [];
    let mergeExtraRows = 0;

    for (const row of parsedRows) {
      if (!shouldMergeSplitPayments(row.classified)) {
        nonMergeRows.push(row);
        continue;
      }

      const key = row.amazon_order_id.trim();
      const existing = orderMergeMap.get(key);
      if (!existing) {
        orderMergeMap.set(key, {
          amount: row.amount,
          posted_iso: row.posted_iso,
          sku: row.sku,
        });
      } else {
        existing.amount += row.amount;
        if (Date.parse(row.posted_iso) < Date.parse(existing.posted_iso)) {
          existing.posted_iso = row.posted_iso;
        }
        if (!existing.sku && row.sku) existing.sku = row.sku;
        mergeExtraRows += 1;
      }
    }

    const orderRowCounts = new Map<string, number>();
    for (const row of parsedRows) {
      if (!shouldMergeSplitPayments(row.classified)) continue;
      const k = row.amazon_order_id.trim();
      orderRowCounts.set(k, (orderRowCounts.get(k) ?? 0) + 1);
    }
    const mergedSplitPaymentOrders = [...orderRowCounts.values()].filter((c) => c > 1).length;

    const mergedSplitPaymentExtraRows = mergeExtraRows;

    const insertRows: Array<{
      amazon_order_id: string;
      sku: string | null;
      transaction_type: string;
      amount_type: string;
      amount_description: string | null;
      amount: number;
      posted_date: string;
      amazon_event_hash: string;
    }> = [];

    let hashSeq = 0;
    for (const [orderId, agg] of orderMergeMap) {
      const tt = dbTransactionType("Order");
      const at = dbAmountType("Order");
      insertRows.push({
        amazon_order_id: orderId,
        sku: agg.sku,
        transaction_type: tt,
        amount_type: at,
        amount_description: "Transaction report (merged split payments)",
        amount: Math.round(agg.amount * 100) / 100,
        posted_date: agg.posted_iso,
        amazon_event_hash: hashMergedOrder(orderId),
      });
    }

    for (const row of nonMergeRows) {
      const tt = dbTransactionType(row.classified);
      const at = dbAmountType(row.classified);
      hashSeq += 1;
      insertRows.push({
        amazon_order_id: row.amazon_order_id.trim(),
        sku: row.sku,
        transaction_type: tt,
        amount_type: at,
        amount_description: "Transaction report CSV",
        amount: Math.round(row.amount * 100) / 100,
        posted_date: row.posted_iso,
        amazon_event_hash: hashStandaloneRow(row.amazon_order_id.trim(), tt, at, row.posted_iso, row.amount, hashSeq),
      });
    }

    console.log(
      `[amazon-sales-import] rows_read=${parsedRows.length} rows_out=${insertRows.length} merged_orders=${mergedSplitPaymentOrders} merged_extra_rows=${mergedSplitPaymentExtraRows}`
    );

    let upserted = 0;
    for (let i = 0; i < insertRows.length; i += UPSERT_CHUNK) {
      const chunk = insertRows.slice(i, i + UPSERT_CHUNK);
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
        ? `${mergedSplitPaymentExtraRows}件の分割決済行をマージしました（${mergedSplitPaymentOrders}注文）。`
        : "分割決済のマージはありませんでした。";

    return NextResponse.json({
      ok: true,
      rows_read: parsedRows.length,
      rows_after_merge: insertRows.length,
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
