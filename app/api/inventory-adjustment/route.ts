/** 在庫調整（破損・紛失・社内使用・接待）: 古い在庫から exit_type を付与 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

const CONDITIONS = new Set(["new", "used"]);
const REASONS = new Set(["damaged", "lost", "internal_use", "entertainment"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jan_code = String(body.jan_code ?? "").trim();
    const condition = String(body.condition ?? "").trim();
    const quantity = Number(body.quantity);
    const reason = String(body.reason ?? "").trim();

    if (!jan_code) {
      return NextResponse.json({ error: "jan_code が必要です" }, { status: 400 });
    }
    if (!CONDITIONS.has(condition)) {
      return NextResponse.json({ error: "condition は new または used を指定してください" }, { status: 400 });
    }
    if (!Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 1) {
      return NextResponse.json({ error: "quantity は 1 以上の整数で指定してください" }, { status: 400 });
    }
    if (!REASONS.has(reason)) {
      return NextResponse.json(
        { error: "reason は damaged, lost, internal_use, entertainment のいずれかを指定してください" },
        { status: 400 }
      );
    }

    const { data: candidates, error: selErr } = await supabase
      .from("inbound_items")
      .select("id")
      .eq("jan_code", jan_code)
      .eq("condition_type", condition)
      .is("settled_at", null)
      .is("exit_type", null)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .order("created_at", { ascending: true })
      .limit(quantity);

    if (selErr) throw new Error(selErr.message);

    const rows = candidates ?? [];
    if (rows.length < quantity) {
      return NextResponse.json(
        {
          error: `該当する未販売・未調整の在庫が不足しています（必要: ${quantity} 件 / 取得: ${rows.length} 件）。JAN・コンディションを確認してください。`,
        },
        { status: 400 }
      );
    }

    const ids = rows.map((r) => r.id as number);
    const { error: upErr } = await supabase.from("inbound_items").update({ exit_type: reason }).in("id", ids);
    if (upErr) throw new Error(upErr.message);

    return NextResponse.json({ ok: true, updated: ids.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "在庫調整に失敗しました";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
