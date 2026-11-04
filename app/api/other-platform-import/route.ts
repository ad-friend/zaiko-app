import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { parseOtherPlatformCsv } from "@/lib/other-platform-import-engine";
import {
  OTHER_ORDER_STATUS_PENDING,
  shouldPreserveOtherOrderReconciliationStatus,
} from "@/lib/other-platform-reconciliation-status";
import { dedupeUpsertChunkByIdempotencyKey } from "@/lib/sales-transaction-idempotency";
import { formatUnknownError, supabaseStepError, type ApiErrorPayload } from "@/lib/format-api-error";
import { otherOrderLineIdentity, otherOrderLineKey } from "@/lib/other-order-line-key";
import type { OtherPlatformOrderRow, OtherPlatformSalesUpsertRow } from "@/lib/other-platform-import-engine";

function errorResponse(payload: ApiErrorPayload, status: number) {
  return NextResponse.json({ ok: false, ...payload }, { status });
}

const UPSERT_CHUNK = 200;

async function findExistingOtherOrder(o: OtherPlatformOrderRow) {
  const identity = otherOrderLineIdentity({ sku: o.sku, jan_code: o.jan_code });
  let q = supabase
    .from("other_orders")
    .select("id, reconciliation_status")
    .eq("order_id", o.order_id)
    .eq("platform", o.platform)
    .eq("sku", identity.sku);

  if (!identity.sku) {
    if (identity.jan_code) {
      q = q.eq("jan_code", identity.jan_code);
    } else {
      q = q.or("jan_code.is.null,jan_code.eq.");
    }
  }

  return q.maybeSingle();
}

const AMOUNT_DESCRIPTION_LABELS: Record<string, string> = {
  Principal: "商品売上",
  Tax: "消費税",
  Shipping: "送料",
  Commission: "手数料",
  Other: "その他手数料",
};

function formatJstDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeSalesLine(r: {
  amazon_order_id: string | null;
  sku: string | null;
  amount_description: string | null;
  amount: number | string;
  posted_date: string | null;
}): string {
  const kind = AMOUNT_DESCRIPTION_LABELS[r.amount_description ?? ""] ?? r.amount_description ?? "—";
  return `注文番号 ${r.amazon_order_id ?? "—"} / ${kind} ${Number(r.amount)}円（SKU: ${r.sku || "—"}, 決済日: ${formatJstDate(r.posted_date)}）`;
}

/** amazon_event_hash の一意制約違反（23505）なら、CSV の該当行と DB の既存行を説明する */
async function describeDuplicateEventHash(
  error: { code?: string; details?: string },
  chunk: OtherPlatformSalesUpsertRow[],
  csvLines: Map<string, number[]>
): Promise<string[]> {
  if (error.code !== "23505") return [];
  const hash = error.details?.match(/Key \(amazon_event_hash\)=\(([0-9a-f]+)\)/)?.[1];
  if (!hash) return [];

  const messages: string[] = [];
  const lines = csvLines.get(hash) ?? [];
  const csvRow = chunk.find((r) => r.amazon_event_hash === hash);
  if (csvRow) {
    const lineLabel = lines.length > 0 ? `行 ${lines.join(", ")}` : "CSV";
    messages.push(`${lineLabel}: ${describeSalesLine(csvRow)}`);
  }

  const { data: existing } = await supabase
    .from("sales_transactions")
    .select("amazon_order_id, sku, amount_description, amount, posted_date")
    .eq("amazon_event_hash", hash)
    .limit(1)
    .maybeSingle();
  if (existing) {
    messages.push(`既存データ: ${describeSalesLine(existing)}（同じ注文・販路・種別・金額の売上が登録済み）`);
  }
  return messages;
}

