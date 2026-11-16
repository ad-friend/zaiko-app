import { NextRequest, NextResponse } from "next/server";
import { createSalesAnalysisWriter } from "@/lib/supabase-server";
import { requireTrendsImportAuth } from "@/lib/trends-import-auth";
import { importTrends, validateTrendsPayload } from "@/lib/sales-traffic-sync";
export async function POST(req: NextRequest) {
  const status = requireTrendsImportAuth(req.headers.get("authorization"));
  if (status !== 200) return NextResponse.json({ error: status === 401 ? "Unauthorized" : "トレンド取込設定が不足しています" }, { status });
  let input: unknown;
  try { input = await req.json(); validateTrendsPayload(input); }
  catch { return NextResponse.json({ error: "Amazonの日次トレンド90日分を重複・欠損なしで指定してください（値は0〜100）" }, { status: 400 }); }
  try { return NextResponse.json({ imported: await importTrends(createSalesAnalysisWriter(), input) }); }
  catch { return NextResponse.json({ error: "トレンドを保存できませんでした" }, { status: 500 }); }
}
