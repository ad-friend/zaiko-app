/** 商品マスター */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type ProductRow = {
  jan_code: string;
  brand: string | null;
  product_name: string;
  model_number: string | null;
  created_at: string;
  /** GET レスポンスでは inbound_items から算出した有効在庫数（未販売・未調整） */
  current_stock: number;
};

/** 未販売・未調整: settled_at / exit_type が NULL または空文字の inbound_items を JAN ごとに数える */
const ACTIVE_STOCK_SETTLED_OR = 'settled_at.is.null,settled_at.eq.""';
const ACTIVE_STOCK_EXIT_OR = 'exit_type.is.null,exit_type.eq.""';

async function countActiveStockByJan(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("jan_code")
      .or(ACTIVE_STOCK_SETTLED_OR)
      .or(ACTIVE_STOCK_EXIT_OR)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const key = row.jan_code == null ? "" : String(row.jan_code).trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return counts;
}

async function countActiveStockForJan(jan: string): Promise<number> {
  const { count, error } = await supabase
    .from("inbound_items")
    .select("*", { count: "exact", head: true })
    .eq("jan_code", jan)
    .or(ACTIVE_STOCK_SETTLED_OR)
    .or(ACTIVE_STOCK_EXIT_OR);
  if (error) throw error;
  return count ?? 0;
}

/** GET: 一覧 または ?jan= でJANコード検索（1件） */
export async function GET(request: NextRequest) {
  try {
    const jan = request.nextUrl.searchParams.get("jan")?.trim();
    if (jan) {
      const { data, error } = await supabase.from("products").select("*").eq("jan_code", jan).maybeSingle();
      if (error) throw error;
      if (!data) return NextResponse.json(null);
      const computed = await countActiveStockForJan(jan);
      return NextResponse.json({ ...data, current_stock: computed });
    }
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("product_name", { ascending: true })
      .limit(50000);
    if (error) throw error;
    const rows = data ?? [];
    const stockByJan = await countActiveStockByJan();
    const enriched = rows.map((p: Record<string, unknown>) => {
      const jc = String(p.jan_code ?? "").trim();
      return { ...p, current_stock: stockByJan.get(jc) ?? 0 };
    });
    return NextResponse.json(enriched);
  } catch (e: any) {
    if (e.code === "42P01" || e.message?.includes("does not exist")) {
      return NextResponse.json([]);
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST: 新規登録 or 一括（CSV取込用 body.rows） */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // 一括登録（CSVインポート）
    if (Array.isArray(body.rows)) {
      const rows = body.rows as Record<string, unknown>[];
      const payload = rows
        .map((r) => {
          const jan_code = String(r.jan_code ?? "").trim();
          const product_name = String(r.product_name ?? "").trim();
          if (!jan_code || !product_name) return null;
          return {
            jan_code,
            brand: r.brand != null && String(r.brand).trim() ? String(r.brand).trim() : null,
            product_name,
            model_number: r.model_number != null && String(r.model_number).trim() ? String(r.model_number).trim() : null,
          };
        })
        .filter(Boolean) as { jan_code: string; brand: string | null; product_name: string; model_number: string | null }[];
      if (payload.length === 0) return NextResponse.json({ error: "有効な行がありません" }, { status: 400 });
      const { error } = await supabase.from("products").upsert(payload, { onConflict: "jan_code" });
      if (error) throw error;
      return NextResponse.json({ ok: true, count: payload.length });
    }

    // 単一登録
    const jan_code = String(body.jan_code ?? "").trim();
    const product_name = String(body.product_name ?? "").trim();
    if (!jan_code || !product_name) return NextResponse.json({ error: "JANコードと商品名は必須です" }, { status: 400 });
    const { data, error } = await supabase
      .from("products")
      .insert({
        jan_code,
        brand: body.brand != null && String(body.brand).trim() ? String(body.brand).trim() : null,
        product_name,
        model_number: body.model_number != null && String(body.model_number).trim() ? String(body.model_number).trim() : null,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** PATCH: 更新（主キー jan_code） */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const jan_code = String(body.jan_code ?? "").trim();
    if (!jan_code) return NextResponse.json({ error: "jan_codeが必要です" }, { status: 400 });
    const update: Record<string, unknown> = {};
    if (body.brand !== undefined) update.brand = body.brand != null && String(body.brand).trim() ? String(body.brand).trim() : null;
    if (body.product_name !== undefined) {
      const pn = String(body.product_name).trim();
      if (!pn) return NextResponse.json({ error: "商品名は必須です" }, { status: 400 });
      update.product_name = pn;
    }
    if (body.model_number !== undefined) update.model_number = body.model_number != null && String(body.model_number).trim() ? String(body.model_number).trim() : null;
    if (Object.keys(update).length === 0) return NextResponse.json({ error: "更新項目がありません" }, { status: 400 });
    const { error } = await supabase.from("products").update(update).eq("jan_code", jan_code);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** DELETE: 一括削除（jan_code 配列） */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const jan_codes = Array.isArray(body.jan_codes)
      ? body.jan_codes.map((j: unknown) => String(j).trim()).filter(Boolean)
      : [];
    if (jan_codes.length === 0) return NextResponse.json({ error: "jan_codesが必要です" }, { status: 400 });
    const { error } = await supabase.from("products").delete().in("jan_code", jan_codes);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
