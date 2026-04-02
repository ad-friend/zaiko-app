/**
 * Amazon注文一覧
 * GET: status クエリで filtering（manual_required など）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    let q = supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, line_index, condition_id, reconciliation_status, quantity, jan_code, asin, created_at")
      .order("created_at", { ascending: false });

    if (status) {
      q = q.eq("reconciliation_status", status);
    }

    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    return NextResponse.json(
      rows.map((row) => ({
        ...row,
        /** `id` と同一。amazon_orders の主キー（UUID）を明示（フロントの取り違え防止） */
        order_row_id: row.id,
      }))
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
