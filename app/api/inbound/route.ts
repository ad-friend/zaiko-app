/** 入庫管理ページ（JAN主軸：入庫時にJAN→ASINをCatalog APIで取得して保存） */
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const MARKETPLACE_ID_JP = 'A1VC38T7YXB528';

function is13DigitJan(s: string): boolean {
  return /^\d{13}$/.test(String(s).trim());
}

/** Catalog Items API で JAN(EAN) から ASIN を取得 */
async function fetchAsinByJan(jan: string): Promise<string | null> {
  if (!jan || !is13DigitJan(jan)) return null;
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) return null;
  try {
    const SellingPartnerAPI = require('amazon-sp-api');
    const spClient = new SellingPartnerAPI({
      region: 'fe',
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
        AWS_ACCESS_KEY_ID: accessKey,
        AWS_SECRET_ACCESS_KEY: secretKey,
        AWS_SELLING_PARTNER_ROLE: '',
      },
    });
    const res = (await spClient.callAPI({
      operation: 'searchCatalogItems',
      endpoint: 'catalogItems',
      query: {
        marketplaceIds: [MARKETPLACE_ID_JP],
        keywords: [jan.trim()],
        includedData: ['summaries'],
      },
      options: { version: '2022-04-01' },
    })) as { items?: Array<{ asin?: string; summaries?: Array<{ asin?: string }> }> };
    const first = res?.items?.[0];
    const asin = first?.asin ?? first?.summaries?.[0]?.asin;
    if (asin && String(asin).length >= 10) return String(asin).trim();
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Item = {
  jan: string;
  brand: string;
  productName: string;
  modelNumber: string;
  condition: string;
  basePrice: number;
  fixedUnitPrice: boolean;
  effectiveUnitPrice: number;
};

type Body = {
  header: {
    purchaseDate: string;
    supplier: string;
    genre: string;
    totalPurchase: number;
    shipping: number;
    discount: number;
    totalCost: number;
  };
  items: Item[];
};

export async function POST(req: Request) {
  try {
    const { header, items }: Body = await req.json();

    // 1. ヘッダー情報の保存
    const { data: headerRow, error: headerError } = await supabase
      .from('inbound_headers')
      .insert({
        purchase_date: header.purchaseDate,
        supplier: header.supplier,
        genre: header.genre,
        total_purchase_amount: header.totalPurchase,
        shipping_cost: header.shipping,
        discount_amount: header.discount,
        total_cost: header.totalCost,
      })
      .select('id')
      .single();

    if (headerError || !headerRow) {
      console.error('Failed to save inbound header:', headerError);
      return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
    }

    const headerId = headerRow.id as number;

    // 2. 明細（商品リスト）の保存（JAN→ASIN を Catalog API で取得して asin も保存）
    if (items.length > 0) {
      const nowIso = new Date().toISOString();
      const rows: Array<Record<string, unknown>> = [];
      const uniqueJans = new Map<string, string | null>();
      for (const item of items) {
        const jan = item.jan?.trim() || '';
        const payloadAsin = (item as { asin?: string | null }).asin;
        const hasValidPayloadAsin = typeof payloadAsin === "string" && payloadAsin.trim().length >= 10;
        let asin: string | null;
        if (hasValidPayloadAsin) {
          asin = payloadAsin.trim();
        } else {
          let cachedAsin = uniqueJans.get(jan);
          if (cachedAsin === undefined) {
            cachedAsin = is13DigitJan(jan) ? await fetchAsinByJan(jan) : null;
            uniqueJans.set(jan, cachedAsin);
            if (jan && is13DigitJan(jan)) await sleep(400);
          }
          asin = cachedAsin;
        }
        rows.push({
          header_id: headerId,
          jan_code: item.jan,
          asin: asin ?? null,
          brand: item.brand,
          product_name: item.productName,
          model_number: item.modelNumber,
          condition_type: item.condition,
          base_price: item.basePrice,
          is_fixed_price: item.fixedUnitPrice,
          effective_unit_price: item.effectiveUnitPrice,
          registered_at: nowIso,
        });
      }

      // データベースに保存（1回だけ実行）
      const { error: itemsError } = await supabase.from('inbound_items').insert(rows);

      // ▼ 余計なリトライ用の if文 (itemsError?.message?.includes...) はここにありましたが、削除しました ▼

      // 保存に失敗した場合のエラーハンドリング
      if (itemsError) {
        console.error('Failed to save inbound items:', itemsError);
        return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
      }
      const masterProductsMap = new Map();
      items.forEach((item) => {
        if (item.jan && item.productName) {
          masterProductsMap.set(item.jan, {
            jan_code: item.jan.trim(),
            brand: item.brand ? item.brand.trim() : null,
            product_name: item.productName.trim(),
            model_number: item.modelNumber ? item.modelNumber.trim() : null
          });
        }
      });

      const masterProducts = Array.from(masterProductsMap.values());

      if (masterProducts.length > 0) {
        // ignoreDuplicates: true によって、すでにマスタにある商品は安全に無視されます
        const { error: masterError } = await supabase
          .from('products')
          .upsert(masterProducts, { onConflict: 'jan_code', ignoreDuplicates: true });
        
        if (masterError) {
          console.error("⚠️ マスタ自動登録エラー:", masterError.message);
        } else {
          console.log(`✅ 新商品をマスタに ${masterProducts.length} 種類 自動登録しました！`);
        }
      }
    }

    return NextResponse.json({ success: true, id: headerId });
  } catch (error) {
    console.error('Failed to save inbound data:', error);
    return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
  }
}