import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { applyPreservedReconciliationStatusForUpsert } from "@/lib/amazon-order-reconciliation-status";

type AmazonOrdersImportRow = {
  amazonOrderId: string;
  purchaseDate: string;
  sku: string;
  asin?: string;
  itemPrice?: number;
  quantity?: number;
  orderStatus?: string;
};

type ImportError =
  | { type: "invalid_row"; index: number; error: string; row: unknown }
  | { type: "upsert_error"; error: string; details?: unknown; chunk: { start: number; end: number } };

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseQuantity(v: unknown): number | null {
  const n = v == null || v === "" ? NaN : Number(v);
  if (!Number.isFinite(n)) return null;
  const q = Math.floor(n);
  return q > 0 ? q : null;
}

function parseToIsoDateMaybe(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const inputs: AmazonOrdersImportRow[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.rows)
        ? body.rows
        : [];

    if (!inputs.length) {
      return NextResponse.json({ error: "注文データの配列を送ってください。" }, { status: 400 });
    }

    const nowIso = new Date().toISOString();

    const validRows: Array<Record<string, unknown>> = [];
    const errors: ImportError[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const row = inputs[i] as AmazonOrdersImportRow;

      const amazonOrderId = toTrimmedString(row.amazonOrderId);
      const purchaseDate = toTrimmedString(row.purchaseDate);
      const sku = toTrimmedString(row.sku);

      if (!amazonOrderId) {
        errors.push({ type: "invalid_row", index: i, error: "amazonOrderId が必須です。", row });
        continue;
      }
      if (!purchaseDate) {
        errors.push({ type: "invalid_row", index: i, error: "purchaseDate が必須です。", row });
        continue;
      }
      if (!sku) {
        errors.push({ type: "invalid_row", index: i, error: "sku が必須です。", row });
        continue;
      }

      const qty = parseQuantity(row.quantity) ?? 1;
      const asin = row.asin != null ? toTrimmedString(row.asin) : "";

      const janCode = /^\d{13}$/.test(sku) ? sku : null;
      const conditionId = "New"; // レポートから条件が取れない場合でも NOT NULL 制約を満たすための既定値
      const createdAtIso = parseToIsoDateMaybe(purchaseDate);

      const payload: Record<string, unknown> = {
        amazon_order_id: amazonOrderId,
        sku,
        condition_id: conditionId,
        reconciliation_status: "pending",
        quantity: qty,
        jan_code: janCode,
        asin: asin ? asin : null,
        updated_at: nowIso,
      };

      if (createdAtIso) payload.created_at = createdAtIso;
      validRows.push(payload);
    }

    const skipped = inputs.length - validRows.length;
    if (!validRows.length) {
      return NextResponse.json({ ok: false, upserted: 0, skipped, errors }, { status: 400 });
    }

    let upserted = 0;
    const chunkSize = 200;

    for (let start = 0; start < validRows.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, validRows.length);
      const chunk = validRows.slice(start, end);

      const chunkOrderIds = [...new Set(chunk.map((r) => String(r.amazon_order_id)))];
      const { data: existingStatuses } = await supabase
        .from("amazon_orders")
        .select("amazon_order_id, sku, reconciliation_status")
        .in("amazon_order_id", chunkOrderIds);
      applyPreservedReconciliationStatusForUpsert(
        chunk as Array<{ amazon_order_id: string; sku: string; reconciliation_status?: string }>,
        existingStatuses ?? []
      );

      const { data, error } = await supabase
        .from("amazon_orders")
        .upsert(chunk, { onConflict: "amazon_order_id,sku" })
        .select("id");

      if (error) {
        errors.push({
          type: "upsert_error",
          error: error.message,
          details: error,
          chunk: { start, end },
        });
        return NextResponse.json(
          {
            ok: false,
            upserted,
            skipped,
            errors,
          },
          { status: 500 }
        );
      }

      upserted += Array.isArray(data) ? data.length : 0;
    }

    return NextResponse.json({
      ok: true,
      received: inputs.length,
      upserted,
      skipped,
      errors,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "インポートに失敗しました。";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

