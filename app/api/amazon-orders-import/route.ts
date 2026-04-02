import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { applyPreservedReconciliationStatusForUpsert } from "@/lib/amazon-order-reconciliation-status";
import { buildLocalJanLookupMaps, resolveJanFromLocalMaps } from "@/lib/amazon-order-local-jan";
import { buildSkuToConditionMap } from "@/lib/amazon-order-import-condition";
import { handleOrderCancellation } from "@/lib/amazon-cancellation";

type AmazonOrdersImportRow = {
  amazonOrderId: string;
  purchaseDate: string;
  sku: string;
  asin?: string;
  itemPrice?: number;
  quantity?: number;
  orderStatus?: string;
  itemStatus?: string;
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

/** 注文・明細ステータスがキャンセル系か（大文字小文字無視。日本語はそのまま部分一致） */
function statusTextImpliesCancelled(raw: unknown): boolean {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower.includes("cancel")) return true;
  if (s.includes("キャンセル")) return true;
  return false;
}

function importRowIndicatesCancelled(row: AmazonOrdersImportRow & Record<string, unknown>): boolean {
  const extras: unknown[] = [
    row.orderStatus,
    row.itemStatus,
    row["order-status"],
    row["item-status"],
    row["order_status"],
    row["item_status"],
  ];
  for (const v of extras) {
    if (statusTextImpliesCancelled(v)) return true;
  }
  return false;
}

/**
 * FBA マルチチャネル等の「手元への返送オーダー」に見られる注文番号形式（S + 2 桁 + 2 区切りの 7 桁）。
 * 他販路の任意 ID は弾かないよう、このパターンのみブラックリストする。
 */
const FBA_REMOVAL_STYLE_ORDER_ID_RE = /^S\d{2}-\d{7}-\d{7}$/;

function isBlacklistedFbaRemovalStyleOrderId(amazonOrderId: string): boolean {
  return FBA_REMOVAL_STYLE_ORDER_ID_RE.test(amazonOrderId.trim());
}

function amazonOrderUpsertKey(row: Record<string, unknown>): string {
  return `${String(row.amazon_order_id ?? "").trim()}\t${String(row.sku ?? "").trim()}`;
}

/**
 * 同一バッチ内で (amazon_order_id, sku) が重複していると、Postgres の
 * ON CONFLICT DO UPDATE が「同じ行に2回触れる」として 21000 エラーになる。
 * レポート上の複数行（同一注文・同一SKU）を1行にまとめてから upsert する。
 *
 * - quantity: 合算（複数明細の合計数量想定）
 * - asin: 空でない値を優先、両方ある場合は後勝ち（ファイル後段を採用）
 * - created_at: 早い日時を残す（注文日の代表値）
 */
const MAX_NOTICE_ORDER_IDS = 400;

