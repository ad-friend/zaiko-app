import { NextRequest, NextResponse } from "next/server";
import { createSalesAnalysisWriter } from "@/lib/supabase-server";
import { removeSaleEvent, validateSaleEvent, writeSaleEvent } from "@/lib/sales-analysis-aggregates";
type Context = { params: Promise<{ id: string }> };
function validId(id: string) { return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)); }
export async function PUT(req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
  let input;
  try { input = validateSaleEvent(await req.json()); } catch { return NextResponse.json({ error: "セール日程の入力が不正です" }, { status: 400 }); }
  try {
    const { data, error } = await writeSaleEvent(createSalesAnalysisWriter(), input, id);
    if (error) return NextResponse.json({ error: error.code === "23505" ? "同じ名称・開始日の日程が既にあります" : "セール日程を更新できませんでした" }, { status: error.code === "23505" ? 400 : 500 });
    return data ? NextResponse.json(data) : NextResponse.json({ error: "日程がありません" }, { status: 404 });
  } catch { return NextResponse.json({ error: "セール日程を更新できませんでした" }, { status: 500 }); }
}
export async function DELETE(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
  try {
    const { data, error } = await removeSaleEvent(createSalesAnalysisWriter(), id);
    if (error) throw new Error("削除失敗");
    return data ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "日程がありません" }, { status: 404 });
  } catch { return NextResponse.json({ error: "セール日程を削除できませんでした" }, { status: 500 }); }
}
