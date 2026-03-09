import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 💡 Supabaseクライアントの初期化（環境変数はVercel等の設定に合わせてください）
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 1. モデル名はご指摘のプレビュー版を使用
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) return NextResponse.json({ error: "JANが必要です" }, { status: 400 });

    // ==========================================
    // 🟢 1. まずは Supabase データベースをチェックする
    // ==========================================
    // ⚠️ テーブル名（'products'）やカラム名は、実際のデータベースに合わせて変更してください
    const { data: dbItem, error: dbError } = await supabase
      .from('products') 
      .select('brand, product_name, model_number')
      .eq('jan', jan)
      .maybeSingle();

    if (dbItem) {
      // データベースで見つかった場合は、AIを動かさずに即座に返す（API消費ゼロ）
      console.log(`[infer-jan] DBから取得しました: ${jan}`);
      return NextResponse.json({
        brand: dbItem.brand || "",
        productName: dbItem.product_name || "",
        modelNumber: dbItem.model_number || "",
        inferred: false // AI推論ではなく確定データという印
      });
    }

    // ==========================================
    // 🔴 2. DBになかった場合のみ、AI（Gemini）を動かす
    // ==========================================
    console.log(`[infer-jan] DB未登録。AIで推論します: ${jan}`);
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError: any) {
        console.error("[infer-jan] Gemini Error:", geminiError);
        // AIが失敗した際、エラー理由を表示しつつヒューリスティックを返す
        return NextResponse.json({
          ...inferHeuristic(jan),
          brand: "❌ AIエラー",
          productName: `理由: ${geminiError.message}`
        });
      }
    }

    return NextResponse.json(inferHeuristic(jan));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 3.1系プレビューモデルのため v1beta を使用
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `あなたはJANコードから商品情報を特定する専門家です。
          JANコード「${jan}」のブランド名、正確な商品名、型番を特定してください。
          必ず以下のJSON形式のみで回答し、余計な説明は含めないでください。
          {"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      generationConfig: { max_output_tokens: 512, temperature: 0.1 }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google API (${res.status}): ${errText.slice(0, 100)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
  };
}

// ここから下の関数が不足していた、あるいは名前が日本語になっていたのがエラーの原因です
function sanitizeProductText(s: string): string {
  return String(s).replace(/\d{13,}/g, "").replace(/\s+/g, " ").trim();
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  return {
    brand: digits.startsWith("4") ? "（推論）国産品" : "（推論）不明",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}