function normalizeOrderRow(o: OtherPlatformOrderRow): OtherPlatformOrderRow {
  const identity = otherOrderLineIdentity({ sku: o.sku, jan_code: o.jan_code });
  return { ...o, sku: identity.sku, jan_code: identity.jan_code };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const csvText = body?.csvText != null ? String(body.csvText) : "";
    if (!csvText.trim()) {
      return NextResponse.json({ error: "csvText を指定してください。" }, { status: 400 });
    }

    let parsed;
    try {
      parsed = parseOtherPlatformCsv(csvText);
    } catch (e) {
      return errorResponse(formatUnknownError(e, "CSVの解析に失敗しました。"), 400);
    }

    if (!parsed.orders.length) {
      const rowErrors = parsed.rowErrors;
      const error =
        rowErrors.length > 0
          ? `取り込める注文行がありません（${rowErrors.length}件の行エラー）。`
          : "取り込める注文行がありません。ヘッダー行と必須列（注文番号・プラットフォーム・決済日または注文日・金額列）を確認してください。";
      return errorResponse({ error, rowErrors }, 422);
    }

    const uniqueOrders = [
      ...new Map(parsed.orders.map((o) => normalizeOrderRow(o)).map((o) => [otherOrderLineKey(o), o])).values(),
    ];

    const existingByKey = new Map<string, { id: string; reconciliation_status: string | null }>();
    for (const o of uniqueOrders) {
      const { data, error } = await findExistingOtherOrder(o);
      if (error) {
        return errorResponse(supabaseStepError("既存注文の確認", error), 500);
      }
      if (data) existingByKey.set(otherOrderLineKey(o), data as { id: string; reconciliation_status: string | null });
    }

    const nowIso = new Date().toISOString();
    let ordersUpserted = 0;

    for (const o of uniqueOrders) {
      const key = otherOrderLineKey(o);
      const existing = existingByKey.get(key);
      const preserve = existing && shouldPreserveOtherOrderReconciliationStatus(existing.reconciliation_status);
      const reconciliation_status = preserve
        ? String(existing!.reconciliation_status)
        : OTHER_ORDER_STATUS_PENDING;
      const status =
        reconciliation_status === "reconciled"
          ? "completed"
          : reconciliation_status === "manual_required"
            ? "manual_required"
            : "pending";

      const payload = {
        order_id: o.order_id,
        platform: o.platform,
        sku: o.sku,
        quantity: o.quantity,
        condition_id: o.condition_id,
        jan_code: o.jan_code,
        sell_price: o.sell_price,
        order_date: o.order_date,
        posted_date: o.posted_date,
        reconciliation_status,
        status,
        updated_at: nowIso,
      };

      if (existing?.id) {
        const { error } = await supabase.from("other_orders").update(payload).eq("id", existing.id);
        if (error) {
          return errorResponse(
            supabaseStepError(`注文の更新（${o.platform}/${o.order_id}）`, error),
            500
          );
        }
      } else {
        const { error } = await supabase.from("other_orders").insert([payload]);
        if (error) {
          return errorResponse(
            supabaseStepError(`注文の登録（${o.platform}/${o.order_id}）`, error),
            500
          );
        }
      }
      ordersUpserted++;
    }

    let salesUpserted = 0;
    const salesDeduped = dedupeUpsertChunkByIdempotencyKey(parsed.salesRows);
    for (let i = 0; i < salesDeduped.length; i += UPSERT_CHUNK) {
      const chunk = salesDeduped.slice(i, i + UPSERT_CHUNK);
      const { data, error } = await supabase
        .from("sales_transactions")
        .upsert(chunk, { onConflict: "idempotency_key", ignoreDuplicates: false })
        .select("id");
      if (error) {
        const payload = supabaseStepError(`売上明細の保存（チャンク ${Math.floor(i / UPSERT_CHUNK) + 1}）`, error);
        const duplicateRowErrors = await describeDuplicateEventHash(error, chunk, parsed.salesRowCsvLines);
        if (duplicateRowErrors.length > 0) payload.rowErrors = duplicateRowErrors;
        return errorResponse(payload, 500);
      }
      salesUpserted += data?.length ?? chunk.length;
    }

    return NextResponse.json({
      ok: true,
      ordersUpserted,
      salesUpserted,
      orderRows: uniqueOrders.length,
      salesRows: salesDeduped.length,
      rowErrors: parsed.rowErrors,
      message: `CSVを取り込みました（注文 ${ordersUpserted}件 / 売上行 ${salesUpserted}件）。在庫引当・本消込はボタンから実行してください。`,
    });
  } catch (e: unknown) {
    return errorResponse(formatUnknownError(e, "CSV取込に失敗しました。"), 500);
  }
}
