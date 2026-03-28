/** 在庫一覧 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type RecordRow = {
  id: number;
  jan_code: string | null;
  asin?: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  condition_type: string | null;
  base_price: number;
  effective_unit_price: number;
  created_at: string;
  /** 入庫登録処理実行時刻（登録日） */
  registered_at?: string;
  order_id?: string | null;
  settled_at?: string | null;
  /** 在庫調整理由（damaged 等） */
  exit_type?: string | null;
  header: {
    id: number;
    purchase_date: string;
    supplier: string | null;
    genre: string | null;
    created_at: string;
  } | null;
};

const SELECT_WITH_REGISTERED = `
  id,
  jan_code,
  asin,
  product_name,
  brand,
  model_number,
  condition_type,
  base_price,
  effective_unit_price,
  created_at,
  registered_at,
  order_id,
  settled_at,
  exit_type,
  inbound_headers (
    id,
    purchase_date,
    supplier,
    genre,
    created_at
  )
`;

const SELECT_WITHOUT_REGISTERED = `
  id,
  jan_code,
  asin,
  product_name,
  brand,
  model_number,
  condition_type,
  base_price,
  effective_unit_price,
  created_at,
  order_id,
  settled_at,
  exit_type,
  inbound_headers (
    id,
    purchase_date,
    supplier,
    genre,
    created_at
  )
`;

export async function GET(request: NextRequest) {
  try {
    const yearsParam = request.nextUrl.searchParams.get("years");
    let years = 2;
    if (yearsParam !== null && yearsParam !== "") {
      const n = parseInt(yearsParam, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 100) years = n;
    }

    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    const cutoffIso = cutoff.toISOString();

    const { data, error } = await supabase
      .from("inbound_items")
      .select(SELECT_WITH_REGISTERED)
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false });

    // エラーがあればここでキャッチ処理へ飛ばす
    if (error) throw error;

    // 取得したデータを画面用に整形する
    const rows = (data || []).map((row: any) => ({
      id: row.id,
      jan_code: row.jan_code ?? null,
      asin: row.asin ?? null,
      product_name: row.product_name ?? null,
      brand: row.brand ?? null,
      model_number: row.model_number ?? null,
      condition_type: row.condition_type ?? null,
      base_price: Number(row.base_price ?? 0),
      effective_unit_price: Number(row.effective_unit_price ?? 0),
      created_at: row.created_at ?? "",
      registered_at: (row.registered_at || row.created_at)
        ? new Date(row.registered_at || row.created_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-")
        : "",
      order_id: row.order_id ?? null,
      settled_at: row.settled_at ?? null,
      exit_type: row.exit_type ?? null,
      header: Array.isArray(row.inbound_headers) ? row.inbound_headers[0] : row.inbound_headers ?? null,
    }));

    // 画面にデータを返す
    return NextResponse.json(rows);
    
  } catch (e: any) {
    // 💡 さっき消えてしまっていたのはココです！ try とセットになる catch ブロック
    console.error("[records] GET error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function normalizeDeleteIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : Number(String(x).trim());
    if (!Number.isInteger(n) || n < 1) continue;
    out.push(n);
  }
  return [...new Set(out)];
}

export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正なJSONです" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "リクエストボディが必要です" }, { status: 400 });
  }
  const ids = normalizeDeleteIds((body as { ids?: unknown }).ids);
  if (ids.length === 0) {
    return NextResponse.json({ error: "削除対象の ids を1件以上、正しい整数で指定してください" }, { status: 400 });
  }

  const CHUNK = 120;
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data, error } = await supabase.from("inbound_items").delete().in("id", chunk).select("id");
      if (error) {
        console.error("[records] DELETE chunk error:", error);
        return NextResponse.json({ error: error.message || "inbound_items の削除に失敗しました" }, { status: 500 });
      }
      deleted += data?.length ?? 0;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "削除処理中にエラーが発生しました";
    console.error("[records] DELETE error:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (deleted === 0) {
    return NextResponse.json(
      {
        error:
          "いずれの id にも該当する inbound_items が削除できませんでした（存在しない・既に削除済み、または権限・RLSの制限の可能性があります）",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, deleted, requested: ids.length });
}