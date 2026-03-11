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
      let rows = items.map((item) => ({ ...baseRow(item), registered_at: nowIso }));
      let { error: itemsError } = await supabase.from('inbound_items').insert(rows);
      if (itemsError?.message?.includes('registered_at') || itemsError?.code === '42703') {
        rows = items.map(baseRow);
        const retry = await supabase.from('inbound_items').insert(rows);
        itemsError = retry.error;
      }

      if (itemsError) {
        console.error('Failed to save inbound items:', itemsError);
        return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, id: headerId });
  } catch (error) {
    console.error('Failed to save inbound data:', error);
    return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
  }
}
