/** 在庫のパーツ組み付け */
import { NextRequest, NextResponse } from "next/server";
import { assembleItems } from "@/lib/inventory-assembly";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const parentId = Number(body.parentId ?? body.parent_id);
    const childId = Number(body.childId ?? body.child_id);
    if (!Number.isInteger(parentId) || parentId < 1 || !Number.isInteger(childId) || childId < 1) {
      return NextResponse.json({ error: "parentId と childId は正の整数で指定してください。" }, { status: 400 });
    }

    const result = await assembleItems(parentId, childId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      parentId: result.parent.id,
      childId: result.child.id,
      message: `在庫 #${result.child.id} を #${result.parent.id} に組み付けました。`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "組み付けに失敗しました。";
    console.error("[inventory/assemble]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
