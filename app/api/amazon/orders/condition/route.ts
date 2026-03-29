/**
 * 手動確認中の注文のコンディションをインライン更新（amazon_orders.condition_id）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

function parseOrderRowId(body: Record<string, unknown>): number | null {
  const raw = body.id ?? body.amazon_order_db_id ?? body.amazonOrderDbId;
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** フロントの揺れ（new / NEW / Used / used）を DB 用 New | Used に統一 */
function normalizeConditionIdInput(raw: unknown): "New" | "Used" | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/\u3000/g, " ")
    .toLowerCase();
  if (!s) return null;
  if (s === "new" || s.startsWith("new")) return "New";
  if (s === "used" || s.startsWith("used")) return "Used";
  return null;
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = parseOrderRowId(body);
    const condition_id = normalizeConditionIdInput(body.condition_id);
    if (id == null || condition_id == null) {
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
