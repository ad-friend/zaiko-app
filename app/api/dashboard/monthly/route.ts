/**
 * 月次経営メトリクス（複数月テーブル用）
 * GET /api/dashboard/monthly?from=YYYY-MM&to=YYYY-MM
 */
import { NextRequest, NextResponse } from "next/server";
import {
  aggregateMonthlyDashboardRows,
  defaultMonthlyRange,
  listMonthPeriods,
  parseYearMonth,
} from "@/lib/dashboard-aggregates";
import type { MonthlyDashboardPayload } from "@/lib/dashboard-types";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const defaults = defaultMonthlyRange(23);
    const fromParam = searchParams.get("from")?.trim() || defaults.from;
    const toParam = searchParams.get("to")?.trim() || defaults.to;

    if (!parseYearMonth(fromParam) || !parseYearMonth(toParam)) {
      return NextResponse.json({ error: "from / to は YYYY-MM 形式で指定してください。" }, { status: 400 });
    }

    if (fromParam > toParam) {
      return NextResponse.json({ error: "from は to 以前の月を指定してください。" }, { status: 400 });
    }

    const periods = listMonthPeriods(fromParam, toParam);
    if (!periods.length) {
      return NextResponse.json({ error: "指定期間に有効な月がありません。" }, { status: 400 });
    }
    if (periods.length > 36) {
      return NextResponse.json({ error: "一度に取得できるのは最大36ヶ月までです。" }, { status: 400 });
    }

    const rows = await aggregateMonthlyDashboardRows(periods);

    const payload: MonthlyDashboardPayload = {
      from: fromParam,
      to: toParam,
      rows,
    };
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "月次ダッシュボードの集計に失敗しました。";
    console.error("[dashboard/monthly]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
