/**
 * 指定日 0:00（東京）時点の棚卸用在庫レポート
 * GET /api/dashboard/inventory-as-of?asOf=YYYY-MM-DD
 */
import { NextRequest, NextResponse } from "next/server";
import {
  aggregateInventoryAsOf,
  asOfStartIsoFromDate,
  todayYmdTokyo,
} from "@/lib/inventory-as-of-report";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const asOf = searchParams.get("asOf")?.trim() || todayYmdTokyo();

    if (!asOfStartIsoFromDate(asOf)) {
      return NextResponse.json({ error: "asOf は YYYY-MM-DD 形式で指定してください。" }, { status: 400 });
    }

    const payload = await aggregateInventoryAsOf(asOf);
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "棚卸レポートの集計に失敗しました。";
    console.error("[dashboard/inventory-as-of]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
