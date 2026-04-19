/**
 * 注文番号単位で Finances listFinancialEventsByOrderId を呼び、sales_transactions に upsert。
 * 遅延返金など「期間指定の listFinancialEvents に載らない」取り込み用。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createAmazonFinancesSpClient,
  fetchFinancialEventsByOrderIdChunk,
  upsertSalesTransactionRows,
} from "@/lib/amazon-financial-events";

export const maxDuration = 60;

const AMAZON_ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
const MAX_ORDER_FINANCE_PAGES = 60;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = body?.amazonOrderId != null ? String(body.amazonOrderId).trim() : "";
    const normalized = raw.replace(/[\s\u3000]+/g, "");
    if (!normalized || !AMAZON_ORDER_ID_RE.test(normalized)) {
      return NextResponse.json(
        { error: "amazonOrderId は 3-7-7 形式（例 503-1234567-1234567）で指定してください。" },
        { status: 400 }
      );
    }

    const spClient = createAmazonFinancesSpClient();
    const acc: Awaited<ReturnType<typeof fetchFinancialEventsByOrderIdChunk>>["rows"] = [];
    let nextToken: string | null = null;
    let totalPages = 0;
    let lastChunkComplete = true;
    let truncated = false;

    while (true) {
      const chunk = await fetchFinancialEventsByOrderIdChunk(spClient, {
        orderId: normalized,
        startNextToken: nextToken,
        maxPages: 10,
      });
      acc.push(...chunk.rows);
      totalPages += chunk.pagesFetched;
      lastChunkComplete = chunk.complete;
      if (chunk.complete || !chunk.nextToken) {
        nextToken = null;
        break;
      }
      nextToken = chunk.nextToken;
      if (totalPages >= MAX_ORDER_FINANCE_PAGES) {
        truncated = true;
        break;
      }
    }

    if (acc.length === 0) {
      return NextResponse.json({
        ok: true,
        amazonOrderId: normalized,
        message: "この注文に該当する財務イベント行は0件でした（API上は空、または未反映の可能性があります）。",
        totalFetched: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        pagesFetched: totalPages,
        complete: lastChunkComplete && !truncated,
        truncated,
      });
    }

    const upsert = await upsertSalesTransactionRows(acc);
    if (upsert.tableMissing) {
      return NextResponse.json(
        { error: "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      amazonOrderId: normalized,
      message: truncated
        ? `注文 ${normalized} の財務を取り込みました（ページ上限のため未完了の可能性があります）。`
        : `注文 ${normalized} の財務を取り込みました。`,
      totalFetched: acc.length,
      rowsInserted: upsert.inserted,
      rowsSkipped: upsert.skipped,
      pagesFetched: totalPages,
      complete: lastChunkComplete && !truncated,
      truncated,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "財務の取得に失敗しました。";
    console.error("[fetch-finances-by-order-id]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
