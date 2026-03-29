/**
 * Amazon 注文に紐づいた inbound_items（order_id 一致）の引き当てを解放する。
 * キャンセル・返品インポートなどで共通利用。冪等（未紐付けなら 0 件更新）。
 */
import { supabase } from "@/lib/supabase";

export type ReleaseInboundForAmazonOrderResult = { ok: true } | { ok: false; message: string };

export async function releaseInboundItemsForAmazonOrder(amazon_order_id: string): Promise<ReleaseInboundForAmazonOrderResult> {
  const oid = String(amazon_order_id ?? "").trim();
  if (!oid) {
    return { ok: false, message: "amazon_order_id が空です。" };
  }

  const { error: invErr } = await supabase
    .from("inbound_items")
    .update({ order_id: null, settled_at: null })
    .eq("order_id", oid);

  if (invErr) {
    return { ok: false, message: invErr.message };
  }

  return { ok: true };
}
