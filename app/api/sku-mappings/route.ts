/** SKUマッピング（EC SKU と JAN の紐付け） */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** GET: 一覧（sku, title, platform でグループ化しやすいようフラットで返す） */
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("sku_mappings")
      .select("id, sku, title, platform, jan_code, quantity, created_at")
      .order("sku", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** POST: 一括登録。body: { sku: string, title?: string, platform: string, items: { jan_code: string, quantity: number }[] } */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sku = String(body.sku ?? "").trim();
    const title = body.title != null ? String(body.title).trim() : null;
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
          title: title || null,
          platform,
          jan_code,
          quantity: Number.isFinite(quantity) && quantity >= 1 ? quantity : 1,
        };
      })
      .filter(Boolean) as { sku: string; title: string | null; platform: string; jan_code: string; quantity: number }[];

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
// 🌟🌟🌟 ここから追加 🌟🌟🌟
export async function PUT(request: Request) {
  try {
    // 1. 画面から送られてきたデータ（skuとtitle）を受け取る
    const body = await request.json();
    const { sku, title } = body;

    if (!sku) {
      return NextResponse.json({ error: "SKUが指定されていません" }, { status: 400 });
    }

    // 2. Supabaseの該当SKUのタイトルを一括更新する
    // ※もし上のコードで supabase の変数名が違う場合（例：supabaseClientなど）はそれに合わせてください
    const { error } = await supabase
      .from("sku_mappings")
      .update({ title: title })
      .eq("sku", sku);

    if (error) {
      console.error("Supabase更新エラー:", error);
      return NextResponse.json({ error: "データベースの更新に失敗しました" }, { status: 500 });
    }

    // 3. 成功したよ！と画面に返す
    return NextResponse.json({ success: true, message: "タイトルを更新しました" });
    
  } catch (error) {
    console.error("APIエラー:", error);
    return NextResponse.json({ error: "サーバーエラーが発生しました" }, { status: 500 });
  }
}