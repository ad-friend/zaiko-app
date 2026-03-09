import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

const GEMINI_MODEL = "gemini-1.5-flash";
const SYSTEM_PROMPT = `あなたはJAN（EAN-13）コードから商品情報を推論する専門家です。
日本のECサイト・カタログ等の情報を元に、このJANコードに該当する商品の「ブランド名」「正確な商品名」「型番」を特定してください。
回答は以下のJSON形式のみで返し、余計な説明やマークダウンは入れないでください。
{"brand":"ブランド名","product_name":"商品名（JANコードの数字は含めない）","model_number":"型番またはSKU"}`;

/**
 * JANコードからブランド・商品名・型番を推論するAPI
 * 環境変数 GOOGLE_GENERATIVE_AI_API_KEY で Gemini API を呼び出し
 */
export async function POST(request: NextRequest) {
  try {
    const { jan } = (await request.json()) as { jan: string };
    const trimmed = String(jan ?? "").trim().replace(/\D/g, "");
    if (!trimmed) {
      return NextResponse.json(
        { error: "JANコードを指定してください" },
        { status: 400 }
      );
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (apiKey) {
      const result = await inferWithGemini(trimmed, apiKey);
      return NextResponse.json(result);
    }

    const fallback = inferHeuristic(trimmed);
    return NextResponse.json(fallback);
  } catch (e) {
    console.error("[infer-jan]", e);
    return NextResponse.json(
      { error: "推論中にエラーが発生しました" },
      { status: 500 }
    );
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: `${SYSTEM_PROMPT}\n\nJANコード: ${jan}` }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 256,
        temperature: 0.2,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  let parsed: { brand?: string; product_name?: string; model_number?: string };
  try {
    parsed = JSON.parse(text.trim()) as typeof parsed;
  } catch {
    parsed = {};
  }

  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
  };
}

function sanitizeProductText(s: string): string {
  return s
    .replace(/\d{13,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
