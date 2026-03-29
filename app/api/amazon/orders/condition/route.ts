/**
 * 手動確認中の注文のコンディションをインライン更新（amazon_orders.condition_id）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const ALLOWED = new Set(["New", "Used"]);

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const id = Number(body.id);
    const condition_id = String(body.condition_id ?? "").trim();
    if (!Number.isFinite(id) || id <= 0 || !ALLOWED.has(condition_id)) {
      return NextResponse.json(
        { error: "有効な id と condition_id（New または Used）が必要です。" },
        { status: 400 }
      );
    }

    const { data: row, error: selErr } = await supabase
      .from("amazon_orders")
      .select("id, reconciliation_status")
      .eq("id", id)
      .maybeSingle();

    if (selErr) throw selErr;
    if (!row) {
      return NextResponse.json({ error: "注文が見つかりません。" }, { status: 404 });
    }
    if (row.reconciliation_status !== "manual_required") {
      return NextResponse.json(
        { error: "手動確認（manual_required）の注文のみコンディションを変更できます。" },
        { status: 403 }
      );
    }

    const { error } = await supabase
      .from("amazon_orders")
      .update({
        condition_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;

    return NextResponse.json({ ok: true, id, condition_id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "更新に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
