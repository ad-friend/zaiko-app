/**
 * 相談-13：入庫待ち1件
 * GET   … 入庫画面に呼び出す（登録済みなら registered を返し、画面には入れない）
 * PATCH … 人が「別の伝票です」と確かめたときだけ、重複の疑いを外す（{ action: "not_duplicate" }）。
 *         登録済みは変えない。ほかの項目は変えない。
 */
import { NextRequest, NextResponse } from "next/server";
import { toPendingRow } from "@/lib/inbound-pending";
import { createInboundPendingClient, PENDING_COLUMNS } from "@/lib/inbound-pending-server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "番号が正しくありません" }, { status: 400 });
  try {
    const db = createInboundPendingClient();
    const { data, error } = await db.from("inbound_pending").select(PENDING_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "入庫待ちが見つかりません" }, { status: 404 });
    const row = toPendingRow(data as Record<string, unknown>);
    if (row.registeredHeaderId != null) {
      return NextResponse.json({ registered: true, headerId: row.registeredHeaderId }, { status: 409 });
    }
    if (row.reviewRequired) {
      return NextResponse.json({ reviewRequired: true, error: "重複の確認が済んでいないため呼び出せません" }, { status: 409 });
    }
    return NextResponse.json({ row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "読み込みに失敗しました" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "番号が正しくありません" }, { status: 400 });
  let body: { action?: string; expected?: { supplierKey?: string | null; orderNumber?: string | null; documentNumber?: string | null } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSONではありません" }, { status: 400 });
  }
  if (body.action !== "not_duplicate") return NextResponse.json({ error: "action が正しくありません" }, { status: 400 });
  if (!body.expected || typeof body.expected !== "object") {
    return NextResponse.json({ error: "画面で見た番号（expected）がありません" }, { status: 400 });
  }
  try {
    const db = createInboundPendingClient();
    // 取込と同じ順番待ちに入って外す（そのときの番号の組み合わせを残し、番号が変われば確かめ直す）
    // 人が画面で見た番号と今の番号が同じときだけ外す（違えば読み直して確かめ直す）
    const { data, error } = await db.rpc("clear_inbound_pending_duplicate", {
      p_id: id,
      p_expected: {
        supplierKey: body.expected.supplierKey ?? null,
        orderNumber: body.expected.orderNumber ?? null,
        documentNumber: body.expected.documentNumber ?? null,
      },
    });
    if (error) throw new Error(error.message);
    const r = (data ?? {}) as { ok?: boolean; notFound?: boolean; registered?: boolean; conflict?: boolean };
    if (r.notFound) return NextResponse.json({ error: "入庫待ちが見つかりません" }, { status: 404 });
    if (r.registered) return NextResponse.json({ error: "登録済みです" }, { status: 409 });
    if (r.conflict) {
      return NextResponse.json({ conflict: true, error: "番号が変わりました。一覧を読み直して、もう一度確かめてください" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存に失敗しました" }, { status: 500 });
  }
}
