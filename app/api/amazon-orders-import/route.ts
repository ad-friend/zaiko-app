import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { applyPreservedReconciliationStatusForUpsert } from "@/lib/amazon-order-reconciliation-status";
import { buildLocalJanLookupMaps, resolveJanFromLocalMaps } from "@/lib/amazon-order-local-jan";
import {
  fetchAllOrderItems,
  normalizeOrderItemConditionId,
  skuMatchesOrderLine,
  sleep,
  tryCreateAmazonSpClient,
  type OrderItemLite,
} from "@/lib/amazon-sp-order-items";

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

const ORDER_FETCH_CHUNK = 50;
const ORDER_FETCH_SLEEP_MS = 450;
const CHUNK_SLEEP_BETWEEN_GROUPS_MS = 1000;
const DB_UPSERT_CHUNK = 50;

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

/**
 * SP-API は ConditionId（＋明細の ASIN）取得のみ。カタログ API は使わない。
 * 注文IDを50件単位で区切り、呼び出し間に sleep。
 */
async function buildOrderIdToItemsMap(orderIds: string[]): Promise<Map<string, OrderItemLite[]>> {
  const map = new Map<string, OrderItemLite[]>();
  const sp = tryCreateAmazonSpClient();
  if (!sp || orderIds.length === 0) return map;

  for (let g = 0; g < orderIds.length; g += ORDER_FETCH_CHUNK) {
    const group = orderIds.slice(g, g + ORDER_FETCH_CHUNK);
    for (const oid of group) {
      try {
        const items = await fetchAllOrderItems(sp, oid);
        map.set(oid, items);
      } catch (e) {
        console.warn(`[amazon-orders-import] getOrderItems failed ${oid}:`, e);
        map.set(oid, []);
      }
      await sleep(ORDER_FETCH_SLEEP_MS);
    }
    if (g + ORDER_FETCH_CHUNK < orderIds.length) await sleep(CHUNK_SLEEP_BETWEEN_GROUPS_MS);
  }
  return map;
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
      const asinFromCsv = row.asin != null ? toTrimmedString(row.asin) : "";

      const payload: Record<string, unknown> = {
        amazon_order_id: amazonOrderId,
        sku,
        condition_id: null as string | null,
        reconciliation_status: "pending",
        quantity: qty,
        jan_code: null as string | null,
        asin: asinFromCsv ? asinFromCsv : null,
        updated_at: nowIso,
      };

      const createdAtIso = parseToIsoDateMaybe(purchaseDate);
      if (createdAtIso) payload.created_at = createdAtIso;
      validRows.push(payload);
    }

    const skipped = inputs.length - validRows.length;
    if (!validRows.length) {
      return NextResponse.json({ ok: false, upserted: 0, skipped, errors }, { status: 400 });
    }

    const uniqueOrderIds = [...new Set(validRows.map((r) => String(r.amazon_order_id)))];
    const orderItemsMap = await buildOrderIdToItemsMap(uniqueOrderIds);

    for (const r of validRows) {
      const oid = String(r.amazon_order_id);
      const sku = String(r.sku);
      const items = orderItemsMap.get(oid) ?? [];
      const line = items.find((it) => skuMatchesOrderLine(sku, String(it.SellerSKU ?? "")));
      if (line?.ConditionId != null && String(line.ConditionId).trim()) {
        r.condition_id = normalizeOrderItemConditionId(line.ConditionId);
      }
      if (line?.ASIN && String(line.ASIN).trim()) {
        r.asin = String(line.ASIN).trim();
      }
    }

    const asinList = validRows.map((r) => r.asin).filter((a): a is string => Boolean(a));
    const skuList = validRows.map((r) => String(r.sku));
    const { asinToJan, skuToJan } = await buildLocalJanLookupMaps(supabase, asinList, skuList);
    for (const r of validRows) {
      const resolved = resolveJanFromLocalMaps(String(r.sku), r.asin as string | null, asinToJan, skuToJan);
      r.jan_code = resolved;
    }

    let upserted = 0;

    for (let start = 0; start < validRows.length; start += DB_UPSERT_CHUNK) {
      const end = Math.min(start + DB_UPSERT_CHUNK, validRows.length);
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
            error: error.message,
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
