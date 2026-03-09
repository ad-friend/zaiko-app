import { NextRequest, NextResponse } from "next/server";

// 戻り値の型を明確に定義してビルドエラーを防ぐ
export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

const GEMINI_MODEL = "gemini-2.0-flash";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) {
      return NextResponse.json({ error: "JANコードが必要です" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      // APIキーがない場合はバックアップ（推論）へ
      return NextResponse.json(inferHeuristic(jan));
    }

    const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `JANコード「${jan}」の商品情報を特定し、以下のJSON形式のみで返してください。解説は不要です。
            {"brand": "ブランド名", "product_name": "商品名", "model_number": "型番"}`
          }]
        }],
        generationConfig: {
          max_output_tokens: 512,
          temperature: 0.1
        }
      }),
    });

    if (!res.ok) throw new Error("API通信エラー");

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const match = text.match(/\{.*\}/s);
    const parsed = match ? JSON.parse(match[0]) : {};

    const response: InferJanResponse = {
      brand: String(parsed.brand ?? "").trim(),
      productName: String(parsed.product_name ?? "").trim(),
      modelNumber: String(parsed.model_number ?? "").trim(),
      inferred: true
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error("[infer-jan] Error:", error);
    // 何かあっても絶対にアプリを止めないよう、空のデータを返す
    return NextResponse.json({ brand: "", productName: "", modelNumber: "", inferred: false });
  }
}

function inferHeuristic(jan: string): InferJanResponse {
  return {
    brand: "（自動推論中）",
    productName: `商品 ${jan.slice(-6)}`,
    modelNumber: `JAN-${jan.slice(-6)}`,
    inferred: true
  };
}