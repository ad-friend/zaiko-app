/** SKUマッピング（EC SKU と JAN の紐付け） */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** POST: 一括登録。body: { sku: string, platform: string, items: { jan_code: string, quantity: number }[] } */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sku = String(body.sku ?? "").trim();
    const platform = String(body.platform ?? "").trim();
    const items = Array.isArray(body.items) ? body.items : [];

    if (!sku) return NextResponse.json({ error: "SKUを入力してください。" }, { status: 400 });
    if (!platform) return NextResponse.json({ error: "プラットフォームを選択してください。" }, { status: 400 });
    if (items.length === 0) return NextResponse.json({ error: "JANを1件以上リストに追加してください。" }, { status: 400 });

    const rows = items
      .map((item: { jan_code?: unknown; quantity?: unknown }) => {
        const jan_code = String(item.jan_code ?? "").trim();
        const quantity = Number(item.quantity);
        if (!jan_code) return null;
        return {
          sku,
          platform,
          jan_code,
          quantity: Number.isFinite(quantity) && quantity >= 1 ? quantity : 1,
        };
      })
      .filter(Boolean) as { sku: string; platform: string; jan_code: string; quantity: number }[];

    if (rows.length === 0) return NextResponse.json({ error: "有効なJANがありません。" }, { status: 400 });

    const { error } = await supabase.from("sku_mappings").insert(rows);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "同じSKUとJANの組み合わせが既に登録されています。重複を除いて再度お試しください。" },
          { status: 409 }
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true, count: rows.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "登録に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
