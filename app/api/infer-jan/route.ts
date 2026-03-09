import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
  debug?: any; // 原因特定用のデバッグ情報
};

// 3.1 Flash Lite を指定
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
      } catch (e: any) {
        // AI失敗時に、エラー内容を画面に表示させるようにしました
        return NextResponse.json({
          ...inferHeuristic(jan),
          brand: "⚠️ AI接続エラー",
          productName: e.message // ここに「model not found」などの理由が出ます
        });
      }
    }
    return NextResponse.json(inferHeuristic(jan));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 3.1系を確実に叩くため v1beta を使用
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `JANコード「${jan}」の商品情報を特定してください。JSON形式のみで回答。 {"brand":"...","product_name":"...","model_number":"..."}`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        // JSONモードを明示的に指定（3.1系で推奨される設定）
        response_mime_type: "application/json"
      }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google APIエラー (${res.status}): ${errText.slice(0, 100)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text);

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
    brand: "（推論）国産品",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}