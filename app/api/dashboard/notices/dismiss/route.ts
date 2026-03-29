/**
 * ダッシュボードお知らせを「確認済み」として非表示にする
 * POST JSON: { id: string (UUID) }
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
    const id = body?.id != null ? String(body.id).trim() : "";
    if (!id) {
      return NextResponse.json({ error: "id を指定してください。" }, { status: 400 });
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("dashboard_notices")
      .update({ dismissed_at: nowIso })
      .eq("id", id)
      .is("dismissed_at", null)
      .select("id");

    if (error) {
      const msg = error.message ?? "";
      if (error.code === "42P01" || msg.includes("does not exist")) {
        return NextResponse.json({ error: "dashboard_notices テーブルがありません。docs/migration_dashboard_notices.sql を実行してください。" }, { status: 503 });
      }
      throw error;
    }

    if (!data?.length) {
      return NextResponse.json({ error: "お知らせが見つからないか、すでに確認済みです。" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "更新に失敗しました。";
    console.error("[dashboard/notices/dismiss]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
