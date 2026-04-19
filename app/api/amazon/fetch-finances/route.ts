/**
 * Amazon 売上・手数料・返品・補填データ取得API (POST)
 * SP-API listFinancialEvents で指定期間の財務イベントを取得し、
 * sales_transactions に保存する。
 * ページごとに upsert し、長期間取得でもタイムアウトで丸ごと失わないようにする。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createAmazonFinancesSpClient,
  fetchFinancialEventsChunk,
  postedBoundsFromDateRange,
  upsertSalesTransactionRows,
} from "@/lib/amazon-financial-events";

export const maxDuration = 120;

const MAX_LIST_FINANCIAL_PAGES = 4000;

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

    let listPages = 0;
    let totalFetched = 0;
    let rowsInserted = 0;
    let rowsSkipped = 0;
    let next: string | null = null;
    let hitPageLimit = false;

    while (true) {
      const { rows, nextToken, complete, pagesFetched } = await fetchFinancialEventsChunk(spClient, {
        postedAfter,
        postedBefore,
        startNextToken: next,
        maxPages: 1,
      });
      listPages += pagesFetched;

      if (rows.length > 0) {
        const { inserted, skipped, tableMissing } = await upsertSalesTransactionRows(rows);
        if (tableMissing) {
          return NextResponse.json(
            {
              error: "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。",
            },
            { status: 500 }
          );
        }
        rowsInserted += inserted;
        rowsSkipped += skipped;
        totalFetched += rows.length;
      }

      next = nextToken;
      if (complete || !next) {
        break;
      }
      if (listPages >= MAX_LIST_FINANCIAL_PAGES) {
        hitPageLimit = true;
        break;
      }
    }

    if (totalFetched === 0 && !hitPageLimit) {
      return NextResponse.json({
        ok: true,
        message: "指定期間に財務イベントはありませんでした。",
        rowsInserted: 0,
        rowsSkipped: 0,
        totalFetched: 0,
        listPagesFetched: listPages,
        incomplete: false,
      });
    }

    return NextResponse.json({
      ok: true,
      message: hitPageLimit
        ? `財務イベントを取得し保存しました（ページ上限 ${MAX_LIST_FINANCIAL_PAGES} に達したため未完了の可能性があります）。`
        : "財務イベントを取得し、sales_transactions に保存しました。",
      rowsInserted,
      rowsSkipped,
      totalFetched,
      listPagesFetched: listPages,
      incomplete: hitPageLimit,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "財務データの取得・保存に失敗しました。";
    console.error("[fetch-finances]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
