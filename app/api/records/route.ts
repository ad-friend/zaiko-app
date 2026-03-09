import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type RecordRow = {
  id: number;
  jan_code: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  condition_type: string | null;
  base_price: number;
  effective_unit_price: number;
  created_at: string;
  header: {
    id: number;
    purchase_date: string;
    supplier: string | null;
    genre: string | null;
    created_at: string;
  } | null;
};

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("inbound_items")
      .select(
        `
        id,
        jan_code,
        product_name,
        brand,
        model_number,
        condition_type,
        base_price,
        effective_unit_price,
        created_at,
        inbound_headers (
          id,
          purchase_date,
          supplier,
          genre,
          created_at
        )
      `
      )
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = (data || []).map((row: any) => ({
      id: row.id,
      jan_code: row.jan_code ?? null,
      product_name: row.product_name ?? null,
      brand: row.brand ?? null,
      model_number: row.model_number ?? null,
      condition_type: row.condition_type ?? null,
      base_price: Number(row.base_price ?? 0),
      effective_unit_price: Number(row.effective_unit_price ?? 0),
      created_at: row.created_at ?? "",
      header: Array.isArray(row.inbound_headers) ? row.inbound_headers[0] : row.inbound_headers ?? null,
    }));

    return NextResponse.json(rows);
  } catch (e: any) {
    console.error("[records] GET error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) return NextResponse.json({ error: "idsが必要です" }, { status: 400 });
    const { error } = await supabase.from("inbound_items").delete().in("id", ids);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
