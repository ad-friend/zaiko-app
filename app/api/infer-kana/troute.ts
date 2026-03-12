import { NextRequest, NextResponse } from "next/server";

// 💡 JAN検索と同じモデルとリトライ設定を使用
const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWith503Retry(
  url: string,
  options: RequestInit,
  maxRetries = 5
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options);
    lastRes = res;
    if (res.status === 503 && attempt < maxRetries - 1) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 16000;
      await sleep(delay);
      continue;
    }
    return res;
  }
  return lastRes!;
}

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!text) return NextResponse.json({ kana: "" });
    if (!apiKey) throw new Error("APIキーが設定されていません");

    console.log(`🤖 AIフリガナ推論開始: ${text}`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    
    const res = await fetchWith503Retry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `あなたは日本語のフリガナを抽出する専門家です。
            以下のテキストの「読み方」を特定し、全角カタカナのみで回答してください。
            
            ルール:
            - 全角カタカナ以外は一切出力しないこと
            - 余計な説明（「読み方は〜です」など）は含めないこと
            - 株式会社などの法人は略さず「カブシキガイシャ」等にすること
            
            対象テキスト: ${text}`
          }]
        }],
        generationConfig: { max_output_tokens: 100, temperature: 0.1 }
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google API Error: ${res.status}`);
    }

    const data = await res.json();
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    
    // 改行や空白、全角スペースを排除して純粋なカタカナのみにする
    const kana = aiText.trim().replace(/[\n\r\s　]/g, "");

    console.log(`✅ 推論結果: ${kana}`);
    return NextResponse.json({ kana });

  } catch (e: any) {
    console.error("🚨 フリガナ推論例外:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}