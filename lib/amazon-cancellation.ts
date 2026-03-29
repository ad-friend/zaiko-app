/**
 * Amazon 注文キャンセル時: amazon_orders を canceled にし、紐付いた在庫（inbound_items）を解放する。
 */
import { supabase } from "@/lib/supabase";
import { AMAZON_ORDER_STATUS_CANCELED } from "@/lib/amazon-order-reconciliation-status";
import { releaseInboundItemsForAmazonOrder } from "@/lib/amazon-order-inventory-release";

export type HandleOrderCancellationResult = { ok: true } | { ok: false; message: string };

/**
 * @param amazon_order_id Amazon マーケットプレイスの注文番号（例: 503-xxxx）
 */
export async function handleOrderCancellation(amazon_order_id: string): Promise<HandleOrderCancellationResult> {
  const oid = String(amazon_order_id ?? "").trim();
  if (!oid) {
    return { ok: false, message: "amazon_order_id が空です。" };
  }

  const nowIso = new Date().toISOString();

  const rel = await releaseInboundItemsForAmazonOrder(oid);
  if (!rel.ok) {
    return rel;
  }

  const { error: ordErr } = await supabase
    .from("amazon_orders")
    .update({ reconciliation_status: AMAZON_ORDER_STATUS_CANCELED, updated_at: nowIso })
    .eq("amazon_order_id", oid);

  if (ordErr) {
    return { ok: false, message: ordErr.message };
  }

  return { ok: true };
}
