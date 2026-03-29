/**
 * 手動確認中の注文のコンディションをインライン更新（amazon_orders.condition_id）
 * ボディは緩く受け取り、内部で数値化・コンディション正規化・Amazon注文番号フォールバックを行う。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** 数字以外を除去して parseInt（型・表記の揺れを吸収） */
function toStrippedInt(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

function normalizeConditionRobust(raw: unknown): "New" | "Used" {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\u3000/g, " ");
  return s.includes("new") ? "New" : "Used";
}

async function resolveOrderRowId(body: Record<string, unknown>): Promise<{ id: number | null; reason: string }> {
  const rawForPk =
    body.id ??
    body.id_numeric ??
    body.order_row_id ??
    body.amazon_order_db_id ??
    body.amazonOrderDbId ??
    body.id_string;

  const numericId = toStrippedInt(rawForPk);
  const numericOk = Number.isFinite(numericId) && numericId > 0;

  async function byAmazonOrder(): Promise<{ id: number | null; reason: string }> {
    const amz = String(body.amazon_order_id ?? body.order_id ?? "").trim();
    const sku = String(body.sku ?? "").trim();
    if (!amz) {
      return { id: null, reason: "missing_order_id" };
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
      console.error("[amazon/orders/condition] resolve by order_id:", error.message);
      return { id: null, reason: "query_error" };
    }
    const rid = data?.id;
    const n = toStrippedInt(rid ?? null);
    return Number.isFinite(n) && n > 0 ? { id: n, reason: "order_id_fallback" } : { id: null, reason: "not_found" };
  }

  if (!numericOk) {
    return byAmazonOrder();
  }

  const { data: hit, error } = await supabase
    .from("amazon_orders")
    .select("id, reconciliation_status")
    .eq("id", numericId)
    .maybeSingle();

  if (error) {
    console.error("[amazon/orders/condition] resolve by stripped id:", error.message);
    return byAmazonOrder();
  }
  if (hit?.reconciliation_status === "manual_required") {
    return { id: numericId, reason: "stripped_numeric_id" };
  }
  if (hit) {
    return { id: numericId, reason: "not_manual_required" };
  }

  return byAmazonOrder();
}

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    console.log("📥 受信データ:", body);

    const condition_id = normalizeConditionRobust(body.condition_id);

    const { id, reason } = await resolveOrderRowId(body);

    if (id == null) {
      console.error("[amazon/orders/condition] 400 詳細:", {
        reason,
        bodyKeys: Object.keys(body),
        rawId: body.id,
        rawIdType: typeof body.id,
        id_numeric: body.id_numeric,
        id_string: body.id_string,
        order_row_id: body.order_row_id,
        order_id: body.order_id,
        amazon_order_id: body.amazon_order_id,
        sku: body.sku,
        condition_raw: body.condition_id,
        condition_normalized: condition_id,
      });
      return NextResponse.json(
        { error: "注文を特定できませんでした（id または order_id / amazon_order_id を確認してください）。" },
        { status: 400 }
      );
    }

    if (reason === "not_manual_required") {
      return NextResponse.json(
        { error: "手動確認（manual_required）の注文のみコンディションを変更できます。" },
        { status: 403 }
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
