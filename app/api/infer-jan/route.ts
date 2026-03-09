import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 1分間に15回使える 3.1 Flash Lite を指定
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    // AIでの推論を試みる
    if (apiKey) {
      try {
        const result = await inferWithGemini(jan, apiKey);
        return NextResponse.json(result);
      } catch (geminiError: any) {
        // ⚠️ ここがデバッグのキモです
        // AIが失敗したら、商品名のところにエラーの内容を書き込みます
        return NextResponse.json({
          ...inferHeuristic(jan),
          brand: "❌ AIエラー発生",
          productName: `理由: ${geminiError.message}`, // ここに「404 Not Found」などが出ます
          inferred: true
        });
      }
    }

    return NextResponse.json(inferHeuristic(jan));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 3.1系でエラーが出る場合は、この v1beta というエンドポイントが解決策になることが多いです
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `JANコード「${jan}」のブランド名、商品名、型番を特定してください。
          必ず以下のJSON形式でのみ回答してください。余計な説明は不要です。
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
    // ここでGoogleからのエラーをキャッチして上に投げます
    throw new Error(`Google API (${res.status}): ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // JSON部分を安全に抽出（正規表現のフラグを使わないビルドエラー対策版）
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: sanitize(parsed.brand || ""),
    productName: sanitize(parsed.product_name || ""),
    modelNumber: sanitize(parsed.model_number || ""),
    inferred: true,
  };
}

// 以前省いたクリーニング処理も復活させました
function sanitize(s: string): string {
  return String(s).replace(/\d{13,}/g, "").replace(/\s+/g, " ").trim();
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  return {
    brand: digits.startsWith("4") ? "（推論）国産品" : "（推論）不明ブランド",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}