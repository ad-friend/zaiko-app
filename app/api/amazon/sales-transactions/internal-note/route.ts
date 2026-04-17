/**
 * sales_transactions.internal_note を一括更新
 * POST body: { salesTransactionIds: number[], internal_note?: string | null }
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { salesTransactionIds?: unknown; internal_note?: unknown };
    const rawIds = body.salesTransactionIds;
    const ids = Array.isArray(rawIds)
      ? rawIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1)
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "salesTransactionIds を1件以上指定してください。" }, { status: 400 });
    }
    const uniq = new Set(ids);
    if (uniq.size !== ids.length) {
      return NextResponse.json({ error: "salesTransactionIds に重複があります。" }, { status: 400 });
    }

    const noteRaw = body.internal_note;
    const internal_note =
      noteRaw == null ? null : typeof noteRaw === "string" ? noteRaw.trim() || null : String(noteRaw).trim() || null;

    const { error } = await supabase.from("sales_transactions").update({ internal_note }).in("id", ids);
    if (error) {
      const code = (error as { code?: string })?.code;
      const msg = (error as { message?: string })?.message ?? "";
      if (code === "42703" || msg.toLowerCase().includes("internal_note")) {
        return NextResponse.json(
          {
            error:
              "internal_note 列がありません。docs/migration_sales_transactions_internal_note.sql を Supabase で実行してください。",
          },
          { status: 500 }
        );
      }
      throw error;
    }

    return NextResponse.json({ ok: true, updated: ids.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "internal_note の更新に失敗しました。";
    console.error("[sales-transactions/internal-note]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
