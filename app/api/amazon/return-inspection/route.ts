/**
 * Amazon 返品: 検品待ち（stock_status=return_inspection）の一覧と、確定（condition_type 更新 + available）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { STOCK_STATUS_AVAILABLE, STOCK_STATUS_RETURN_INSPECTION } from "@/lib/inbound-stock-status";

const CONDITION_VALUES = new Set(["new", "used"]);

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("id, jan_code, product_name, condition_type, stock_status, created_at")
      .eq("stock_status", STOCK_STATUS_RETURN_INSPECTION)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) throw error;
    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    console.error("[return-inspection GET]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: unknown; condition_type?: unknown };
    const id = body.id != null ? Number(body.id) : NaN;
    const condition_type = body.condition_type != null ? String(body.condition_type).trim().toLowerCase() : "";

    if (!Number.isFinite(id) || id < 1) {
      return NextResponse.json({ error: "有効な id を指定してください。" }, { status: 400 });
    }
    if (!CONDITION_VALUES.has(condition_type)) {
      return NextResponse.json({ error: "condition_type は new または used を指定してください。" }, { status: 400 });
    }

    const { data: updated, error } = await supabase
      .from("inbound_items")
      .update({
        condition_type,
        stock_status: STOCK_STATUS_AVAILABLE,
      })
      .eq("id", id)
      .eq("stock_status", STOCK_STATUS_RETURN_INSPECTION)
      .select("id");

    if (error) throw error;
    if (!updated?.length) {
      return NextResponse.json(
        { error: "対象行が見つからないか、すでに検品済みです。" },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "更新に失敗しました。";
    console.error("[return-inspection POST]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
