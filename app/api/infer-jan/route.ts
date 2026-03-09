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
    if (!jan) return NextResponse.json({ error: "JANが必要です" }, { status: 400 });

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError: any) {
        console.error("[infer-jan] Gemini Error:", geminiError);
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          // 検索を促すプロンプトに調整
          text: `Google検索でJANコード「${jan}」の最新の商品情報を調査し、特定してください。必ず以下のJSON形式のみで回答してください。{"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      // 💡 ここが精度アップの鍵（Google検索ツールの追加）
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 }
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