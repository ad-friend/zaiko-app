import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 1. モデル名のみ変更（ご指摘のプレビュー版ID）
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
        // エラー内容を画面で確認できるように戻します
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
  // 2. 通信先のみ変更（プレビュー版モデルを叩くためのbetaエンドポイント）
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
      // 2.5で動いていた時と同じ設定
      generationConfig: { max_output_tokens: 512, temperature: 0.1 }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google API (${res.status}): ${errText.slice(0, 100)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // 正規表現もビルドエラーが出ない安全な書き方のまま
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
  };
}