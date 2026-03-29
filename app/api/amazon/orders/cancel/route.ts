/**
 * 手動: 注文キャンセル扱いにし在庫紐付けを解放する（handleOrderCancellation）
 * POST body: { amazon_order_id: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { handleOrderCancellation } from "@/lib/amazon-cancellation";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { amazon_order_id?: unknown };
    const amazon_order_id = body.amazon_order_id != null ? String(body.amazon_order_id).trim() : "";
    if (!amazon_order_id) {
      return NextResponse.json({ error: "amazon_order_id を指定してください。" }, { status: 400 });
    }

    const res = await handleOrderCancellation(amazon_order_id);
    if (!res.ok) {
      return NextResponse.json({ error: res.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "キャンセル処理に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
