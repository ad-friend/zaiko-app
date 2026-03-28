/** JAN自動検索プログラム (Amazon SP-API対応版) */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 💡 Supabaseの準備
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
  source?: "db" | "api" | "ai";
  /** 既存の商品情報取得API（Amazon SP-API等）の同一レスポンスから抽出したASIN。保存時に inbound_items.asin へ渡す */
  asin?: string | null;
};

const GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** Gemini / Google Generative Language API 等の非 OK レスポンスをクライアントへ返す */
class ExternalApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "ExternalApiError";
    this.httpStatus = httpStatus;
  }
}

function clientStatusFromGoogleApiHttp(status: number): number {
  if (status === 429) return 429;
  if (status === 503) return 503;
  return 500;
}

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
      console.log(`🤖 Gemini 503 → ${delay / 1000}s 後にリトライ (${attempt + 1}/${maxRetries})`);
      await sleep(delay);
      continue;
    }
    return res;
  }
  return lastRes!;
}

// 💡 登録商品を確認（取得）するためだけの GET メソッド
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('inbound_items')
      .select('jan_code, brand, product_name, model_number')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// 個別・一括更新用 PATCH（在庫一覧の編集保存）
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.items && Array.isArray(body.items)) {
      const updates = body.items.filter((item: { id?: unknown }) => item.id != null && Number(item.id) > 0);
      const inserts = body.items.filter((item: { id?: unknown }) => item.id == null || !Number(item.id));

      for (const item of updates) {
        const id = Number(item.id);
        if (!id) continue;
        const update: Record<string, unknown> = {};
        if (item.brand !== undefined) update.brand = item.brand;
        if (item.product_name !== undefined) update.product_name = item.product_name;
        if (item.model_number !== undefined) update.model_number = item.model_number;
        if (item.base_price !== undefined) update.base_price = item.base_price;
        if (item.effective_unit_price !== undefined) update.effective_unit_price = item.effective_unit_price;
        if (item.created_at !== undefined) update.created_at = item.created_at;
        if (item.condition_type !== undefined) update.condition_type = item.condition_type;
        if (item.registered_at !== undefined) update.registered_at = item.registered_at;
        if (item.asin !== undefined) update.asin = item.asin;

        if (Object.keys(update).length > 0) {
          const { error } = await supabase.from("inbound_items").update(update).eq("id", id);
          if (error) throw error;
        }

        if (item.supplier !== undefined || item.genre !== undefined) {
           const { data: currentItem } = await supabase.from("inbound_items").select("header_id").eq("id", id).single();
           if (currentItem?.header_id) {
             const headerUpdate: Record<string, unknown> = {};
             if (item.supplier !== undefined) headerUpdate.supplier = item.supplier;
             if (item.genre !== undefined) headerUpdate.genre = item.genre;
             if (Object.keys(headerUpdate).length > 0) {
               await supabase.from("inbound_headers").update(headerUpdate).eq("id", currentItem.header_id);
             }
           }
        }
      }

      if (inserts.length > 0) {
        // 1. アイテムを「仕入先」「ジャンル」「日付」でグループ化する
        const groups = new Map<string, any[]>();
        for (const item of inserts) {
          const supplier = item.supplier ?? "";
          const genre = item.genre ?? "";
          // 仕入日: created_at または registered_at があればそれを、無ければ今日をキーにする
          const dateRaw = item.created_at || item.registered_at;
          const date = dateRaw ? String(dateRaw).slice(0, 10) : new Date().toISOString().slice(0, 10);
          const key = `${supplier}|${genre}|${date}`;
          
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(item);
        }

        const allItemsToInsert = [];
        const masterProducts = [];

        // 2. グループごとにヘッダーを作成し、アイテムを紐付ける
        for (const [key, groupItems] of Array.from(groups.entries())) {
          const firstItem = groupItems[0];
          const firstDateRaw = firstItem.created_at || firstItem.registered_at;
          const purchaseDate = firstDateRaw ? String(firstDateRaw).slice(0, 10) : new Date().toISOString().slice(0, 10);
          
          const { data: headerRow, error: headerError } = await supabase
            .from("inbound_headers")
            .insert({
              purchase_date: purchaseDate,
              supplier: firstItem.supplier ?? null,
              genre: firstItem.genre ?? null,
              total_purchase_amount: 0,
              shipping_cost: 0,
              discount_amount: 0,
              total_cost: 0,
            })
            .select("id")
            .single();
            
          if (headerError || !headerRow) throw new Error(headerError?.message ?? "ヘッダー作成に失敗しました");
          
          const headerId = headerRow.id as number;
          
          // そのグループのアイテム全てに、作ったばかりのヘッダーIDをセットする
          for (const item of groupItems) {
            const c = item.created_at ? String(item.created_at) : null;
            const r = item.registered_at ? String(item.registered_at) : null;
            const createdAt = c || r || new Date().toISOString();
            const registeredAt = r || c || undefined;
            allItemsToInsert.push({
              header_id: headerId,
              jan_code: item.jan_code ?? null,
              asin: item.asin != null ? String(item.asin).trim() || null : null,
              brand: item.brand ?? null,
              product_name: item.product_name ?? null,
              model_number: item.model_number ?? null,
              condition_type: item.condition_type ?? "new",
              base_price: Number(item.base_price ?? 0),
              is_fixed_price: false,
              effective_unit_price: Number(item.effective_unit_price ?? 0),
              created_at: createdAt,
              registered_at: registeredAt,
            });

            // マスタ登録用の配列も同時に作る
            if (item.jan_code && item.product_name) {
              masterProducts.push({
                jan_code: String(item.jan_code).trim(),
                brand: item.brand ? String(item.brand).trim() : null,
                product_name: String(item.product_name).trim(),
                model_number: item.model_number ? String(item.model_number).trim() : null
              });
            }
          }
        }

        // 3. 全アイテムを一気に保存（inbound_items）
        if (allItemsToInsert.length > 0) {
          const { error: insertError } = await supabase.from("inbound_items").insert(allItemsToInsert);
          if (insertError) throw new Error(insertError.message);
        }

        // 4. 新商品を商品マスタ（products）へ自動登録
        if (masterProducts.length > 0) {
          const { error: masterError } = await supabase
            .from("products")
            .upsert(masterProducts, { onConflict: "jan_code", ignoreDuplicates: true });
          
          if (masterError) console.log("⚠️ マスタ自動登録エラー:", masterError.message);
          else console.log(`✅ 新商品をマスタに ${masterProducts.length} 件 自動登録しました！`);
        }
      }
      return NextResponse.json({ ok: true });
    }

    // 個別更新
    const id = Number(body.id);
    if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
    const update: Record<string, unknown> = {};
    if (body.brand !== undefined) update.brand = body.brand;
    if (body.product_name !== undefined) update.product_name = body.product_name;
    if (body.model_number !== undefined) update.model_number = body.model_number;
    if (body.base_price !== undefined) update.base_price = body.base_price;
    if (body.effective_unit_price !== undefined) update.effective_unit_price = body.effective_unit_price;
    if (body.created_at !== undefined) update.created_at = body.created_at;
    if (body.registered_at !== undefined) update.registered_at = body.registered_at;
    if (body.asin !== undefined) update.asin = body.asin;

    if (Object.keys(update).length > 0) {
        const { error } = await supabase.from("inbound_items").update(update).eq("id", id);
        if (error) throw error;
    }

    if (body.supplier !== undefined || body.genre !== undefined) {
        const { data: currentItem } = await supabase.from("inbound_items").select("header_id").eq("id", id).single();
        if (currentItem?.header_id) {
            const headerUpdate: Record<string, unknown> = {};
            if (body.supplier !== undefined) headerUpdate.supplier = body.supplier;
            if (body.genre !== undefined) headerUpdate.genre = body.genre;
            if (Object.keys(headerUpdate).length > 0) {
            await supabase.from("inbound_headers").update(headerUpdate).eq("id", currentItem.header_id);
            }
        }
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    console.log("=========================================");
    console.log("🚀 [infer-jan] 検索開始 | JAN:", jan);
    
    if (!jan) {
      console.log("❌ エラー: JANが入力されていません");
      return NextResponse.json({ error: "JANが必要です" }, { status: 400 });
    }

    const dbOnly = body.dbOnly === true;

    // Step 1: 自社DB (productsマスタ) で JAN 検索
    if (supabaseUrl && supabaseKey) {
      try {
        console.log("📡 Step 1: Supabase (productsマスタ) 検索中...");
        const { data: rows, error } = await supabase
          .from("products") // 🌟 inbound_items から products に変更
          .select("jan_code, brand, product_name, model_number")
          .eq("jan_code", jan)
          .limit(1);

        if (error) {
          console.log("❌ DBエラー発生:", error.message);
        } else {
          const product = rows?.[0] ?? null;
          if (product) {
            console.log("✅ マスタヒット成功! 登録情報を引用します:", product.product_name);
            if (dbOnly) console.log("✅ [dbOnly] DBで解決したため、AIは起動しません。");
            return NextResponse.json({
              brand: sanitizeProductText(product.brand ?? ""),
              productName: sanitizeProductText(product.product_name ?? ""),
              modelNumber: sanitizeProductText(product.model_number ?? ""),
              inferred: false,
              source: "db",
              isMaster: true, // 🌟 画面側でロックをかけるための目印を追加！
            });
          }
          console.log("⚠️ マスタには登録されていませんでした。外部APIへ移行します。");
        }
      } catch (dbErr) {
        console.warn("❗ DB接続例外:", dbErr);
      }
    }

    if (dbOnly) {
      console.log("📡 [dbOnly] Step 1 のみ実行 → DBにデータなし。フロントでAI起動してください。");
      return NextResponse.json({ found: false, brand: "", productName: "", modelNumber: "", inferred: false });
    }

    // Step 2: 外部3社APIを順次実行（1回の通信でテキストとASINを同時取得）
    const apiBuffer: string[] = [];
    let amazonAsin: string | null = null;
    console.log("📡 Step 2: 外部APIへの問い合わせを開始...");

    try {
      const amazonResult = await fetchAmazonSpApi(jan);
      if (amazonResult.text) {
        console.log("📦 Amazon SP-API: 取得成功");
        apiBuffer.push(`【Amazon】\n${amazonResult.text}`);
      } else {
        console.log("📦 Amazon SP-API: データなし");
      }
      if (amazonResult.asin) amazonAsin = amazonResult.asin;
    } catch (e: any) {
      console.log("📦 Amazon SP-API: エラーによりスキップ", e.message);
    }

    try {
      const rakuten = await fetchRakuten(jan);
      if (rakuten) {
        console.log("📦 楽天: 取得成功");
        apiBuffer.push(`【楽天】\n${rakuten}`);
      } else {
        console.log("📦 楽天: データなし");
      }
    } catch (_) { console.log("📦 楽天: エラーによりスキップ"); }

    try {
      const yahoo = await fetchYahooShopping(jan);
      if (yahoo) {
        console.log("📦 Yahoo!: 取得成功");
        apiBuffer.push(`【Yahoo!ショッピング】\n${yahoo}`);
      } else {
        console.log("📦 Yahoo!: データなし");
      }
    } catch (_) { console.log("📦 Yahoo!: エラーによりスキップ"); }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const combinedBuffer = apiBuffer.length > 0 ? apiBuffer.join("\n\n") : "";

    // Step 3: AIで精査（レスポンスにASINを含める）
    if (apiKey) {
      try {
        if (combinedBuffer) {
          console.log("🤖 Step 3: API情報を元にAIが情報を統合・抽出中...");
          const result = await inferWithGeminiFromApiBuffer(jan, combinedBuffer, apiKey);
          console.log("✅ AI統合完了:", result.productName);
          return NextResponse.json({ ...result, asin: amazonAsin ?? undefined });
        }

        console.log("🤖 Step 3: API情報がないため、空欄を返します。");
        return NextResponse.json({ brand: "", productName: "", modelNumber: "", inferred: true, source: "ai", asin: amazonAsin ?? undefined });
      } catch (geminiError: unknown) {
        console.error("❌ Gemini Error:", geminiError);
        if (geminiError instanceof ExternalApiError) {
          return NextResponse.json(
            { error: geminiError.message },
            { status: geminiError.httpStatus }
          );
        }
        const message =
          geminiError instanceof Error ? geminiError.message : "AI処理でエラーが発生しました";
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    console.log("⚠️ APIキー未設定のため、ヒューリスティックで回答します。");
    if (combinedBuffer) {
      const parsed = tryParseFirstLineFromBuffer(combinedBuffer);
      if (parsed) return NextResponse.json({ ...parsed, inferred: true, source: "api" as const, asin: amazonAsin ?? undefined });
    }
    return NextResponse.json({ ...inferHeuristic(jan), source: "ai", asin: amazonAsin ?? undefined });
  } catch (e: any) {
    console.error("🚨 致命的な例外が発生しました:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    console.log("=========================================");
  }
}

/** 既存の1回のSP-API呼び出しの戻り値からテキストとASINを同時に返す（追加のAPI通信なし） */
async function fetchAmazonSpApi(jan: string): Promise<{ text: string | null; asin: string | null }> {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;

  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) {
    console.log("⚠️ SP-APIの認証情報が.env.localに不足しています。");
    return { text: null, asin: null };
  }

  try {
    const SellingPartnerAPI = require("amazon-sp-api");
    const spClient = new SellingPartnerAPI({
      region: "fe",
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: secretKey,
        AWS_SELLING_PARTNER_ROLE: "",
      },
    });

    const res = await spClient.callAPI({
      operation: "searchCatalogItems",
      endpoint: "catalogItems",
      query: {
        keywords: [jan],
        marketplaceIds: ["A1VC38T7YXB528"],
        includedData: ["summaries"],
      },
    });

    const items = res.items;
    if (!items || items.length === 0) return { text: null, asin: null };

    const topItem = items[0] as { asin?: string; summaries?: Array<{ asin?: string; itemName?: string; brand?: string; partNumber?: string }> };
    const asin =
      topItem?.asin ?? topItem?.summaries?.[0]?.asin
        ? String(topItem.asin ?? topItem.summaries?.[0]?.asin ?? "").trim()
        : null;
    const validAsin = asin && asin.length >= 10 ? asin : null;

    const parts: string[] = [];
    const title = topItem.summaries?.[0]?.itemName;
    if (title) parts.push(`商品名: ${title}`);
    const brand = topItem.summaries?.[0]?.brand;
    if (brand) parts.push(`ブランド: ${brand}`);
    const partNumber = topItem.summaries?.[0]?.partNumber;
    if (partNumber) parts.push(`型番: ${partNumber}`);

    return { text: parts.length ? parts.join("\n") : null, asin: validAsin };
  } catch (error: any) {
    console.error("❌ SP-API 呼び出しエラー詳細:", error.response?.data || error.message);
    throw new Error(`Amazon SP-API エラー: ${error.message}`);
  }
}

