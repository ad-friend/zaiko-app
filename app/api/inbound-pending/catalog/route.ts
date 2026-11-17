/**
 * 相談-13 段階2：入庫待ちを作る PC のプログラム（取込と同じ合い言葉）が、商品を Amazon の自分の出品に当てるための入口。
 * 読むだけ（Amazon の商品情報・出品の辞書）。どの表にも書かない。
 * POST { refJan?: string, keywords?: string[] } → { candidates: CatalogCandidate[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireInboundImportAuth } from "@/lib/inbound-pending-server";
import { findCatalogCandidates } from "@/lib/inbound-amazon";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = requireInboundImportAuth(req.headers.get("authorization"));
  if (auth === 500) return NextResponse.json({ error: "取込の合い言葉が設定されていません" }, { status: 500 });
  if (auth === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { refJan?: unknown; keywords?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSONではありません" }, { status: 400 });
  }
  const refJan = typeof body.refJan === "string" ? body.refJan : null;
  const keywords = Array.isArray(body.keywords) ? body.keywords.filter((k): k is string => typeof k === "string") : [];
  if (!refJan && keywords.length === 0) return NextResponse.json({ error: "refJan か keywords が必要です" }, { status: 400 });
  try {
    const candidates = await findCatalogCandidates({ refJan, keywords });
    return NextResponse.json({ candidates });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Amazon の読み取りに失敗しました" }, { status: 502 });
  }
}
