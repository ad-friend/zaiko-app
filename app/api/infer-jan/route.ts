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
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    try {
      if (!apiKey) throw new Error("APIキーがVercelに設定されていません");

      // 最新モデルを叩くためのエンドポイントURL
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
      
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `JAN:${jan}の商品情報をJSON形式で。{"brand":"..","product_name":"..","model_number":".."}` }] }]
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Googleエラー(${res.status}): ${errBody.slice(0, 100)}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");

      return NextResponse.json({
        brand: parsed.brand || "不明",
        productName: parsed.product_name || "不明",
        modelNumber: parsed.model_number || "不明",
        inferred: true
      });

    } catch (e: any) {
      // ⚠️ ここがポイント：エラー内容を商品名に詰め込んで画面に出す
      return NextResponse.json({
        brand: "❌ AIエラー",
        productName: `理由: ${e.message}`, 
        modelNumber: "ERROR",
        inferred: true
      });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
