/**
 * 補填・注文なし調整用: seller SKU → sku_mappings → JAN → inbound_items 候補
 * GET: ?sku=SELLER_SKU（必須）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

function uniqueJanFromSkuMappings(mapList: Array<{ jan_code: unknown; quantity?: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = String(m.jan_code ?? "").trim();
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  const [only] = [...jans];
  return only ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const sku = request.nextUrl.searchParams.get("sku")?.trim() ?? "";
    if (!sku) {
      return NextResponse.json({ error: "sku を指定してください。" }, { status: 400 });
    }

    const { data: mappings, error: mapErr } = await supabase
      .from("sku_mappings")
      .select("jan_code, quantity")
      .eq("sku", sku)
      .eq("platform", "Amazon");
    if (mapErr) throw mapErr;

    const jan = uniqueJanFromSkuMappings(mappings ?? []);
    if (!jan) {
      return NextResponse.json([]);
    }

    const { data: inbound, error: inErr } = await supabase
      .from("inbound_items")
      .select("id, jan_code, brand, model_number, condition_type, effective_unit_price, order_id, created_at, product_name")
      .eq("jan_code", jan)
      .is("settled_at", null)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .is("exit_type", null)
      .order("created_at", { ascending: true })
      .limit(80);

    if (inErr) throw inErr;

    const list = (inbound ?? []).map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      sku: row.jan_code != null ? String(row.jan_code).trim() : null,
      brand: row.brand != null ? String(row.brand) : null,
      model_number: row.model_number != null ? String(row.model_number) : null,
      condition: row.condition_type != null ? String(row.condition_type) : null,
      unit_cost: Number(row.effective_unit_price ?? 0),
      amazon_order_id: row.order_id != null ? String(row.order_id) : null,
      product_name: row.product_name != null ? String(row.product_name) : null,
      created_at: row.created_at != null ? String(row.created_at) : null,
    }));

    return NextResponse.json(list);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "候補の取得に失敗しました。";
    console.error("[adjustment-inbound-candidates]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
