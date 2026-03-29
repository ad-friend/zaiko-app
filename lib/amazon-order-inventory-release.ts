/**
 * Amazon 注文に紐づいた inbound_items（order_id 一致）の引き当てを解放する。
 * キャンセル・返品インポートなどで共通利用。冪等（未紐付けなら 0 件更新）。
 */
import { supabase } from "@/lib/supabase";
import { STOCK_STATUS_RETURN_INSPECTION } from "@/lib/inbound-stock-status";

export type ReleaseInboundForAmazonOrderResult = { ok: true } | { ok: false; message: string };

export type ReleaseInboundForAmazonOrderMode = "cancel" | "return";

/**
 * @param mode cancel: 従来どおり order_id/settled_at のみ解除。return: 返品検品待ちへ送る（即販売可能には戻さない）
 */
export async function releaseInboundItemsForAmazonOrder(
  amazon_order_id: string,
  mode: ReleaseInboundForAmazonOrderMode = "cancel"
): Promise<ReleaseInboundForAmazonOrderResult> {
  const oid = String(amazon_order_id ?? "").trim();
  if (!oid) {
    return { ok: false, message: "amazon_order_id が空です。" };
  }

  const payload =
    mode === "return"
      ? { order_id: null, settled_at: null, stock_status: STOCK_STATUS_RETURN_INSPECTION }
      : { order_id: null, settled_at: null };

  const { error: invErr } = await supabase.from("inbound_items").update(payload).eq("order_id", oid);

  if (invErr) {
    return { ok: false, message: invErr.message };
  }

  return { ok: true };
}
