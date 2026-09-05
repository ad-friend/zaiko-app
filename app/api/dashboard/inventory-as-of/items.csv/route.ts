/**
 * 指定日 23:59:59（東京）時点の未決済在庫明細CSV（在庫一覧列＋progress / item_kind）
 * GET /api/dashboard/inventory-as-of/items.csv?asOf=YYYY-MM-DD
 */
import { NextRequest, NextResponse } from "next/server";
import {
  asOfEndExclusiveIsoFromDate,
  buildUnsettledItemsCsv,
  todayYmdTokyo,
} from "@/lib/inventory-as-of-report";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const asOf = searchParams.get("asOf")?.trim() || todayYmdTokyo();

    if (!asOfEndExclusiveIsoFromDate(asOf)) {
      return NextResponse.json({ error: "asOf は YYYY-MM-DD 形式で指定してください。" }, { status: 400 });
    }

    const { filename, csv } = await buildUnsettledItemsCsv(asOf);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "明細CSVの出力に失敗しました。";
    console.error("[dashboard/inventory-as-of/items.csv]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
