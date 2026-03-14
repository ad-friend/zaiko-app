/**
 * 手動消込用：指定注文に紐づく中古在庫候補一覧
 * GET: ?amazon_order_id=xxx または ?jan_code=xxx で同一JAN・中古・order_id未設定の inbound_items を返す
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id");
    const janCode = searchParams.get("jan_code");

    let jan: string | null = null;
    if (janCode) {
      jan = janCode.trim() || null;
    } else if (amazonOrderId) {
      const { data: orderRow } = await supabase
        .from("amazon_orders")
        .select("jan_code, sku")
        .eq("amazon_order_id", amazonOrderId.trim())
        .single();
      if (orderRow) {
        jan = orderRow.jan_code?.trim() || (orderRow.sku?.trim().match(/^\d{13}$/) ? orderRow.sku.trim() : null) || null;
      }
    }

    if (!jan) {
      return NextResponse.json({ error: "amazon_order_id または jan_code を指定してください。" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("inbound_items")
      .select("id, jan_code, product_name, condition_type, created_at, order_id")
      .eq("jan_code", jan)
      .or("order_id.is.null,order_id.eq.")
      .or("condition_type.eq.中古,condition_type.ilike.%used%")
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
