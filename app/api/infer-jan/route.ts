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

// 💡 追加: 登録商品を確認（取得）するためだけの GET メソッド
export async function GET() {
  try {
    // ⚠️ 'products' の部分は実際のテーブル名に合わせてください
    const { data, error } = await supabase
      .from('products')
      .select('jan, brand, product_name, model_number')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// 👇 ここから下の POST メソッドや関数は、いただいた元のコードから一切変えていません 👇

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan = String(body.jan ?? "").trim().replace(/\D/g, "");
    
    if (!jan) return NextResponse.json({ error: "JANが必要です" }, { status: 400 });

    // spabees（登録情報）優先: products テーブルで JAN 検索し、一致すればその情報を返す
    if (supabaseUrl && supabaseKey) {
      try {
        const { data: product, error } = await supabase
          .from("products")
          .select("jan, brand, product_name, model_number")
          .eq("jan", jan)
          .maybeSingle();
        if (!error && product) {
          return NextResponse.json({
            brand: sanitizeProductText(product.brand ?? ""),
            productName: sanitizeProductText(product.product_name ?? ""),
            modelNumber: sanitizeProductText(product.model_number ?? ""),
            inferred: false,
            source: "db",
          });
        }
      } catch (dbErr) {
        console.warn("[infer-jan] spabees lookup failed, falling back to AI:", dbErr);
      }
    }

    // Step 2: 外部3社APIを順次実行し、取得できた情報をバッファに蓄積（スキップ可）
    const apiBuffer: string[] = [];
    try {
      const amazon = await fetchAmazonPaApi(jan);
      if (amazon) apiBuffer.push(`【Amazon】\n${amazon}`);
    } catch (_) { /* スキップ */ }
    try {
      const rakuten = await fetchRakuten(jan);
      if (rakuten) apiBuffer.push(`【楽天】\n${rakuten}`);
    } catch (_) { /* スキップ */ }
    try {
      const yahoo = await fetchYahooShopping(jan);
      if (yahoo) apiBuffer.push(`【Yahoo!ショッピング】\n${yahoo}`);
    } catch (_) { /* スキップ */ }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const combinedBuffer = apiBuffer.length > 0 ? apiBuffer.join("\n\n") : "";

    // Step 3: AIで精査（バッファあり）。API情報が全くない場合は空欄で返す
    if (apiKey) {
      try {
        if (combinedBuffer) {
          const result = await inferWithGeminiFromApiBuffer(jan, combinedBuffer, apiKey);
          return NextResponse.json(result);
        }
        // API情報が全く得られなかった場合: 空欄で返す
        return NextResponse.json({
          brand: "",
          productName: "",
          modelNumber: "",
          inferred: true,
          source: "ai",
        });
      } catch (geminiError: any) {
        console.error("[infer-jan] Gemini Error:", geminiError);
        return NextResponse.json({
          ...inferHeuristic(jan),
          brand: "❌ AIエラー",
          productName: `理由: ${geminiError.message}`,
          source: "ai",
        });
      }
    }

    // APIキーなし: バッファがあれば簡易抽出、なければヒューリスティック
    if (combinedBuffer) {
      const parsed = tryParseFirstLineFromBuffer(combinedBuffer);
      if (parsed) return NextResponse.json({ ...parsed, inferred: true, source: "api" as const });
    }
    return NextResponse.json({ ...inferHeuristic(jan), source: "ai" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function inferWithGemini(jan: string, apiKey: string): Promise<InferJanResponse> {
  // 3.1系プレビューモデルのため v1beta を使用
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  
  const res = await fetch(url, {
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

/** Step 3用: 複数ECサイトの情報をAIで精査・統合 */
async function inferWithGeminiFromApiBuffer(
  jan: string,
  buffer: string,
  apiKey: string
): Promise<InferJanResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
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

/** APIキーなしでバッファだけある場合の簡易抽出（最初の行の商品名など） */
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

// ----- 外部API（Step 2）: キーなし・該当なしはスキップし次へ -----
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

async function fetchYahooShopping(jan: string): Promise<string | null> {
  const appId = process.env.YAHOO_SHOPPING_APP_ID ?? process.env.YAHOO_APP_ID;
  if (!appId) return null;
  try {
    const url = `https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch?appid=${encodeURIComponent(appId)}&jan_code=${encodeURIComponent(jan)}&results=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const hits = data.hits;
    if (!Array.isArray(hits) || hits.length === 0) return null;
    const parts: string[] = [];
    for (const h of hits.slice(0, 2)) {
      if (h.name) parts.push(`商品名: ${h.name}`);
      if (h.brand?.name) parts.push(`ブランド: ${h.brand.name}`);
    }
    return parts.length ? [...new Set(parts)].join("\n") : null;
  } catch {
    return null;
  }
}

/** AWS Signature Version 4（PA-API 5.0 用） */
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

// ここから下の関数が不足していた、あるいは名前が日本語になっていたのがエラーの原因です
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