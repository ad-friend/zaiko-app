import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { createSalesAnalysisWriter } from "@/lib/supabase-server";
import { isDate, readAllRows, validateSaleEvent, writeSaleEvent } from "@/lib/sales-analysis-aggregates";
import type { SaleEvent } from "@/lib/sales-analysis-types";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from"), to = req.nextUrl.searchParams.get("to");
  if ((from !== null && !isDate(from)) || (to !== null && !isDate(to)) || (from && to && from > to)) return NextResponse.json({ error: "期間が不正です" }, { status: 400 });
  try { return NextResponse.json(await readAllRows<SaleEvent>(supabase, "sale_events", "id,label,start_date,end_date,note", "id", q => { if (from) q = q.gte("end_date", from); if (to) q = q.lte("start_date", to); return q; })); }
  catch { return NextResponse.json({ error: "セール日程を取得できませんでした" }, { status: 500 }); }
}
export async function POST(req: NextRequest) {
  let input;
  try { input = validateSaleEvent(await req.json()); } catch { return NextResponse.json({ error: "セール日程の入力が不正です" }, { status: 400 }); }
  try {
    const { data, error } = await writeSaleEvent(createSalesAnalysisWriter(), input);
    if (error) return NextResponse.json({ error: error.code === "23505" ? "同じ名称・開始日の日程が既にあります" : "セール日程を保存できませんでした" }, { status: error.code === "23505" ? 400 : 500 });
    return NextResponse.json(data, { status: 201 });
  } catch { return NextResponse.json({ error: "セール日程を保存できませんでした" }, { status: 500 }); }
}
