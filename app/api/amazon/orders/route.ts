/**
 * Amazon注文一覧
 * GET: status クエリで filtering（manual_required など）
 * - status=inconsistent_reconciled: reconciled/completed だが inbound_items に order_id が無い行（最大500件スキャン）
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const INCONSISTENT_RECONCILED_STATUS = "inconsistent_reconciled";
const RECONCILED_LIKE = ["reconciled", "completed"] as const;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");

    if (status === INCONSISTENT_RECONCILED_STATUS) {
      const MAX_SCAN = 500;
      const { data: recRows, error: recErr } = await supabase
        .from("amazon_orders")
        .select(
          "id, amazon_order_id, sku, line_index, condition_id, reconciliation_status, quantity, jan_code, asin, created_at, updated_at"
        )
        .in("reconciliation_status", [...RECONCILED_LIKE])
        .order("updated_at", { ascending: false })
        .limit(MAX_SCAN);
      if (recErr) throw recErr;

      const rows = (recRows ?? []) as Array<{
        id: string;
        amazon_order_id: string;
        sku: string;
        line_index?: number | null;
        condition_id: string;
        reconciliation_status: string;
        quantity: number;
        jan_code: string | null;
        asin: string | null;
        created_at: string;
        updated_at?: string | null;
      }>;

      const uniqOrderIds = [...new Set(rows.map((r) => String(r.amazon_order_id ?? "").trim()).filter(Boolean))];
      const linked = new Set<string>();
      const CHUNK = 150;
      for (let i = 0; i < uniqOrderIds.length; i += CHUNK) {
        const chunk = uniqOrderIds.slice(i, i + CHUNK);
        if (!chunk.length) continue;
        const { data: inv, error: invErr } = await supabase.from("inbound_items").select("order_id").in("order_id", chunk);
        if (invErr) throw invErr;
        for (const invRow of inv ?? []) {
          const oid = String((invRow as { order_id?: unknown }).order_id ?? "").trim();
          if (oid) linked.add(oid);
        }
      }

      const inconsistent = rows.filter((r) => {
        const oid = String(r.amazon_order_id ?? "").trim();
        return oid && !linked.has(oid);
      });

      return NextResponse.json(
        inconsistent.map((row) => ({
          ...row,
          order_row_id: row.id,
        }))
      );
    }

    let q = supabase
      .from("amazon_orders")
      .select(
        "id, amazon_order_id, sku, line_index, condition_id, reconciliation_status, quantity, jan_code, asin, created_at, updated_at"
      )
      .order("created_at", { ascending: false });

    if (status) {
      q = q.eq("reconciliation_status", status);
    }

    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    return NextResponse.json(
      rows.map((row) => ({
        ...row,
        /** `id` と同一。amazon_orders の主キー（UUID）を明示（フロントの取り違え防止） */
        order_row_id: row.id,
      }))
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
