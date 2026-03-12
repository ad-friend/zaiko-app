/** 入庫管理ページ */
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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

    // 2. 明細（商品リスト）の保存
    if (items.length > 0) {
      const nowIso = new Date().toISOString();
      const baseRow = (item: Item) => ({
        header_id: headerId,
        jan_code: item.jan,
        brand: item.brand,
        product_name: item.productName,
        model_number: item.modelNumber,
        condition_type: item.condition,
        base_price: item.basePrice,
        is_fixed_price: item.fixedUnitPrice,
        effective_unit_price: item.effectiveUnitPrice,
      });

      // 登録日（registered_at）を含めてデータを作成
      const rows = items.map((item) => ({ ...baseRow(item), registered_at: nowIso }));
      
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