/**
 * 手動確認中の注文のコンディションをインライン更新（amazon_orders.condition_id）
 * id は必ずテーブル主キー amazon_orders.id（bigint）。Amazon 注文番号は amazon_order_id + sku で解決。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** 主キー: 数値、または数字のみの文字列（"503-xxx" のような注文番号は拒否） */
function parsePrimaryKeyId(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const t = Math.trunc(raw);
    return t > 0 ? t : null;
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    return null;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseOrderRowIdFromBody(body: Record<string, unknown>): number | null {
  const raw = body.id ?? body.order_row_id ?? body.amazon_order_db_id ?? body.amazonOrderDbId;
  return parsePrimaryKeyId(raw);
}

async function resolveOrderRowId(
  body: Record<string, unknown>
): Promise<{ id: number | null; reason: string }> {
  const fromPk = parseOrderRowIdFromBody(body);
  if (fromPk != null) {
    return { id: fromPk, reason: "primary_key" };
  }

  const amz = String(body.amazon_order_id ?? "").trim();
  const sku = String(body.sku ?? "").trim();
  if (!amz) {
    return { id: null, reason: "missing_amazon_order_id" };
  }

  let q = supabase
    .from("amazon_orders")
    .select("id")
    .eq("amazon_order_id", amz)
    .eq("reconciliation_status", "manual_required");
  if (sku) {
    q = q.eq("sku", sku);
  }
  const { data, error } = await q.maybeSingle();
  if (error) {
    console.error("[amazon/orders/condition] resolve by amazon_order_id:", error.message);
    return { id: null, reason: "query_error" };
  }
  const rid = data?.id;
  const n = parsePrimaryKeyId(rid ?? null);
  return n != null ? { id: n, reason: "amazon_order_id_sku" } : { id: null, reason: "not_found" };
}

/** フロントの揺れ（new / NEW / Used / used）を DB 用 New | Used に統一 */
function normalizeConditionIdInput(raw: unknown): "New" | "Used" | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/\u3000/g, " ")
    .toLowerCase();
  if (!s) return null;
  if (s === "new" || s.startsWith("new")) return "New";
  if (s === "used" || s.startsWith("used")) return "Used";
  return null;
}

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    console.log("📥 受信データ:", body);

    const condition_id = normalizeConditionIdInput(body.condition_id);

    const { id, reason } = await resolveOrderRowId(body);

    if (id == null || condition_id == null) {
      console.error("[amazon/orders/condition] 400 詳細:", {
        reason,
        bodyKeys: Object.keys(body),
        rawId: body.id,
        rawIdType: typeof body.id,
        order_row_id: body.order_row_id,
        amazon_order_id: body.amazon_order_id,
        sku: body.sku,
        condition_raw: body.condition_id,
        condition_normalized: condition_id,
      });
      return NextResponse.json(
        { error: "有効な id（または amazon_order_id）と condition_id（New または Used）が必要です。" },
        { status: 400 }
      );
    }

    const { data: row, error: selErr } = await supabase
      .from("amazon_orders")
      .select("id, reconciliation_status")
      .eq("id", id)
      .maybeSingle();

    if (selErr) throw selErr;
    if (!row) {
      return NextResponse.json({ error: "注文が見つかりません。" }, { status: 404 });
    }
    if (row.reconciliation_status !== "manual_required") {
      return NextResponse.json(
        { error: "手動確認（manual_required）の注文のみコンディションを変更できます。" },
        { status: 403 }
      );
    }

    const { data: updateData, error: updateError, status: updateStatus } = await supabase
      .from("amazon_orders")
      .update({
        condition_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    console.log("🗄️ DB更新結果:", { status: updateStatus, error: updateError, data: updateData });
    if (updateError) {
      console.log("🗄️ DB error 詳細:", {
        message: updateError.message,
        details: updateError.details,
        hint: updateError.hint,
        code: "code" in updateError ? (updateError as { code: string }).code : undefined,
      });
      throw updateError;
    }

    return NextResponse.json({ ok: true, id, condition_id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "更新に失敗しました。";
    console.error("[amazon/orders/condition] 例外:", message, {
      bodyKeys: Object.keys(body),
      rawId: body.id,
      rawIdType: typeof body.id,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
