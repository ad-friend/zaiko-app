import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

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
  const connection = await pool.getConnection();

  try {
    const { header, items }: Body = await req.json();

    // トランザクション開始
    await connection.beginTransaction();

    // 1. ヘッダー情報の保存
    const [headerResult] = await connection.execute<any>(
      `INSERT INTO inbound_headers 
       (purchase_date, supplier, genre, total_purchase_amount, shipping_cost, discount_amount, total_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        header.purchaseDate,
        header.supplier,
        header.genre,
        header.totalPurchase,
        header.shipping,
        header.discount,
        header.totalCost,
      ]
    );

    const headerId = headerResult.insertId;

    // 2. 明細（商品リスト）の保存
    if (items.length > 0) {
      // プレースホルダを作成: (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) をアイテム数分連結
      const placeholders = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      const values = items.flatMap((item) => [
        headerId,
        item.jan,
        item.brand,
        item.productName,
        item.modelNumber,
        item.condition,
        item.basePrice,
        item.fixedUnitPrice ? 1 : 0,
        item.effectiveUnitPrice,
        new Date() // created_at
      ]);

      await connection.execute(
        `INSERT INTO inbound_items 
         (header_id, jan_code, brand, product_name, model_number, condition_type, base_price, is_fixed_price, effective_unit_price, created_at)
         VALUES ${placeholders}`,
        values
      );
    }

    // コミット
    await connection.commit();

    return NextResponse.json({ success: true, id: headerId });
  } catch (error) {
    // ロールバック
    await connection.rollback();
    console.error('Failed to save inbound data:', error);
    return NextResponse.json({ success: false, error: 'Database Error' }, { status: 500 });
  } finally {
    connection.release();
  }
}
