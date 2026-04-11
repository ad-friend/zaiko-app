/**
 * Amazon 売上・手数料・返品・補填データ取得API (POST)
 * SP-API Finances listFinancialEvents で指定期間の財務イベントを取得し、
 * sales_transactions に amazon_event_hash で重複排除して保存する。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createAmazonFinancesSpClient,
  fetchFinancialEventsChunk,
  postedBoundsFromDateRange,
  upsertSalesTransactionRows,
} from "@/lib/amazon-financial-events";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate と endDate を ISO 8601 形式で指定してください。" },
        { status: 400 }
      );
    }

    const { postedAfter, postedBefore } = postedBoundsFromDateRange(startDate, endDate);
    const spClient = createAmazonFinancesSpClient();
    const { rows: allRows, complete } = await fetchFinancialEventsChunk(spClient, {
      postedAfter,
      postedBefore,
      maxPages: null,
    });
    if (!complete) {
      return NextResponse.json(
        { error: "財務イベントの取得が途中で打ち切られました（内部エラー）。再度お試しください。" },
        { status: 500 }
      );
    }

    if (allRows.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "指定期間に財務イベントはありませんでした。",
        rowsInserted: 0,
        rowsSkipped: 0,
        totalFetched: 0,
      });
    }

    const { inserted, skipped, tableMissing } = await upsertSalesTransactionRows(allRows);
    if (tableMissing) {
      return NextResponse.json(
        {
          error: "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "財務イベントを取得し、sales_transactions に保存しました。",
      rowsInserted: inserted,
      rowsSkipped: skipped,
      totalFetched: allRows.length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "財務データの取得・保存に失敗しました。";
    console.error("[fetch-finances]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