function collapseDuplicateAmazonOrderRows(rows: Array<Record<string, unknown>>): {
  collapsed: Array<Record<string, unknown>>;
  duplicate_lines_merged: number;
  amazon_order_ids_with_merge: string[];
} {
  const byKey = new Map<string, Record<string, unknown>>();
  let duplicate_lines_merged = 0;
  const orderIdsWithMerge = new Set<string>();

  for (const r of rows) {
    const key = amazonOrderUpsertKey(r);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      continue;
    }

    duplicate_lines_merged += 1;
    const oid = String(existing.amazon_order_id ?? "").trim();
    if (oid) orderIdsWithMerge.add(oid);

    const qA = Math.max(1, Math.floor(Number(existing.quantity) || 1));
    const qB = Math.max(1, Math.floor(Number(r.quantity) || 1));
    existing.quantity = qA + qB;

    const asinNew = r.asin != null ? String(r.asin).trim() : "";
    if (asinNew) {
      existing.asin = asinNew;
    }

    const ca = existing.created_at != null ? String(existing.created_at) : "";
    const cb = r.created_at != null ? String(r.created_at) : "";
    if (cb && (!ca || cb < ca)) {
      existing.created_at = r.created_at;
    }

    existing.updated_at = r.updated_at;
  }

  const amazon_order_ids_with_merge = [...orderIdsWithMerge].sort();
  return { collapsed: [...byKey.values()], duplicate_lines_merged, amazon_order_ids_with_merge };
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
    let skippedCancelledNew = 0;
    let skippedCancelledLines = 0;
    let skippedRemovalOrders = 0;
    let cancellationRollbacks = 0;
    const rolledBackAmazonOrderIds = new Set<string>();

    for (let i = 0; i < inputs.length; i++) {
      const row = inputs[i] as AmazonOrdersImportRow & Record<string, unknown>;

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

      if (isBlacklistedFbaRemovalStyleOrderId(amazonOrderId)) {
        skippedRemovalOrders += 1;
        continue;
      }

      if (importRowIndicatesCancelled(row)) {
        skippedCancelledLines += 1;
        const { data: existingRows, error: existErr } = await supabase
          .from("amazon_orders")
          .select("id")
          .eq("amazon_order_id", amazonOrderId)
          .limit(1);
        if (existErr) {
          errors.push({ type: "invalid_row", index: i, error: `キャンセル行の確認に失敗: ${existErr.message}`, row });
          continue;
        }
        if (!existingRows?.length) {
          skippedCancelledNew += 1;
          continue;
        }
        if (!rolledBackAmazonOrderIds.has(amazonOrderId)) {
          const cancelRes = await handleOrderCancellation(amazonOrderId);
          if (!cancelRes.ok) {
            errors.push({ type: "invalid_row", index: i, error: `キャンセル巻き戻し失敗: ${cancelRes.message}`, row });
            continue;
          }
          rolledBackAmazonOrderIds.add(amazonOrderId);
          cancellationRollbacks += 1;
        }
        continue;
      }

      const qty = parseQuantity(row.quantity) ?? 1;
      const asinFromCsv = row.asin != null ? toTrimmedString(row.asin) : "";

      const payload: Record<string, unknown> = {
        amazon_order_id: amazonOrderId,
        sku,
        line_index: 0,
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
      if (errors.length === 0) {
        return NextResponse.json({
          ok: true,
          received: inputs.length,
          upserted: 0,
          skipped,
          duplicate_lines_merged: 0,
          skipped_removal_orders: skippedRemovalOrders,
          skipped_cancelled: skippedCancelledLines,
          skipped_cancelled_new: skippedCancelledNew,
          cancellation_rollbacks: cancellationRollbacks,
          errors,
        });
      }
      return NextResponse.json(
        {
          ok: false,
          upserted: 0,
          skipped,
          duplicate_lines_merged: 0,
          skipped_removal_orders: skippedRemovalOrders,
          skipped_cancelled: skippedCancelledLines,
          skipped_cancelled_new: skippedCancelledNew,
          cancellation_rollbacks: cancellationRollbacks,
          errors,
        },
        { status: 400 }
      );
    }

    const skuList = validRows.map((r) => String(r.sku));
    const skuToCondition = await buildSkuToConditionMap(supabase, skuList);
    for (const r of validRows) {
      r.condition_id = skuToCondition.get(String(r.sku)) ?? "New";
    }

    const asinList = validRows.map((r) => r.asin).filter((a): a is string => Boolean(a));
    const { asinToJan, skuToJan } = await buildLocalJanLookupMaps(supabase, asinList, skuList);
    for (const r of validRows) {
      r.jan_code = resolveJanFromLocalMaps(String(r.sku), r.asin as string | null, asinToJan, skuToJan);
    }

    const chunkOrderIds = [...new Set(validRows.map((r) => String(r.amazon_order_id)))];
    const { data: existingStatuses } = await supabase
      .from("amazon_orders")
      .select("amazon_order_id, sku, line_index, reconciliation_status")
      .in("amazon_order_id", chunkOrderIds);
    applyPreservedReconciliationStatusForUpsert(
      validRows as Array<{ amazon_order_id: string; sku: string; line_index?: number; reconciliation_status?: string }>,
      existingStatuses ?? []
    );

    const { collapsed: rowsToUpsert, duplicate_lines_merged, amazon_order_ids_with_merge } =
      collapseDuplicateAmazonOrderRows(validRows);

    for (const r of rowsToUpsert) {
      if (r.line_index == null) r.line_index = 0;
      r.jan_code = resolveJanFromLocalMaps(String(r.sku), r.asin as string | null, asinToJan, skuToJan);
    }

    const { data, error } = await supabase
      .from("amazon_orders")
      .upsert(rowsToUpsert, { onConflict: "amazon_order_id,sku,line_index" })
      .select("id");

    if (error) {
      errors.push({
        type: "upsert_error",
        error: error.message,
        details: error,
        chunk: { start: 0, end: rowsToUpsert.length },
      });
      return NextResponse.json(
        {
          error: error.message,
          upserted: 0,
          skipped,
          duplicate_lines_merged,
          skipped_removal_orders: skippedRemovalOrders,
          skipped_cancelled: skippedCancelledLines,
          skipped_cancelled_new: skippedCancelledNew,
          cancellation_rollbacks: cancellationRollbacks,
          errors,
        },
        { status: 500 }
      );
    }

    const upserted = Array.isArray(data) ? data.length : 0;

    if (duplicate_lines_merged > 0 && amazon_order_ids_with_merge.length > 0) {
      const idsForPayload = amazon_order_ids_with_merge.slice(0, MAX_NOTICE_ORDER_IDS);
      const { error: noticeErr } = await supabase.from("dashboard_notices").insert({
        notice_type: "amazon_order_import_duplicate_lines",
        payload: {
          duplicate_lines_merged,
          amazon_order_ids: idsForPayload,
          amazon_order_id_count: amazon_order_ids_with_merge.length,
          truncated: amazon_order_ids_with_merge.length > idsForPayload.length,
          received: inputs.length,
          upserted,
        },
      });
      if (noticeErr) {
        console.error("[amazon-orders-import] dashboard_notices insert failed:", noticeErr.message);
      }
    }

    return NextResponse.json({
      ok: true,
      received: inputs.length,
      upserted,
      skipped,
      duplicate_lines_merged,
      skipped_removal_orders: skippedRemovalOrders,
      skipped_cancelled: skippedCancelledLines,
      skipped_cancelled_new: skippedCancelledNew,
      cancellation_rollbacks: cancellationRollbacks,
      errors,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "インポートに失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
