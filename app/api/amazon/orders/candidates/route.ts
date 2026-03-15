/**
 * 手動消込用：指定注文に紐づく在庫候補一覧
 * GET: ?amazon_order_id=xxx&sku=xxx または ?jan_code=xxx
 * 注文の asin と在庫の asin が一致する在庫を検索。表示用には在庫側の jan_code を返す（JAN主軸）。
 * フォールバック: jan_code 指定時または注文に asin がない場合は jan_code 一致で検索。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const amazonOrderId = searchParams.get("amazon_order_id")?.trim() ?? "";
    const sku = searchParams.get("sku")?.trim() ?? "";
    const janCode = searchParams.get("jan_code")?.trim() ?? "";

    if (!amazonOrderId && !janCode) {
      return NextResponse.json({ error: "amazon_order_id または jan_code を指定してください。" }, { status: 400 });
    }

    let asin: string | null = null;
    let jan: string | null = janCode || null;

    if (amazonOrderId) {
      const q = supabase
        .from("amazon_orders")
        .select("asin, jan_code, sku")
        .eq("amazon_order_id", amazonOrderId);
      if (sku) q.eq("sku", sku);
      const { data: orderRow } = await q.maybeSingle();
      if (orderRow) {
        asin = orderRow.asin?.trim() ?? null;
        if (!jan) jan = orderRow.jan_code?.trim() || (orderRow.sku?.trim().match(/^\d{13}$/) ? orderRow.sku.trim() : null) ;
      }
    }

    type Row = { id: number; jan_code: string | null; product_name: string | null; condition_type: string | null; created_at: string | null; order_id: string | null };
    let data: Row[] = [];

    if (asin) {
      let janFromMaster: string | null = null;
      const { data: productRow } = await supabase
        .from("products")
        .select("jan_code")
        .eq("asin", asin)
        .maybeSingle();
      if (productRow?.jan_code) janFromMaster = String(productRow.jan_code).trim();

      if (janFromMaster) {
        const { data: byJan, error: errJan } = await supabase
          .from("inbound_items")
          .select("id, jan_code, product_name, condition_type, created_at, order_id")
          .or("order_id.is.null,order_id.eq.")
          .eq("jan_code", janFromMaster)
          .order("created_at", { ascending: true });
        if (!errJan && byJan?.length) data = byJan;
      }

      if (data.length === 0) {
        const { data: byAsin, error: errAsin } = await supabase
          .from("inbound_items")
          .select("id, jan_code, product_name, condition_type, created_at, order_id")
          .or("order_id.is.null,order_id.eq.")
          .eq("asin", asin)
          .order("created_at", { ascending: true });
        if (!errAsin && byAsin?.length) data = byAsin;
      }
    }
    if (data.length === 0 && jan) {
      const { data: byJan, error: errJan } = await supabase
        .from("inbound_items")
        .select("id, jan_code, product_name, condition_type, created_at, order_id")
        .or("order_id.is.null,order_id.eq.")
        .eq("jan_code", jan)
        .order("created_at", { ascending: true });
      if (!errJan && byJan?.length) data = byJan;
    }

    return NextResponse.json(data);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
