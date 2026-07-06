import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { parseOtherPlatformCsv } from "@/lib/other-platform-import-engine";
import {
  OTHER_ORDER_STATUS_PENDING,
  shouldPreserveOtherOrderReconciliationStatus,
} from "@/lib/other-platform-reconciliation-status";
import { dedupeUpsertChunkByIdempotencyKey } from "@/lib/sales-transaction-idempotency";

const UPSERT_CHUNK = 200;

function orderUpsertKey(o: { order_id: string; platform: string; sku: string }) {
  return `${o.order_id}\t${o.platform}\t${o.sku}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const csvText = body?.csvText != null ? String(body.csvText) : "";
    if (!csvText.trim()) {
      return NextResponse.json({ error: "csvText を指定してください。" }, { status: 400 });
    }

    const parsed = parseOtherPlatformCsv(csvText);
    if (!parsed.orders.length) {
      return NextResponse.json({
        ok: true,
        ordersUpserted: 0,
        salesUpserted: 0,
        rowErrors: parsed.rowErrors,
        message: "有効な注文行がありません。",
      });
    }

    const uniqueOrders = [...new Map(parsed.orders.map((o) => [orderUpsertKey(o), o])).values()];

    const existingByKey = new Map<string, { id: string; reconciliation_status: string | null }>();
    for (const o of uniqueOrders) {
      const { data, error } = await supabase
        .from("other_orders")
        .select("id, reconciliation_status")
        .eq("order_id", o.order_id)
        .eq("platform", o.platform)
        .eq("sku", o.sku)
        .maybeSingle();
      if (error) throw error;
      if (data) existingByKey.set(orderUpsertKey(o), data as { id: string; reconciliation_status: string | null });
    }

    const nowIso = new Date().toISOString();
    let ordersUpserted = 0;

    for (const o of uniqueOrders) {
      const key = orderUpsertKey(o);
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
        if (error) throw error;
      } else {
        const { error } = await supabase.from("other_orders").insert([payload]);
        if (error) throw error;
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
      if (error) throw error;
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
    const message = e instanceof Error ? e.message : "CSV取込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
