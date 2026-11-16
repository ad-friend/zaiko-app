import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildWeeklySummary, loadSalesAnalysis, shiftDate, tokyoDate } from "@/lib/sales-analysis-aggregates";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const today = tokyoDate();
    return NextResponse.json(buildWeeklySummary(await loadSalesAnalysis(supabase, shiftDate(today, -20), today), today));
  } catch { return NextResponse.json({ error: "週の要点を取得できませんでした" }, { status: 500 }); }
}
