import { NextRequest, NextResponse } from "next/server";

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
};

/**
 * JANコードからブランド・商品名・型番を推論するAPI
 * 環境変数 OPENAI_API_KEY が設定されていればLLMで推論、未設定ならヒューリスティックで提案
 */
export async function POST(request: NextRequest) {
  try {
    const { jan } = (await request.json()) as { jan: string };
    const trimmed = String(jan ?? "").trim();
    if (!trimmed) {
      return NextResponse.json(
        { error: "JANコードを指定してください" },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      const result = await inferWithLLM(trimmed, apiKey);
      return NextResponse.json(result);
    }

    // 未設定時: ヒューリスティックで推論（LLM風の提案）
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

async function inferWithLLM(jan: string, apiKey: string): Promise<InferJanResponse> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `あなたはJAN（EAN-13）コードから商品情報を推論する専門家です。
入力はJANコード（13桁の数字）のみです。
以下のJSON形式のみで回答し、余計な説明は入れないでください。
{"brand":"ブランド名","productName":"商品名（JANコードの数字は含めない）","modelNumber":"型番またはSKU"}`,
        },
        {
          role: "user",
          content: jan,
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 200,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { brand?: string; productName?: string; modelNumber?: string };
  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.productName ?? ""),
    modelNumber: sanitizeProductText(parsed.modelNumber ?? ""),
    inferred: true,
  };
}

/** 商品名にJAN（数字のみ）が含まれないようにクレンジング */
function sanitizeProductText(s: string): string {
  return s
    .replace(/\d{13,}/g, "") // 13桁以上の数字を除去
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
