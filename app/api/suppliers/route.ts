import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  try {
    const { data: rows, error } = await supabase
      .from('inbound_headers')
      .select('supplier')
      .not('supplier', 'is', null)
      .not('supplier', 'eq', '');

    if (error) {
      console.error('Failed to fetch suppliers:', error);
      return NextResponse.json([], { status: 500 });
    }

    const suppliers = [...new Set((rows || []).map((r) => r.supplier).filter(Boolean))].sort();
    return NextResponse.json(suppliers);
  } catch (error) {
    console.error('Failed to fetch suppliers:', error);
    return NextResponse.json([], { status: 500 });
  }
}
