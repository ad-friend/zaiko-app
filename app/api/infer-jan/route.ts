/** JAN自動検索プログラム*/
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHmac, createHash } from "crypto";

// 💡 追加: Supabaseの準備
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

export type InferJanResponse = {
  brand: string;
  productName: string;
  modelNumber: string;
  inferred: boolean;
  source?: "db" | "api" | "ai";
};

// 1. モデル名はご指摘のプレビュー版を使用
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
      console.log(`🤖 Gemini 503 → ${delay / 1000}s 後にリトライ (${attempt + 1}/${maxRetries})`);
      await sleep(delay);
      continue;
    }
    return res;
  }
  return lastRes!;
}

// 💡 追加: 登録商品を確認（取得）するためだけの GET メソッド
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

        if (Object.keys(update).length > 0) {
          const { error } = await supabase
            .from("inbound_items")
            .update(update)
            .eq("id", id);
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
        const today = new Date().toISOString().slice(0, 10);
        const { data: headerRow, error: headerError } = await supabase
          .from("inbound_headers")
          .insert({
            purchase_date: today,
            supplier: inserts[0]?.supplier ?? null,
            genre: inserts[0]?.genre ?? null,
            total_purchase_amount: 0,
            shipping_cost: 0,
            discount_amount: 0,
            total_cost: 0,
          })
          .select("id")
          .single();
        if (headerError || !headerRow) throw new Error(headerError?.message ?? "ヘッダー作成に失敗しました");
        const headerId = headerRow.id as number;
        const rows = inserts.map((item: Record<string, unknown>) => ({
          header_id: headerId,
          jan_code: item.jan_code ?? null,
          brand: item.brand ?? null,
          product_name: item.product_name ?? null,
          model_number: item.model_number ?? null,
          condition_type: item.condition_type ?? "new",
          base_price: Number(item.base_price ?? 0),
          is_fixed_price: false,
          effective_unit_price: Number(item.effective_unit_price ?? 0),
          created_at: item.created_at ? String(item.created_at) : new Date().toISOString(),
        }));
        const { error: insertError } = await supabase.from("inbound_items").insert(rows);
        if (insertError) throw new Error(insertError.message);
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

    if (Object.keys(update).length > 0) {
        const { error } = await supabase
        .from("inbound_items")
        .update(update)
        .eq("id", id);
        if (error) throw error;
    }

    // header情報の更新 (supplier, genre)
    if (body.supplier !== undefined || body.genre !== undefined) {
        // item.id から header_id を取得
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
    
    // 💡 ログ追加：処理の開始を記録
    console.log("=========================================");
    console.log("🚀 [infer-jan] 検索開始 | JAN:", jan);
    
    if (!jan) {
      console.log("❌ エラー: JANが入力されていません");
      return NextResponse.json({ error: "JANが必要です" }, { status: 400 });
    }

    const dbOnly = body.dbOnly === true;

    // Step 1: 自社DB (inbound_items) で JAN 検索（同一JAN複数時は最新1件のみ取得）
    if (supabaseUrl && supabaseKey) {
      try {
        console.log("📡 Step 1: Supabase (inbound_itemsテーブル) 検索中...");
        const { data: rows, error } = await supabase
          .from("inbound_items")
          .select("jan_code, brand, product_name, model_number")
          .eq("jan_code", jan)
          .order("created_at", { ascending: false })
          .limit(1);

        if (error) {
          console.log("❌ DBエラー発生:", error.message);
        } else {
          const product = rows?.[0] ?? null;
          if (product) {
          console.log("✅ DBヒット成功! 登録情報を引用します:", product.product_name);
          if (dbOnly) {
            console.log("✅ [dbOnly] DBで解決したため、AIは起動しません。");
          }
          return NextResponse.json({
            brand: sanitizeProductText(product.brand ?? ""),
            productName: sanitizeProductText(product.product_name ?? ""),
            modelNumber: sanitizeProductText(product.model_number ?? ""),
            inferred: false,
            source: "db",
          });
          }
          console.log("⚠️ DBには登録されていませんでした。外部APIへ移行します。");
        }
      } catch (dbErr) {
        console.warn("❗ DB接続例外:", dbErr);
      }
    }

    // dbOnly の場合は DB にデータがなかったことを返し、AI は起動しない（フロントで後からフル検索を呼ぶ）
    if (dbOnly) {
      console.log("📡 [dbOnly] Step 1 のみ実行 → DBにデータなし。フロントでAI起動してください。");
      return NextResponse.json({
        found: false,
        brand: "",
        productName: "",
        modelNumber: "",
        inferred: false,
      });
    }

    // Step 2: 外部3社APIを順次実行し、取得できた情報をバッファに蓄積（スキップ可）
    const apiBuffer: string[] = [];
    console.log("📡 Step 2: 外部3社APIへの問い合わせを開始...");

    try {
      const amazon = await fetchAmazonPaApi(jan);
      if (amazon) {
        console.log("📦 Amazon: 取得成功");
        apiBuffer.push(`【Amazon】\n${amazon}`);
      } else {
        console.log("📦 Amazon: データなし");
      }
    } catch (_) { console.log("📦 Amazon: エラーによりスキップ"); }

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

    // Step 3: AIで精査（バッファあり）。API情報が全くない場合は空欄で返す
    if (apiKey) {
      try {
        if (combinedBuffer) {
          console.log("🤖 Step 3: API情報を元にAIが情報を統合・抽出中...");
          const result = await inferWithGeminiFromApiBuffer(jan, combinedBuffer, apiKey);
          console.log("✅ AI統合完了:", result.productName);
          return NextResponse.json(result);
        }
        
        console.log("🤖 Step 3: API情報がないため、空欄を返します。");
        return NextResponse.json({
          brand: "",
          productName: "",
          modelNumber: "",
          inferred: true,
          source: "ai",
        });
      } catch (geminiError: any) {
        console.error("❌ Gemini Error:", geminiError);
        return NextResponse.json({
          ...inferHeuristic(jan),
          brand: "❌ AIエラー",
          productName: `理由: ${geminiError.message}`,
          source: "ai",
        });
      }
    }

    console.log("⚠️ APIキー未設定のため、ヒューリスティックで回答します。");
    if (combinedBuffer) {
      const parsed = tryParseFirstLineFromBuffer(combinedBuffer);
      if (parsed) return NextResponse.json({ ...parsed, inferred: true, source: "api" as const });
    }
    return NextResponse.json({ ...inferHeuristic(jan), source: "ai" });
  } catch (e: any) {
    console.error("🚨 致命的な例外が発生しました:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    console.log("=========================================");
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
    throw new Error(`Google API (${res.status}): ${errText.slice(0, 100)}`);
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
    throw new Error(`Google API (${res.status}): ${errText.slice(0, 100)}`);
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

async function fetchAmazonPaApi(jan: string): Promise<string | null> {
  const accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY ?? process.env.AMAZON_ACCESS_KEY;
  const secretKey = process.env.AMAZON_PAAPI_SECRET_KEY ?? process.env.AMAZON_SECRET_KEY;
  const partnerTag = process.env.AMAZON_PAAPI_PARTNER_TAG ?? process.env.AMAZON_PARTNER_TAG;
  if (!accessKey || !secretKey || !partnerTag) return null;
  try {
    const body = JSON.stringify({
      ItemIds: [jan],
      ItemIdType: "EAN",
      PartnerTag: partnerTag,
      Marketplace: "www.amazon.co.jp",
      Resources: ["ItemInfo.Title", "ItemInfo.ByLineInfo", "ItemInfo.Features"],
    });
    const host = "webservices.amazon.co.jp";
    const path = "/paapi5/getitems";
    const region = "us-west-2";
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const req = await signAwsSigV4("POST", host, path, region, "ProductAdvertisingAPI", body, accessKey, secretKey, amzDate);
    const res = await fetch(`https://${host}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Amz-Date": amzDate,
        "X-Amz-Target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
        "Host": host,
        "Authorization": req.headers.Authorization,
      },
      body,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.ItemsResult?.Items?.[0];
    if (!item) return null;
    const parts: string[] = [];
    const title = item.ItemInfo?.Title?.DisplayValue;
    if (title) parts.push(`商品名: ${title}`);
    const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue;
    if (brand) parts.push(`ブランド: ${brand}`);
    const features = item.ItemInfo?.Features?.DisplayValues;
    if (Array.isArray(features) && features.length) parts.push(`特徴: ${features.join(" ")}`);
    return parts.length ? parts.join("\n") : null;
  } catch {
    return null;
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

// 💡 一時的なデバッグ版（犯人特定用）
async function fetchYahooShopping(jan: string): Promise<string | null> {
  const appId = process.env.YAHOO_SHOPPING_APP_ID ?? process.env.YAHOO_APP_ID;
  
  // 💡 ここで環境変数が本当に読み込めているかチェック！
  console.log("🔍 [Yahoo Debug] App ID 読み込み確認:", appId ? "OK" : "NG (空っぽです)");
  
  if (!appId) return null;
  
  try {
    const url = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&jan_code=${encodeURIComponent(jan)}&results=5`;
    const res = await fetch(url);
    
    // 💡 Yahooから返ってきたHTTPステータス（200なら成功）
    console.log("🔍 [Yahoo Debug] HTTPステータス:", res.status);

    if (!res.ok) {
      // 💡 エラーだった場合、Yahooが言っている本当の文句を出力
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

    // 💡 無事に5件取得できたか確認
    console.log(`🔍 [Yahoo Debug] 取得できた件数: ${hits.length}件`);

    const parts: string[] = [];
    for (const h of hits.slice(0, 5)) {
      if (h.name) parts.push(`商品名: ${h.name}`);
      if (h.brand?.name) parts.push(`ブランド: ${h.brand.name}`);
    }
    return parts.length ? [...new Set(parts)].join("\n") : null;
  } catch (e: any) {
    // 💡 fetch自体の失敗（ネットワークエラー等）
    console.log("❌ [Yahoo Debug] プログラム実行エラー:", e.message);
    return null;
  }
}
async function signAwsSigV4(
  method: string,
  host: string,
  path: string,
  region: string,
  service: string,
  body: string,
  accessKey: string,
  secretKey: string,
  amzDate: string
): Promise<{ headers: { Authorization: string } }> {
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalUri = path || "/";
  const canonicalQuerystring = "";
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems\n`;
  const signedHeaders = "content-type;host;x-amz-date;x-amz-target";
  const payloadHash = sha256HexSync(body);
  const canonicalRequest = [method, canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const stringToSign = [algorithm, amzDate, credentialScope, sha256HexSync(canonicalRequest)].join("\n");
  const kSecret = Buffer.from(`AWS4${secretKey}`, "utf8");
  const kDate = createHmac("sha256", kSecret).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { Authorization: authorization } };
}

function sha256HexSync(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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