/**
 * 返金処理前プレビュー: 処理可能在庫件数・推定返金数量
 * GET /api/amazon/refund-release-inventory?amazon_order_id=...&sales_transaction_ids=1,2,3
 */
import { NextRequest, NextResponse } from "next/server";
import { previewRefundReleaseInventory } from "@/lib/refund-release-inventory";

function parseSalesTransactionIds(raw: string | null): number[] {
  if (!raw?.trim()) return [];
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 1);
  return [...new Set(ids)];
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const amazonOrderId = String(searchParams.get("amazon_order_id") ?? "").trim();
    if (!amazonOrderId) {
      return NextResponse.json({ error: "amazon_order_id が必要です。" }, { status: 400 });
    }

    const salesTransactionIds = parseSalesTransactionIds(searchParams.get("sales_transaction_ids"));

    const preview = await previewRefundReleaseInventory({
      amazonOrderId,
      salesTransactionIds,
    });

    return NextResponse.json(preview);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫プレビューの取得に失敗しました。";
    console.error("[refund-release-inventory]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
