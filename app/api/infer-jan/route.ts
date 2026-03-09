import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 正確なモデル名を使用します
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) return NextResponse.json({ error: "JANが必要です" }, { status: 400 });

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError) {
        // AIが失敗した理由をコンソールに出力
        console.error("[infer-jan] Gemini Error Detail:", geminiError);
      }
    }

    // 失敗した場合は、あなたが用意した以前のロジック（テンプレート）を返す
    return NextResponse.json(inferHeuristic(jan));

  } catch (e) {
    return NextResponse.json({ error: "Fatal Error" }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 3.1系で最も安定している v1 エンドポイントを使用
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `JANコード「${jan}」の商品情報を特定してください。
          必ず以下のJSON形式のみで回答してください。
          {"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      generationConfig: {
        max_output_tokens: 512,
        temperature: 0.1
      }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Status: ${res.status}, Message: ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // JSONを安全に抽出
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
  return {
    brand: "（AI失敗）確認中",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}