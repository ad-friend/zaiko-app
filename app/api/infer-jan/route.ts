import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// リストにある正確な名称に合わせます
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) return NextResponse.json({ error: "JANコードを指定してください" }, { status: 400 });

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError) {
        console.error("[infer-jan] Gemini Error:", geminiError);
      }
    }

    return NextResponse.json(inferHeuristic(jan));
  } catch (e) {
    console.error("[infer-jan] Fatal Error:", e);
    return NextResponse.json({ error: "エラーが発生しました" }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          // 最新情報を引き出すための具体的指示
          text: `Google検索を使い、JANコード「${jan}」の最新の商品情報を特定してください。
          ブランド名、正確な商品名（容量や色を含む）、型番を特定し、以下のJSON形式のみで回答してください。
          {"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      // Google検索ツールを有効化
      tools: [{ google_search: {} }],
      generationConfig: {
        max_output_tokens: 512,
        temperature: 0.1 // 精度優先の設定
      }
    }),
  });

  if (!res.ok) throw new Error(`API Error: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // Vercelのビルドエラーを回避する正規表現
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: String(parsed.brand || "").trim(),
    productName: String(parsed.product_name || "").trim(),
    modelNumber: String(parsed.model_number || "").trim(),
    inferred: true,
  };
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  let brand = "（推論）不明ブランド";
  if (digits.startsWith("45") || digits.startsWith("49")) {
    brand = "（推論）国産品";
  } else if (digits.startsWith("4")) {
    brand = "（推論）日本向け";
  }
  return {
    brand,
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}