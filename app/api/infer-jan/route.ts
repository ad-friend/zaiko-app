import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 💡 Supabaseクライアントの初期化
// ※環境変数はプロジェクトの設定に合わせてください
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 現在安定して動作しているモデル
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

export async function POST(request: NextRequest) {
  try {
    const { jan } = await request.json();
    const cleanJan = String(jan ?? "").trim().replace(/\D/g, "");
    
    if (!cleanJan) return NextResponse.json({ error: "JANが必要です" }, { status: 400 });

    // ==========================================
    // 🟢 1. まずは Supabase データベースを確認する
    // ==========================================
    // ⚠️ 'products' の部分は、商品マスターのテーブル名（または inbound_items など）に変更してください
    const { data: existingProduct, error: dbError } = await supabase
      .from('products') 
      .select('brand, name, model_number') // 取得するカラム名を実際のDBに合わせてください
      .eq('jan', cleanJan)
      .maybeSingle();

    if (existingProduct) {
      // 💡 データベースに登録済みのJANなら、AIを動かさずに即座に返す（API消費ゼロ、爆速！）
      console.log(`[infer-jan] Supabaseから取得成功: ${cleanJan}`);
      return NextResponse.json({
        brand: existingProduct.brand || "",
        productName: existingProduct.name || "", 
        modelNumber: existingProduct.model_number || "",
        inferred: false // 推論ではなく、DBにある確定データという印
      });
    }

    // ==========================================
    // 🔴 2. DBになかった場合のみ、AI（Gemini）を動かす
    // ==========================================
    console.log(`[infer-jan] DBに未登録のため、AIで推論を実行します: ${cleanJan}`);
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (apiKey) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
        
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: `Google検索を使い、JANコード「${cleanJan}」の商品情報を特定してください。JSON形式のみで回答。 {"brand":"..","product_name":"..","model_number":".."}` }]
            }],
            tools: [{ google_search: {} }],
            generationConfig: { 
              temperature: 1.0, 
              response_mime_type: "application/json" 
            }
          }),
        });

        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
        const parsed = JSON.parse(text);

        return NextResponse.json({
          brand: sanitize(parsed.brand),
          productName: sanitize(parsed.product_name),
          modelNumber: sanitize(parsed.model_number),
          inferred: true,
        });
      } catch (e: any) {
        return NextResponse.json({ ...inferHeuristic(cleanJan), brand: "❌ AIエラー", productName: e.message });
      }
    }
    return NextResponse.json(inferHeuristic(cleanJan));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function sanitize(s: any): string {
  return String(s || "").replace(/\d{13,}/g, "").replace(/\s+/g, " ").trim();
}

function inferHeuristic(jan: string): InferJanResponse {
  const isJapan = jan.startsWith("45") || jan.startsWith("49");
  return {
    brand: isJapan ? "（推論）国産品" : "（推論）不明",
    productName: `商品 ${jan.slice(-6)}`,
    modelNumber: `JAN-${jan.slice(-6)}`,
    inferred: true,
  };
}