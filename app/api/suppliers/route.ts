import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type SupplierRow = {
  id: number;
  name: string;
  kana: string;
  phone: string | null;
  address: string | null;
  created_at: string;
};

/** GET: 一覧 or ?q=カナ前方一致 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const { data, error } = await supabase.from("suppliers").select("*").order("kana", { ascending: true });
    if (error) throw error;
    let list = data ?? [];
    if (q) {
      const upper = q.toUpperCase();
      list = list.filter((r: { kana?: string }) => (r.kana ?? "").toUpperCase().startsWith(upper));
    }
    return NextResponse.json(list);
  } catch (e: any) {
    if (e.code === "42P01" || e.message?.includes("does not exist")) {
      return NextResponse.json([]);
    }
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST: 新規登録 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const kana = String(body.kana ?? "").trim();
    if (!name || !kana) return NextResponse.json({ error: "仕入先名とカナは必須です" }, { status: 400 });
    const { data, error } = await supabase
      .from("suppliers")
      .insert({
        name,
        kana,
        phone: body.phone ? String(body.phone).trim() : null,
        address: body.address ? String(body.address).trim() : null,
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** PATCH: 更新 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return NextResponse.json({ error: "idが必要です" }, { status: 400 });
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.name = String(body.name).trim();
    if (body.kana !== undefined) update.kana = String(body.kana).trim();
    if (body.phone !== undefined) update.phone = body.phone ? String(body.phone).trim() : null;
    if (body.address !== undefined) update.address = body.address ? String(body.address).trim() : null;
    if (Object.keys(update).length === 0) return NextResponse.json({ error: "更新項目がありません" }, { status: 400 });
    const { error } = await supabase.from("suppliers").update(update).eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** DELETE: 一括削除 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) return NextResponse.json({ error: "idsが必要です" }, { status: 400 });
    const { error } = await supabase.from("suppliers").delete().in("id", ids);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
