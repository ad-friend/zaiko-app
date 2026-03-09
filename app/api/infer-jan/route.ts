import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) {
      return NextResponse.json({ error: "JANコードを指定してください" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    // AIで推論（APIキーがある場合）
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError) {
        console.error("[infer-jan] Gemini Error:", geminiError);
      }
    }

    // AIがダメな場合、またはキーがない場合は元の詳しい推論ロジックを使用
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
          text: `あなたはJANコードから商品情報を特定する専門家です。
          JANコード「${jan}」のブランド名、正確な商品名、型番を特定してください。
          必ず以下のJSON形式のみで回答し、余計な説明は含めないでください。
          {"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      generationConfig: { max_output_tokens: 512, temperature: 0.1 }
    }),
  });

  if (!res.ok) throw new Error(`API Error: ${res.status}`);

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // 修正ポイント：エラーの原因だった /s フラグを [\\s\\S] に変更（古いバージョンでも動く書き方）
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
  };
}

function sanitizeProductText(s: string): string {
  return String(s).replace(/\d{13,}/g, "").replace(/\s+/g, " ").trim();
}

// あなたが以前使っていた、詳しい推論ロジックを復活させました
function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  const len = digits.length;
  let brand = "（推論）不明ブランド";
  let productName = "";
  let modelNumber = "";

  if (len >= 8) {
    const suffix = digits.slice(-6);
    modelNumber = `JAN-${suffix}`;
    productName = `商品 ${suffix}`;
    // 日本のコード体系に基づいた推論
    if (digits.startsWith("45") || digits.startsWith("49")) {
      brand = "（推論）国産品";
    } else if (digits.startsWith("4")) {
      brand = "（推論）日本向け";
    }
  }

  return {
    brand,
    productName: productName || "（JANから推論）",
    modelNumber: modelNumber || jan.slice(-8),
    inferred: true,
  };
}