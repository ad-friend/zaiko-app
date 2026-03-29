/**
 * 自動消込前のキャッシュミス補完: getOrderItems + getCatalogItem（JAN 用）のみ。
 * products マスタは「既に JAN が存在し、asin が空」のときのみ asin を UPDATE（INSERT 禁止）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { is13DigitJan } from "@/lib/amazon-order-local-jan";
import {
  fetchAllOrderItems,
  normalizeOrderItemConditionId,
  skuMatchesOrderLine,
  sleep,
  tryCreateAmazonSpClient,
  type OrderItemLite,
  type SpClientInstance,
} from "@/lib/amazon-sp-order-items";

const MARKETPLACE_ID_JP = "A1VC38T7YXB528";

export type ReconcileHealOrderRow = {
  id: string;
  amazon_order_id: string;
  sku: string;
  condition_id: string | null;
  quantity: number;
  jan_code: string | null;
  asin: string | null;
};

function extractJanFromCatalogItem(item: unknown): string | null {
  if (item == null || typeof item !== "object") return null;
  const root = item as Record<string, unknown>;
  const identifiers = root.identifiers;
  if (Array.isArray(identifiers)) {
    for (const block of identifiers) {
      if (block == null || typeof block !== "object") continue;
      const inner = (block as { identifiers?: unknown }).identifiers;
      if (!Array.isArray(inner)) continue;
      for (const id of inner) {
        if (id == null || typeof id !== "object") continue;
        const rec = id as { identifierType?: string; identifier?: string };
        const t = String(rec.identifierType ?? "").toUpperCase();
        const v = String(rec.identifier ?? "").trim();
        if ((t === "EAN" || t === "GTIN" || t === "JAN" || t === "UPC") && is13DigitJan(v)) return v;
        if (is13DigitJan(v)) return v;
      }
    }
  }
  return null;
}

async function fetchJanByCatalogAsin(sp: SpClientInstance, asin: string): Promise<string | null> {
  const res = (await sp.callAPI({
    operation: "getCatalogItem",
    endpoint: "catalogItems",
    path: { asin },
    query: {
      marketplaceIds: [MARKETPLACE_ID_JP],
      includedData: "identifiers",
    },
    options: { version: "2022-04-01" },
  })) as { item?: unknown };
  const item = res?.item ?? res;
  const jan = extractJanFromCatalogItem(item);
  return jan && is13DigitJan(jan) ? jan : null;
}

/**
 * マスタ汚染防止: products に該当 JAN が存在し、asin が空のときのみ asin を埋める。
 */
async function updateProductAsinIfJanExistsAndAsinEmpty(
  supabase: SupabaseClient,
  jan: string,
  asin: string
): Promise<void> {
  if (!is13DigitJan(jan) || asin.length < 10) return;
  const { data: row, error: selErr } = await supabase.from("products").select("asin").eq("jan_code", jan).maybeSingle();
  if (selErr) {
    console.warn("[amazon/reconcile/heal] products select failed:", selErr.message);
    return;
  }
  if (!row) return;
  if (String(row.asin ?? "").trim()) return;
  const { error } = await supabase.from("products").update({ asin }).eq("jan_code", jan);
  if (error) console.warn("[amazon/reconcile/heal] products asin update failed:", error.message);
}

/**
 * キャッシュミス行に対し SP-API で補完し、DB・インメモリの order を更新する。
 */
export async function healReconcileOrdersFromSpApi(
  supabase: SupabaseClient,
  orders: ReconcileHealOrderRow[]
): Promise<void> {
  const sp = tryCreateAmazonSpClient();
  if (!sp) {
    console.warn("[amazon/reconcile/heal] SP-API 認証情報がないためキャッシュ補完をスキップします。");
    return;
  }

  const needsHeal = orders.filter(
    (o) => !String(o.jan_code ?? "").trim() || !String(o.condition_id ?? "").trim()
  );
  if (needsHeal.length === 0) return;

  const orderIdsForItems = new Set<string>();
  for (const o of needsHeal) {
    const needCond = !String(o.condition_id ?? "").trim();
    const needLineAsin = !String(o.jan_code ?? "").trim() && !String(o.asin ?? "").trim();
    if (needCond || needLineAsin) orderIdsForItems.add(o.amazon_order_id);
  }

  const orderItemsByOrderId = new Map<string, OrderItemLite[]>();
  for (const oid of orderIdsForItems) {
    try {
      const items = await fetchAllOrderItems(sp, oid);
      orderItemsByOrderId.set(oid, items);
    } catch (e) {
      console.warn(`[amazon/reconcile/heal] getOrderItems failed ${oid}:`, e);
    }
    await sleep(450);
  }

  const asinToFetchJan = new Set<string>();
  for (const o of needsHeal) {
    let asin = String(o.asin ?? "").trim();
    const items = orderItemsByOrderId.get(o.amazon_order_id);
    const hit = items?.find((it) => skuMatchesOrderLine(o.sku, String(it.SellerSKU ?? "")));
    if (!asin && hit?.ASIN) asin = String(hit.ASIN).trim();
    if (!String(o.jan_code ?? "").trim() && asin.length >= 10) asinToFetchJan.add(asin);
  }

  const janByAsin = new Map<string, string>();
  for (const asin of asinToFetchJan) {
    try {
      const jan = await fetchJanByCatalogAsin(sp, asin);
      if (jan) janByAsin.set(asin, jan);
    } catch (e) {
      console.warn(`[amazon/reconcile/heal] getCatalogItem failed ${asin}:`, e);
    }
    await sleep(450);
  }

  for (const o of needsHeal) {
    let asin = String(o.asin ?? "").trim();
    let conditionId = String(o.condition_id ?? "").trim();
    let jan = String(o.jan_code ?? "").trim();

    const items = orderItemsByOrderId.get(o.amazon_order_id);
    const line = items?.find((it) => skuMatchesOrderLine(o.sku, String(it.SellerSKU ?? "")));

    if (!asin && line?.ASIN) asin = String(line.ASIN).trim();
    if (!conditionId && line?.ConditionId != null && String(line.ConditionId).trim()) {
      conditionId = normalizeOrderItemConditionId(line.ConditionId);
    }

    if (!jan && asin.length >= 10) {
      const j = janByAsin.get(asin);
      if (j && is13DigitJan(j)) jan = j;
    }

    const patch: Record<string, unknown> = {};
    if (jan && jan !== String(o.jan_code ?? "").trim()) patch.jan_code = jan;
    if (conditionId && conditionId !== String(o.condition_id ?? "").trim()) patch.condition_id = conditionId;
    if (asin && asin !== String(o.asin ?? "").trim()) patch.asin = asin;
    if (Object.keys(patch).length === 0) continue;

    patch.updated_at = new Date().toISOString();
    const { error } = await supabase.from("amazon_orders").update(patch).eq("id", o.id);
    if (error) {
      console.warn(`[amazon/reconcile/heal] amazon_orders update failed id=${o.id}:`, error.message);
      continue;
    }
    if (patch.jan_code != null) o.jan_code = String(patch.jan_code);
    if (patch.condition_id != null) o.condition_id = String(patch.condition_id);
    if (patch.asin != null) o.asin = String(patch.asin);

    const pairJan = String(o.jan_code ?? "").trim();
    const pairAsin = String(o.asin ?? "").trim();
    if (is13DigitJan(pairJan) && pairAsin.length >= 10) {
      await updateProductAsinIfJanExistsAndAsinEmpty(supabase, pairJan, pairAsin);
    }
  }
}
