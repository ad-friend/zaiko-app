// app/api/infer-kana/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { text } = await request.json();
    console.log("📝 APIに届いた文字:", text);
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!text || !apiKey) return NextResponse.json({ kana: "" });

    // JANシステムと全く同じURLの叩き方
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`;
    
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `「${text}」の読み方を全角カタカナのみで回答してください。余計な説明は不要です。` }] }]
      })
    });

    const data = await res.json();
    console.log("🤖 Geminiからの返事:", JSON.stringify(data, null, 2));
    const kana = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim().replace(/[\n\r\s　]/g, "");

    return NextResponse.json({ kana });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}