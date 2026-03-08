import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function GET() {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT supplier FROM inbound_headers WHERE supplier IS NOT NULL AND supplier != "" ORDER BY supplier ASC'
    );
    // 型安全のためのキャスト（実際は配列）
    const suppliers = (rows as { supplier: string }[]).map((r) => r.supplier);
    return NextResponse.json(suppliers);
  } catch (error) {
    console.error('Failed to fetch suppliers:', error);
    return NextResponse.json([], { status: 500 });
  }
}
