/**
 * 相談-13：入庫待ち（納品書1枚＝1伝票）
 * GET  … 入庫画面の一覧（未登録だけ）
 * POST … 取込（PC・AI だけ。Bearer INBOUND_IMPORT_SECRET）。inbound_pending にだけ書く。
 *        在庫の表・登録済みの印・消込・引当には書かない。登録済みの書類は 409 で何もしない。
 */
import { NextRequest, NextResponse } from "next/server";
import { parseImportBody, toPendingRow } from "@/lib/inbound-pending";
import { createInboundPendingClient, PENDING_COLUMNS, requireInboundImportAuth } from "@/lib/inbound-pending-server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = createInboundPendingClient();
    const { data, error } = await db
      .from("inbound_pending")
      .select(PENDING_COLUMNS)
      .is("registered_header_id", null)
      .order("purchase_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return NextResponse.json({ rows: (data ?? []).map((r) => toPendingRow(r as Record<string, unknown>)) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "入庫待ちの読み込みに失敗しました" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = requireInboundImportAuth(req.headers.get("authorization"));
  if (auth === 500) return NextResponse.json({ error: "取込の合い言葉が設定されていません" }, { status: 500 });
  if (auth === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSONではありません" }, { status: 400 });
  }
  const parsed = parseImportBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const v = parsed.value;

  try {
    const db = createInboundPendingClient();
    // 書き込みと重複の確認は DB の import_inbound_pending で1回の処理にする（同じ仕入先は順番待ち）。
    // 重複の疑い＝同じ仕入先で注文番号か伝票番号が同じ別の書類（登録済みも含む）。
    const { data, error } = await db.rpc("import_inbound_pending", {
      p: {
        sourceHash: v.sourceHash,
        sourcePage: v.sourcePage,
        sourceRefs: v.sourceRefs,
        supplierKey: v.supplierKey,
        documentNumber: v.documentNumber,
        orderNumber: v.orderNumber,
        purchaseDate: v.purchaseDate,
        payload: v.payload,
        status: v.status,
        blockers: v.blockers,
        reviewRequired: v.reviewRequired,
      },
    });
    if (error) {
      // 同時に同じ書類が来たとき（一意制約）は、二重に作らず 409
      if (error.code === "23505") return NextResponse.json({ ok: false, duplicate: true }, { status: 409 });
      throw new Error(error.message);
    }
    const r = (data ?? {}) as { ok?: boolean; registered?: boolean };
    if (r.registered) return NextResponse.json(r, { status: 409 });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "入庫待ちの保存に失敗しました" }, { status: 500 });
  }
}