async function fetchRakuten(jan: string): Promise<string | null> {
  const appId = process.env.RAKUTEN_APPLICATION_ID;
  if (!appId) return null;
  try {
    const url = `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706?applicationId=${encodeURIComponent(appId)}&itemCode=${encodeURIComponent(jan)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.Items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const item = items[0].Item ?? items[0];
    const parts: string[] = [];
    if (item.itemName) parts.push(`商品名: ${item.itemName}`);
    if (item.brandName) parts.push(`ブランド: ${item.brandName}`);
    if (item.itemCaption) parts.push(`説明: ${String(item.itemCaption).slice(0, 300)}`);
    return parts.length ? parts.join("\n") : null;
  } catch {
    return null;
  }
}

async function fetchYahooShopping(jan: string): Promise<string | null> {
  const appId = process.env.YAHOO_SHOPPING_APP_ID ?? process.env.YAHOO_APP_ID;
  console.log("🔍 [Yahoo Debug] App ID 読み込み確認:", appId ? "OK" : "NG (空っぽです)");
  if (!appId) return null;
  
  try {
    const url = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&jan_code=${encodeURIComponent(jan)}&results=5`;
    const res = await fetch(url);
    console.log("🔍 [Yahoo Debug] HTTPステータス:", res.status);

    if (!res.ok) {
      const errorText = await res.text();
      console.log("❌ [Yahoo Debug] エラーレスポンス:", errorText);
      return null;
    }

    const data = await res.json();
    const hits = data.hits;
    if (!Array.isArray(hits) || hits.length === 0) {
      console.log("⚠️ [Yahoo Debug] 検索は成功しましたが、該当商品が0件でした");
      return null;
    }

    console.log(`🔍 [Yahoo Debug] 取得できた件数: ${hits.length}件`);
    const parts: string[] = [];
    for (const h of hits.slice(0, 5)) {
      if (h.name) parts.push(`商品名: ${h.name}`);
      if (h.brand?.name) parts.push(`ブランド: ${h.brand.name}`);
    }
    return parts.length ? [...new Set(parts)].join("\n") : null;
  } catch (e: any) {
    console.log("❌ [Yahoo Debug] プログラム実行エラー:", e.message);
    return null;
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWith503Retry(url, {
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
      generationConfig: { max_output_tokens: 512, temperature: 0.1 }
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ExternalApiError(
      `Google API (${res.status}): ${errText.slice(0, 500)}`,
      clientStatusFromGoogleApiHttp(res.status)
    );
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};

  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
    source: "ai",
  };
}

async function inferWithGeminiFromApiBuffer(
  jan: string,
  buffer: string,
  apiKey: string
): Promise<InferJanResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchWith503Retry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [{
          text: `あなたは商品情報を整理する専門家です。JANコード「${jan}」について、複数のECサイトから得た以下の断片的な情報を整理し、最も正確で適切な「ブランド名」「商品名」「型番」を抽出・推論してください。
必ず以下のJSON形式のみで回答し、余計な説明は含めないでください。不明な項目は空文字にしてください。
{"brand":"ブランド名","product_name":"商品名","model_number":"型番"}

--- ECサイトから得た情報 ---
${buffer}`
        }]
      }],
      generationConfig: { max_output_tokens: 512, temperature: 0.1 }
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new ExternalApiError(
      `Google API (${res.status}): ${errText.slice(0, 500)}`,
      clientStatusFromGoogleApiHttp(res.status)
    );
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = match ? JSON.parse(match[0]) : {};
  return {
    brand: sanitizeProductText(parsed.brand ?? ""),
    productName: sanitizeProductText(parsed.product_name ?? ""),
    modelNumber: sanitizeProductText(parsed.model_number ?? ""),
    inferred: true,
    source: "api",
  };
}

function tryParseFirstLineFromBuffer(buffer: string): InferJanResponse | null {
  const lines = buffer.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const firstTitle = lines.find((l) => /商品名|タイトル|title|itemName|name/i.test(l) && l.length < 200);
  if (!firstTitle) return null;
  const productName = firstTitle.replace(/^(商品名|タイトル|title|itemName|name)[:\s]*/i, "").trim();
  if (!productName) return null;
  return {
    brand: "",
    productName: sanitizeProductText(productName),
    modelNumber: "",
    inferred: true,
    source: "api",
  };
}

function sanitizeProductText(s: string): string {
  return String(s).replace(/\d{13,}/g, "").replace(/\s+/g, " ").trim();
}

function inferHeuristic(jan: string): InferJanResponse {
  const digits = jan.replace(/\D/g, "");
  return {
    brand: digits.startsWith("4") ? "（推論）国産品" : "（推論）不明",
    productName: `商品 ${digits.slice(-6)}`,
    modelNumber: `JAN-${digits.slice(-6)}`,
    inferred: true,
    source: "ai",
  };
}