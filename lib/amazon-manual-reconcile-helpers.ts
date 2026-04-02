/**
 * 手動消込（複数在庫・セット）用の検証。自動消込（reconcile/route）と同条件を揃える。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeOrderCondition, normalizeStockCondition, type NormalizedListingCondition } from "@/lib/amazon-condition-match";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

export function uniqueJanFromSkuMappings(mapList: Array<{ jan_code: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = String(m.jan_code ?? "").trim();
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  const [only] = [...jans];
  return only ?? null;
}

export function filterAvailableByOrderId<T extends { order_id: string | null }>(rows: T[], amazonOrderId: string): T[] {
  const oidWant = String(amazonOrderId).trim();
  return rows.filter((row) => {
    const oid = row.order_id != null ? String(row.order_id).trim() : "";
    return !oid || oid === oidWant;
  });
}

export function isSetProductFromMappings(mapList: Array<{ quantity: unknown }>): boolean {
  return mapList.length > 0 && (mapList.length > 1 || (Number(mapList[0].quantity) || 1) > 1);
}

/** 単品・同一JANで orderQty 本分の在庫を選ぶ場合の検証 */
export async function validateSingleJanMultiQtyPicks(
  supabase: SupabaseClient,
  opts: {
    amazonOrderId: string;
    orderCond: NormalizedListingCondition;
    orderQty: number;
    orderJan: string | null;
    inboundIds: number[];
  }
): Promise<{ ok: true; resolvedJan: string } | { ok: false; error: string }> {
  const { amazonOrderId, orderCond, orderQty, orderJan, inboundIds } = opts;
  if (inboundIds.length !== orderQty) {
    return { ok: false, error: `在庫は ${orderQty} 件選択してください（現在 ${inboundIds.length} 件）。` };
  }
  const uniq = new Set(inboundIds);
  if (uniq.size !== inboundIds.length) {
    return { ok: false, error: "同じ在庫IDを重複して選べません。" };
  }

  const { data: rows, error: strictErr } = await supabase
    .from("inbound_items")
    .select("id, jan_code, condition_type, order_id")
    .in("id", inboundIds)
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
  if (strictErr) return { ok: false, error: strictErr.message };
  if ((rows?.length ?? 0) !== inboundIds.length) {
    return { ok: false, error: "指定した在庫の一部が見つからないか、引当対象外です。" };
  }

  const byId = new Map((rows ?? []).map((r) => [Number(r.id), r]));
  for (const id of inboundIds) {
    const row = byId.get(id);
    if (!row) return { ok: false, error: `在庫 id=${id} が見つかりません。` };
    if (normalizeStockCondition(row.condition_type) !== orderCond) {
      return { ok: false, error: `在庫 id=${id} のコンディションが注文と一致しません。` };
    }
    const avail = filterAvailableByOrderId([row], amazonOrderId);
    if (avail.length === 0) {
      return { ok: false, error: `在庫 id=${id} はこの注文に紐付けできません。` };
    }
  }

  const jans = new Set((rows ?? []).map((r) => String(r.jan_code ?? "").trim()).filter(Boolean));
  if (jans.size !== 1) {
    return { ok: false, error: "選択した在庫のJANが一致しません。" };
  }
  const [onlyJan] = [...jans];
  const oj = orderJan != null ? String(orderJan).trim() : "";
  if (oj && onlyJan !== oj) {
    return { ok: false, error: "選択した在庫のJANが注文と一致しません。" };
  }

  return { ok: true, resolvedJan: onlyJan };
}

/** セット（seller_sku の sku_mappings）の手動割当検証 */
export async function validateSetManualPicks(
  supabase: SupabaseClient,
  opts: {
    amazonOrderId: string;
    orderCond: NormalizedListingCondition;
    orderQty: number;
    sellerSku: string;
    inboundIds: number[];
  }
): Promise<{ ok: true; janForOrder: string | null } | { ok: false; error: string }> {
  const { amazonOrderId, orderCond, orderQty, sellerSku, inboundIds } = opts;
  const sku = String(sellerSku).trim();
  if (!sku) return { ok: false, error: "seller_sku を指定してください。" };

  const { data: mappings, error: mapErr } = await supabase
    .from("sku_mappings")
    .select("jan_code, quantity")
    .eq("sku", sku)
    .eq("platform", "Amazon");
  if (mapErr) return { ok: false, error: mapErr.message };
  const mapList = mappings ?? [];
  if (!isSetProductFromMappings(mapList)) {
    return { ok: false, error: "指定したSKUはセット構成としてマスタに登録されていません。" };
  }

  const needByJan = new Map<string, number>();
  let totalNeed = 0;
  for (const m of mapList) {
    const jan = String(m.jan_code ?? "").trim();
    if (!jan) return { ok: false, error: "SKUマスタに無効なJANがあります。" };
    const need = (Number(m.quantity) || 1) * orderQty;
    needByJan.set(jan, (needByJan.get(jan) ?? 0) + need);
    totalNeed += need;
  }

  if (inboundIds.length !== totalNeed) {
    return { ok: false, error: `セットには在庫 ${totalNeed} 件が必要です（現在 ${inboundIds.length} 件）。` };
  }
  const uniq = new Set(inboundIds);
  if (uniq.size !== inboundIds.length) {
    return { ok: false, error: "同じ在庫IDを重複して選べません。" };
  }

  const { data: strictRows, error: strictErr } = await supabase
    .from("inbound_items")
    .select("id, jan_code, condition_type, order_id")
    .in("id", inboundIds)
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
  if (strictErr) return { ok: false, error: strictErr.message };
  if ((strictRows?.length ?? 0) !== inboundIds.length) {
    return { ok: false, error: "指定した在庫の一部が見つからないか、引当対象外です。" };
  }

  const countPickedByJan = new Map<string, number>();
  for (const r of strictRows ?? []) {
    const jan = String(r.jan_code ?? "").trim();
    if (!jan) return { ok: false, error: "在庫にJANがありません。" };
    if (normalizeStockCondition(r.condition_type) !== orderCond) {
      return { ok: false, error: "選択した在庫のコンディションが注文と一致しません。" };
    }
    const avail = filterAvailableByOrderId([r as { order_id: string | null }], amazonOrderId);
    if (avail.length === 0) {
      return { ok: false, error: "在庫がこの注文に紐付けできません。" };
    }
    countPickedByJan.set(jan, (countPickedByJan.get(jan) ?? 0) + 1);
  }

  for (const [jan, need] of needByJan) {
    const got = countPickedByJan.get(jan) ?? 0;
    if (got !== need) {
      return { ok: false, error: `JAN ${jan} は ${need} 件必要ですが ${got} 件です。` };
    }
  }

  const janForOrder =
    uniqueJanFromSkuMappings(mapList) ||
    String(mapList[0]?.jan_code ?? "").trim() ||
    null;

  return { ok: true, janForOrder };
}

export function parseOrderConditionForManual(conditionId: string | null | undefined): NormalizedListingCondition | null {
  return normalizeOrderCondition(conditionId);
}
