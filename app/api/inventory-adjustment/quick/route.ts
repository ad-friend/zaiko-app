/**
 * ダッシュボード用: JAN・コンディション単位で、最も原価が安い販売可能在庫を1件 disposed にする
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { normalizeStockCondition } from "@/lib/amazon-condition-match";
import {
  INBOUND_FILTER_SALABLE_FOR_ALLOCATION,
  QUICK_ADJUST_EXIT_TYPES,
  STOCK_STATUS_DISPOSED,
  type QuickAdjustExitType,
} from "@/lib/inbound-stock-status";

const FETCH_CAP = 3000;
const NOT_FOUND = "対象の販売可能在庫が見つかりません";

function isQuickExitType(v: string): v is QuickAdjustExitType {
  return (QUICK_ADJUST_EXIT_TYPES as readonly string[]).includes(v);
}

type Row = {
  id: number;
  condition_type: string | null;
  effective_unit_price: unknown;
  base_price: unknown;
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      jan_code?: unknown;
      condition_type?: unknown;
      exit_type?: unknown;
    };

    const janRaw = body.jan_code != null ? String(body.jan_code).trim() : "";
    const condRaw = body.condition_type != null ? String(body.condition_type).trim().toLowerCase() : "";
    const exitRaw = body.exit_type != null ? String(body.exit_type).trim().toLowerCase() : "";

    if (!janRaw) {
      return NextResponse.json({ error: "jan_code を指定してください。" }, { status: 400 });
    }
    if (condRaw !== "new" && condRaw !== "used") {
      return NextResponse.json({ error: "condition_type は new または used を指定してください。" }, { status: 400 });
    }
    if (!isQuickExitType(exitRaw)) {
      return NextResponse.json(
        {
          error:
            "exit_type は internal_damage / loss / internal_use / promo_entertainment のいずれかを指定してください。",
        },
        { status: 400 }
      );
    }

    const { data: rows, error: selErr } = await supabase
      .from("inbound_items")
      .select("id, condition_type, effective_unit_price, base_price")
      .eq("jan_code", janRaw)
      .is("settled_at", null)
      .is("exit_type", null)
      .or("order_id.is.null,order_id.eq.\"\"")
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .order("effective_unit_price", { ascending: true })
      .order("base_price", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(FETCH_CAP);

    if (selErr) throw selErr;

    const list = Array.isArray(rows) ? rows : [];
    let picked: Row | null = null;
    for (const r of list) {
      const norm = normalizeStockCondition(r.condition_type);
      if (norm === condRaw) {
        picked = r as Row;
        break;
      }
    }

    if (!picked) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    }

    const { data: updated, error: updErr } = await supabase
      .from("inbound_items")
      .update({
        stock_status: STOCK_STATUS_DISPOSED,
        exit_type: exitRaw,
      })
      .eq("id", picked.id)
      .is("settled_at", null)
      .is("exit_type", null)
      .or("order_id.is.null,order_id.eq.\"\"")
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .select("id, effective_unit_price");

    if (updErr) throw updErr;
    if (!updated?.length) {
      return NextResponse.json({ error: "更新に失敗しました（他処理と競合した可能性があります）。" }, { status: 409 });
    }

    const price = Number(picked.effective_unit_price ?? 0);
    const appliedPrice = Number.isFinite(price) ? price : 0;

    return NextResponse.json({
      ok: true,
      id: picked.id,
      jan_code: janRaw,
      condition_type: condRaw,
      exit_type: exitRaw,
      applied_price: appliedPrice,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[inventory-adjustment/quick POST]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
