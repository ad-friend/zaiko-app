import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

// 3.1 Flash Lite を使用
const GEMINI_MODEL = "gemini-3.1-flash-lite";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) return NextResponse.json({ error: "JANコードを指定してください" }, { status: 400 });

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    
    // APIキーがない場合のみ、最初からバックアップを返す
    if (!apiKey) {
      console.warn("[infer-jan] APIキーが設定されていません。環境変数を確認してください。");
      return NextResponse.json(inferHeuristic(jan));
    }

    try {
      // AIでの推論を実行
      const result = await inferWithGemini(jan, apiKey);
      return NextResponse.json(result);
    } catch (geminiError) {
      // 通信失敗時のみ、バックアップを返す
      console.error("[infer-jan] Gemini API 失敗:", geminiError);
      return NextResponse.json(inferHeuristic(jan));
    }

  } catch (e) {
    console.error("[infer-jan] Fatal Error:", e);
    return NextResponse.json({ error: "エラーが発生しました" }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 修正ポイント：Google検索などの最新機能を使うため v1beta を使用
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `Google検索で最新情報を調査し、JANコード「${jan}」の商品特定をしてください。
          ブランド名、正確な商品名（容量や仕様含む）、型番を抜き出し、以下のJSON形式のみで回答してください。
          {"brand":"ブランド名","product_name":"商品名","model_number":"型番"}`
        }]
      }],
      // 修正ポイント：正式な検索ツールの指定方法
      tools: [{
        google_search_retrieval: {}
      }],
      generationConfig: {
        max_output_tokens: 512,
        temperature: 0.1
      }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`APIステータス: ${res.status}, 内容: ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  
  // JSON部分のみを抽出（改行対応の正規表現）
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
    brand: digits.startsWith("4") ? "（AI失敗）国産品" : "（AI失敗）不明ブランド",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
  };
}