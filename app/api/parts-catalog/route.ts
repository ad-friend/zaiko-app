/** パーツマスタ CRUD */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isValidPartCode, normalizePartCode } from "@/lib/parts-catalog";

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";

    if (code) {
      const normalized = normalizePartCode(code);
      const { data, error } = await supabase
        .from("parts_catalog")
        .select("*")
        .eq("code", normalized)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json(data);
    }

    let query = supabase.from("parts_catalog").select("*").order("code", { ascending: true }).limit(5000);
    if (q) {
      const esc = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_%");
      const p = `%${esc}%`;
      query = query.or(`code.ilike.${p},name.ilike.${p},brand.ilike.${p},note.ilike.${p}`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "パーツマスタの取得に失敗しました";
    if (msg.includes("does not exist") || msg.includes("parts_catalog")) {
      return NextResponse.json(
        { error: "parts_catalog テーブルがありません。docs/migration_parts_catalog.sql を適用してください。" },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const code = normalizePartCode(String(body.code ?? ""));
    const name = String(body.name ?? "").trim();
    const brand = body.brand != null ? String(body.brand).trim() || null : null;
    const note = body.note != null ? String(body.note).trim() || null : null;

    if (!isValidPartCode(code)) {
      return NextResponse.json({ error: "パーツコードは2〜64文字の英数・ハイフン等で指定してください。" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "正式名称は必須です。" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("parts_catalog")
      .upsert(
        { code, name, brand, note, updated_at: now },
        { onConflict: "code" }
      )
      .select("*")
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "パーツマスタの保存に失敗しました";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const code = normalizePartCode(String(body.code ?? ""));
    if (!isValidPartCode(code)) {
      return NextResponse.json({ error: "code が不正です。" }, { status: 400 });
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) return NextResponse.json({ error: "正式名称は空にできません。" }, { status: 400 });
      update.name = name;
    }
    if (body.brand !== undefined) update.brand = body.brand != null ? String(body.brand).trim() || null : null;
    if (body.note !== undefined) update.note = body.note != null ? String(body.note).trim() || null : null;

    const { data, error } = await supabase.from("parts_catalog").update(update).eq("code", code).select("*").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, row: data });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "パーツマスタの更新に失敗しました";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const codesRaw = Array.isArray(body.codes) ? body.codes : body.code != null ? [body.code] : [];
    const codes = codesRaw.map((c: unknown) => normalizePartCode(String(c))).filter(isValidPartCode);
    if (!codes.length) {
      return NextResponse.json({ error: "codes が必要です。" }, { status: 400 });
    }

    const { error } = await supabase.from("parts_catalog").delete().in("code", codes);
    if (error) throw error;
    return NextResponse.json({ ok: true, deleted: codes.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "パーツマスタの削除に失敗しました";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
