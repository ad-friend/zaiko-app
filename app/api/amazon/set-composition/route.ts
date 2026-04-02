/**
 * セット構成プレビュー（手動消込UI用）
 * GET: ?sku=出品SKU&platform=Amazon&order_qty=1
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isSetProductFromMappings } from "@/lib/amazon-manual-reconcile-helpers";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sku = searchParams.get("sku")?.trim() ?? "";
    const platform = searchParams.get("platform")?.trim() || "Amazon";
    const orderQty = Math.max(1, Number(searchParams.get("order_qty")) || 1);

    if (!sku) {
      return NextResponse.json({ error: "sku を指定してください。" }, { status: 400 });
    }

    const { data: mappings, error } = await supabase
      .from("sku_mappings")
      .select("jan_code, quantity")
      .eq("sku", sku)
      .eq("platform", platform);
    if (error) throw error;

    const mapList = mappings ?? [];
    const isSet = isSetProductFromMappings(mapList);
    const slots: { jan_code: string; label: string }[] = [];
    let totalUnits = 0;

    for (const m of mapList) {
      const jan = String(m.jan_code ?? "").trim();
      const perSet = Number(m.quantity) || 1;
      const need = perSet * orderQty;
      totalUnits += need;
      for (let i = 1; i <= need; i++) {
        slots.push({
          jan_code: jan,
          label: `${jan}（${i}/${need}）`,
        });
      }
    }

    return NextResponse.json({
      is_set: isSet,
      sku,
      platform,
      order_qty: orderQty,
      total_units: totalUnits,
      slots,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
