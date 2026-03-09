import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 2.0 Flash は非常に賢いので、設定なしでもJSONで返せます
const GEMINI_MODEL = "gemini-2.0-flash";
const SYSTEM_PROMPT = `あなたはJAN（EAN-13）コードから商品情報を特定する専門家です。
指示に従って、商品の「ブランド名」「正確な商品名」「型番」を特定してください。
必ず以下のJSON形式のみで回答し、解説や「\`\`\`json」などのマークダウンは一切含めないでください。
{"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`;

export async function POST(request: NextRequest) {
  try {
    const { jan } = (await request.json()) as { jan: string };
    const trimmed = String(jan ?? "").trim().replace(/\D/g, "");
    
    if (!trimmed) return NextResponse.json({ error: "JANコードを指定してください" }, { status: 400 });

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    if (apiKey) {
      try {
        const result = await inferWithGemini(trimmed, apiKey);
        return NextResponse.json(result);
      } catch (geminiError) {
        console.error("[infer-jan] Gemini failed, using fallback:", geminiError);
      }
    }

    return NextResponse.json(inferHeuristic(trimmed));
  } catch (e) {
    console.error("[infer-jan] Fatal Error:", e);
    return NextResponse.json({ error: "エラーが発生しました" }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // エラーを避けるため v1 エンドポイントを使用
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nJANコード: ${jan}` }] }],
      // 修正ポイント：エラーの原因となる response_mime_type などの詳細設定をすべて削除
      generationConfig: {
        max_output_tokens: 512,
        temperature: 0.1
      }
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // AIの回答から { ... } の部分だけを強引に抽出して解析
  let parsed: { brand?: string; product_name?: string; model_number?: string } = {};
  try {
    const match = text.match(/\{.*\}/s);
    if (match) {
      parsed = JSON.parse(match[0]);
    }
  } catch {
    parsed = {};
  }

  return {
    brand: (parsed.brand ?? "").trim(),
    productName: (parsed.product_name ?? "").trim(),
    modelNumber: (parsed.model_number ?? "").trim(),
    inferred: true,
  };
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  return {
    brand: digits.startsWith("4") ? "（推論）日本向け製品" : "（推論）不明ブランド",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true
  };
}