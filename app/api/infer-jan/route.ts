import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 1分間のリクエスト制限に強い 3.1 Flash Lite を指定
const GEMINI_MODEL = "gemini-2.5-flash";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) {
      return NextResponse.json({ error: "JANコードを指定してください" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError) {
        console.error("[infer-jan] Gemini Error:", geminiError);
      }
    }

    // AIが制限(429)などで失敗した場合は、独自の推論ロジックを返却
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
          text: `JANコード「${jan}」の商品情報を特定し、以下のJSON形式のみで回答してください。解説は不要です。
          {"brand": "ブランド名", "product_name": "商品名", "model_number": "型番"}`
        }]
      }],
      generationConfig: {
        max_output_tokens: 512,
        temperature: 0.1
      }
    }),
  });

  if (!res.ok) throw new Error(`API Error: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // ビルドエラー回避のため、古い環境でも動く正規表現を使用
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: String(parsed.brand ?? "").trim(),
    productName: String(parsed.product_name ?? "").trim(),
    modelNumber: String(parsed.model_number ?? "").trim(),
    inferred: true,
  };
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  let brand = "（推論）不明ブランド";
  
  // 国産品などの簡易判定ロジック
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