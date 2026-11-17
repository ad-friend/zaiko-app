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
  itemKind?: string;
  partCode?: string;
  asin?: string | null;
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
    /** 相談-13：入庫待ちから呼び出したときの注文番号（任意） */
    orderNumber?: string | null;
  };
  items: Item[];
  /** 相談-13：入庫待ちから呼び出した伝票。あれば register_pending_inbound で1回の処理で登録する */
  pendingId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 相談-13：入庫待ちからの登録。ASIN の取得（外部）は DB の処理の外で先に済ませ、登録は関数1回で行う */
async function registerFromPending(pendingId: string, header: Body["header"], items: Item[]) {
  if (!UUID.test(pendingId)) {
    return NextResponse.json({ success: false, error: "入庫待ちの番号が正しくありません" }, { status: 400 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ success: false, error: "商品が1つもありません" }, { status: 400 });
  }
  const asinByJan = new Map<string, string | null>();
  const rpcItems = [];
  for (const item of items) {
    const isPart = String(item.itemKind ?? "product").trim().toLowerCase() === "part";
    const jan = item.jan?.trim() || "";
    let asin: string | null = typeof item.asin === "string" && item.asin.trim().length >= 10 ? item.asin.trim() : null;
    if (!isPart && !asin && is13DigitJan(jan)) {
      if (!asinByJan.has(jan)) {
        asinByJan.set(jan, await fetchAsinByJan(jan));
        await sleep(400);
      }
      asin = asinByJan.get(jan) ?? null;
    }
    rpcItems.push({
      jan,
      asin: isPart ? null : asin,
      brand: item.brand ?? null,
      productName: item.productName ?? null,
      modelNumber: item.modelNumber ?? null,
      condition: item.condition ?? null,
      basePrice: item.basePrice,
      fixedUnitPrice: item.fixedUnitPrice === true,
      effectiveUnitPrice: item.effectiveUnitPrice,
      itemKind: isPart ? "part" : "product",
      partCode: item.partCode ?? null,
    });
  }
  const { data, error } = await supabase.rpc("register_pending_inbound", {
    p_pending_id: pendingId,
    p_header: header,
    p_items: rpcItems,
  });
  if (error) {
    console.error("入庫待ちからの登録に失敗:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }
  return NextResponse.json({ success: true, id: Number(data) });
}

export async function POST(req: Request) {
  try {
    const { header, items, pendingId }: Body = await req.json();

    if (pendingId) {
      return await registerFromPending(String(pendingId), header, items);
    }

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

    // 2. 明細の保存（商品: JAN→ASIN / パーツ: part_code・商品マスタ非登録）
    if (items.length > 0) {
      const nowIso = new Date().toISOString();
      const rows: Array<Record<string, unknown>> = [];
      const uniqueJans = new Map<string, string | null>();
      for (const item of items) {
        const itemKind = String(item.itemKind ?? "product").trim().toLowerCase() === "part" ? "part" : "product";
        const partCode = item.partCode != null ? String(item.partCode).trim().toUpperCase() || null : null;
        const jan = item.jan?.trim() || "";

        if (itemKind === "part") {
          if (!partCode) {
            return NextResponse.json({ success: false, error: "パーツ行には partCode が必要です" }, { status: 400 });
          }
          if (!item.productName?.trim()) {
            return NextResponse.json({ success: false, error: "パーツ行には productName が必要です" }, { status: 400 });
          }
          rows.push({
            header_id: headerId,
            jan_code: jan || null,
            asin: null,
            brand: item.brand || null,
            product_name: item.productName.trim(),
            model_number: item.modelNumber || partCode,
            condition_type: item.condition || "used",
            base_price: item.basePrice,
            is_fixed_price: item.fixedUnitPrice,
            effective_unit_price: item.effectiveUnitPrice,
            registered_at: nowIso,
            item_kind: "part",
            part_code: partCode,
          });
          continue;
        }

        const payloadAsin = item.asin;
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
          item_kind: "product",
          part_code: null,
        });
      }

      // データベースに保存（1回だけ実行）
      const { error: itemsError } = await supabase.from('inbound_items').insert(rows);

      // 保存に失敗した場合のエラーハンドリング
      if (itemsError) {
        console.error('Failed to save inbound items:', itemsError);
        return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
      }
      const masterProductsMap = new Map<string, { jan_code: string; brand: string | null; product_name: string; model_number: string | null; asin: string | null }>();
      items.forEach((item) => {
        const itemKind = String(item.itemKind ?? "product").trim().toLowerCase() === "part" ? "part" : "product";
        if (itemKind === "part") return;
        if (item.jan && item.productName) {
          const jan = item.jan.trim();
          const itemAsin = item.asin;
          const asin = uniqueJans.get(jan) ?? (typeof itemAsin === "string" ? itemAsin.trim() || null : null);
          masterProductsMap.set(jan, {
            jan_code: jan,
            brand: item.brand ? item.brand.trim() : null,
            product_name: item.productName.trim(),
            model_number: item.modelNumber ? item.modelNumber.trim() : null,
            asin: asin && asin.length >= 10 ? asin : null,
          });
        }
      });

      const masterProducts = Array.from(masterProductsMap.values());

      if (masterProducts.length > 0) {
        const { error: masterError } = await supabase
          .from("products")
          .upsert(masterProducts, { onConflict: "jan_code", ignoreDuplicates: false });
        
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