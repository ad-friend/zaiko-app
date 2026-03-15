/**
 * 仮設：JAN 1件を受け取り AI 推測で商品情報を取得し、products に upsert する専用 API
 * 一括登録フロントから 1件ずつ呼び出す想定（外部API制限・Bot対策のためクライアント側で間隔を空ける）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

function is13DigitJan(s: string): boolean {
  return /^\d{13}$/.test(String(s).trim());
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const jan = typeof body.jan === "string" ? body.jan.trim().replace(/\D/g, "") : "";

    if (!jan || !is13DigitJan(jan)) {
      return NextResponse.json(
        { success: false, error: "有効な13桁のJANコードを指定してください。", jan: body.jan ?? null },
        { status: 400 }
      );
    }

    const origin = request.headers.get("x-forwarded-host")
      ? `${request.headers.get("x-forwarded-proto") || "https"}://${request.headers.get("x-forwarded-host")}`
      : new URL(request.url).origin;

    const inferRes = await fetch(`${origin}/api/infer-jan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jan }),
    });

    const inferData = await inferRes.json().catch(() => ({}));

    if (!inferRes.ok) {
      return NextResponse.json({
        success: false,
        error: inferData.error ?? "商品情報の取得に失敗しました。",
        jan,
      });
    }

    const productName = typeof inferData.productName === "string" ? inferData.productName.trim() : "";
    const brand = inferData.brand != null && String(inferData.brand).trim() ? String(inferData.brand).trim() : null;
    const modelNumber = inferData.modelNumber != null && String(inferData.modelNumber).trim() ? String(inferData.modelNumber).trim() : null;
    const asin = inferData.asin != null && String(inferData.asin).trim() ? String(inferData.asin).trim() : null;

    if (!productName) {
      return NextResponse.json({
        success: false,
        error: "商品名を取得できませんでした。",
        jan,
        brand: brand ?? undefined,
        modelNumber: modelNumber ?? undefined,
        asin: asin ?? undefined,
      });
    }

    const { error: upsertError } = await supabase
      .from("products")
      .upsert(
        {
          jan_code: jan,
          product_name: productName,
          brand,
          model_number: modelNumber,
          asin,
        },
        { onConflict: "jan_code" }
      );

    if (upsertError) {
      return NextResponse.json({
        success: false,
        error: upsertError.message,
        jan,
        productName,
        brand: brand ?? undefined,
        modelNumber: modelNumber ?? undefined,
        asin: asin ?? undefined,
      });
    }

    return NextResponse.json({
      success: true,
      jan,
      productName,
      brand: brand ?? undefined,
      modelNumber: modelNumber ?? undefined,
      asin: asin ?? undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "処理中にエラーが発生しました。";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
