/**
 * 手動確認中の注文のコンディションをインライン更新（amazon_orders.condition_id）
 * amazon_orders.id は UUID。主キーは body.id_string / body.id のみ厳格に受理（数値化なし）。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

/** RFC 4122 形式の UUID（大文字小文字許容） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isStrictConditionId(raw: unknown): raw is "New" | "Used" {
  return raw === "New" || raw === "Used";
}

type PrimaryIdParse =
  | { kind: "ok"; id: string }
  | { kind: "absent" }
  | { kind: "reject"; message: string };

/**
 * body.id_string または body.id のみを厳格に検証（typeof string・trim 非空・UUID 形式）。
 * amazon_order_db_id 等はここでは使わない。
 */
function parseStrictPrimaryRowId(body: Record<string, unknown>): PrimaryIdParse {
  const idStringField = body.id_string;
  const idField = body.id;

  if (typeof idStringField === "string") {
    const t = idStringField.trim();
    if (t.length === 0) {
      return { kind: "reject", message: "id_string が空です。" };
    }
    if (!UUID_RE.test(t)) {
      return { kind: "reject", message: "id_string は有効な UUID 形式である必要があります。" };
    }
    if (typeof idField === "string" && idField.trim().length > 0 && idField.trim() !== t) {
      return { kind: "reject", message: "id と id_string が一致しません。" };
    }
    if (idField !== undefined && idField !== null && typeof idField !== "string") {
      return { kind: "reject", message: "id は文字列である必要があります。" };
    }
    return { kind: "ok", id: t };
  }

  if (idStringField !== undefined && idStringField !== null) {
    return { kind: "reject", message: "id_string は文字列である必要があります。" };
  }

  if (typeof idField === "string") {
    const t = idField.trim();
    if (t.length === 0) {
      return { kind: "reject", message: "id が空です。" };
    }
    if (!UUID_RE.test(t)) {
      return { kind: "reject", message: "id は有効な UUID 形式である必要があります。" };
    }
    return { kind: "ok", id: t };
  }

  if (idField !== undefined && idField !== null) {
    return { kind: "reject", message: "id は文字列である必要があります。" };
  }

  return { kind: "absent" };
}

function rowIdFromDb(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

async function resolveOrderRowId(
  body: Record<string, unknown>,
  strictPk: string | null
): Promise<{ id: string | null; reason: string }> {
  async function byAmazonOrder(): Promise<{ id: string | null; reason: string }> {
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
    const { data: rows, error } = await q;
    if (error) {
      console.error("[amazon/orders/condition] resolve by order_id:", error.message);
      return { id: null, reason: "query_error" };
    }
    const list = rows ?? [];
    if (list.length === 0) {
      return { id: null, reason: "not_found" };
    }
    if (list.length > 1) {
      console.error("[amazon/orders/condition] multiple manual_required rows", { amz, sku, count: list.length });
      return {
        id: null,
        reason: sku ? "ambiguous_multiple_lines" : "multiple_rows_need_sku",
      };
    }
    const sid = rowIdFromDb(list[0].id);
    return sid ? { id: sid, reason: "order_id_fallback" } : { id: null, reason: "not_found" };
  }

  if (strictPk == null) {
    return byAmazonOrder();
  }

  const { data: hit, error } = await supabase
    .from("amazon_orders")
    .select("id, reconciliation_status")
    .eq("id", strictPk)
    .maybeSingle();

  if (error) {
    console.error("[amazon/orders/condition] resolve by id (uuid):", error.message);
    return byAmazonOrder();
  }
  if (hit?.reconciliation_status === "manual_required") {
    return { id: strictPk, reason: "row_uuid" };
  }
  if (hit) {
    return { id: strictPk, reason: "not_manual_required" };
  }

  return byAmazonOrder();
}

export async function PATCH(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
    console.log("📥 受信データ:", body);

    if (!isStrictConditionId(body.condition_id)) {
      console.error("[amazon/orders/condition] 400 condition_id:", {
        condition_id: body.condition_id,
        conditionType: typeof body.condition_id,
      });
      return NextResponse.json(
        { error: 'condition_id は "New" または "Used" を完全一致で指定してください。' },
        { status: 400 }
      );
    }
    const condition_id = body.condition_id;

    const primary = parseStrictPrimaryRowId(body);
    if (primary.kind === "reject") {
      return NextResponse.json({ error: primary.message }, { status: 400 });
    }
    const strictPk = primary.kind === "ok" ? primary.id : null;

    const { id, reason } = await resolveOrderRowId(body, strictPk);

    if (id == null) {
      console.error("[amazon/orders/condition] 400 詳細:", {
        reason,
        bodyKeys: Object.keys(body),
        id_string: body.id_string,
        id: body.id,
        order_id: body.order_id,
        amazon_order_id: body.amazon_order_id,
        sku: body.sku,
        condition_id,
      });
      const message =
        reason === "multiple_rows_need_sku"
          ? "同一Amazon注文に複数の手動確認行があります。SKUで行を特定してください。"
          : reason === "ambiguous_multiple_lines"
            ? "条件に一致する行が複数あります。データを確認してください。"
            : "注文を特定できませんでした（有効な id / id_string、または order_id / amazon_order_id を確認してください）。";
      return NextResponse.json({ error: message }, { status: 400 });
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
