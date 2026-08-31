/** 在庫のパーツ取り外し */
import { NextRequest, NextResponse } from "next/server";
import { disassembleItem } from "@/lib/inventory-assembly";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const childId = Number(body.childId ?? body.child_id ?? body.id);
    if (!Number.isInteger(childId) || childId < 1) {
      return NextResponse.json({ error: "childId は正の整数で指定してください。" }, { status: 400 });
    }

    const result = await disassembleItem(childId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      childId: result.child.id,
      previousParentId: result.previousParentId,
      message: `在庫 #${result.child.id} を #${result.previousParentId} から取り外しました。`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "取り外しに失敗しました。";
    console.error("[inventory/disassemble]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
