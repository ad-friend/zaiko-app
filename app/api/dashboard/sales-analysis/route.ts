import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { loadSalesAnalysis, shiftDate, tokyoDate } from "@/lib/sales-analysis-aggregates";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") ?? 90);
  if (!Number.isInteger(days) || days < 1 || days > 90) return NextResponse.json({ error: "daysは1〜90です" }, { status: 400 });
  try { const end = tokyoDate(); return NextResponse.json(await loadSalesAnalysis(supabase, shiftDate(end, -(days - 1)), end)); }
  catch { return NextResponse.json({ error: "日ごとの売上分析を取得できませんでした" }, { status: 500 }); }
}
