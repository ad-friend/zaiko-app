/**
 * amazon_orders 行の物理削除（キャンセル注文などの整理用）
 * DELETE /api/amazon/orders/:id  … id は UUID
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id: raw } = await context.params;
  const id = decodeURIComponent(raw ?? "").trim();
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "無効な注文行IDです。" }, { status: 400 });
  }

  const { error } = await supabase.from("amazon_orders").delete().eq("id", id);
  if (error) {
    console.error("[amazon/orders DELETE]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
