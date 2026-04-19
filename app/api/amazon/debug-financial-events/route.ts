/**
 * listFinancialEvents の EventList 件数・注文番号ヒットを返すだけ（DB 非更新）。
 * 誤開放防止のため ALLOW_AMAZON_FINANCES_DEBUG=true のときのみ有効。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createAmazonFinancesSpClient,
  debugScanListFinancialEvents,
  postedBoundsFromDateRange,
} from "@/lib/amazon-financial-events";

export async function POST(request: NextRequest) {
  if (process.env.ALLOW_AMAZON_FINANCES_DEBUG !== "true") {
    return NextResponse.json(
      {
        error:
          "診断APIは無効です。.env に ALLOW_AMAZON_FINANCES_DEBUG=true を設定し、検証後に必ず外してください。",
      },
      { status: 403 }
    );
  }

  try {
    const body = await request.json().catch(() => ({}));
    const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    const amazonOrderId =
      typeof body.amazonOrderId === "string" && body.amazonOrderId.trim() ? body.amazonOrderId.trim() : "";
    const maxPages =
      typeof body.maxPages === "number" && Number.isFinite(body.maxPages) ? Math.floor(body.maxPages) : undefined;

    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate と endDate を指定してください（fetch-finances と同形式）。" },
        { status: 400 }
      );
    }

    const { postedAfter, postedBefore } = postedBoundsFromDateRange(startDate, endDate);
    const spClient = createAmazonFinancesSpClient();
    const result = await debugScanListFinancialEvents(spClient, {
      postedAfter,
      postedBefore,
      amazonOrderId: amazonOrderId || null,
      maxPages,
    });

    return NextResponse.json({
      ok: true,
      note:
        "totalOrderHits は JSON 部分一致。RefundEventList=0 かつ ShipmentEventList>0 なら返金が Order 側に載っている可能性。unhandledNonEmptyArrayKeys に件数があれば未取込リストあり。",
      ...result,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "診断に失敗しました。";
    console.error("[debug-financial-events]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
