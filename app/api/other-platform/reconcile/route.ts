/**
 * 他販路 在庫引当（Amazon /api/amazon/reconcile 相当）
 * pending の other_orders を処理し、inbound_items.order_id のみ設定（settled_at は本消込まで NULL）
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  OTHER_ORDER_STATUS_MANUAL_REQUIRED,
  OTHER_ORDER_STATUS_PENDING,
  OTHER_ORDER_STATUS_RECONCILED,
} from "@/lib/other-platform-reconciliation-status";
import { normalizeOrderCondition, normalizeStockCondition } from "@/lib/amazon-condition-match";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";
import {
  normalizeOtherPlatformJan,
  otherPlatformJanLookupVariants,
} from "@/lib/other-platform-jan";

function compareInboundRowId(a: unknown, b: unknown): number {
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function sortFifo(a: { id: unknown; created_at: string | null }, b: { id: unknown; created_at: string | null }): number {
  const ta = a.created_at ? Date.parse(a.created_at) : 0;
  const tb = b.created_at ? Date.parse(b.created_at) : 0;
  if (ta !== tb) return ta - tb;
  return compareInboundRowId(a.id, b.id);
}

async function updateOtherOrderReconciliation(
  orderRowId: string,
  status: typeof OTHER_ORDER_STATUS_RECONCILED | typeof OTHER_ORDER_STATUS_MANUAL_REQUIRED,
  jan: string | null
): Promise<{ error: Error | null }> {
  const legacyStatus = status === OTHER_ORDER_STATUS_RECONCILED ? "completed" : "manual_required";
  const { error } = await supabase
    .from("other_orders")
    .update({
      reconciliation_status: status,
      status: legacyStatus,
      jan_code: jan,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderRowId);
  return { error: error ? new Error(error.message) : null };
}

async function unlinkInboundFromOrder(inboundIds: number[], orderId: string): Promise<void> {
  if (inboundIds.length === 0) return;
  await supabase
    .from("inbound_items")
    .update({ order_id: null, settled_at: null })
    .in("id", inboundIds)
    .eq("order_id", orderId);
}

function uniqueJanFromSkuMappings(mapList: Array<{ jan_code: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = normalizeOtherPlatformJan(String(m.jan_code ?? "").trim());
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  const [only] = [...jans];
  return only ?? null;
}

async function fetchInboundByJanVariants(
  jan: string,
  select: string
): Promise<Array<{ id: number; condition_type: string | null; created_at: string | null; order_id: string | null }>> {
  const variants = otherPlatformJanLookupVariants(jan);
  if (variants.length === 0) return [];
  const { data, error } = await supabase
    .from("inbound_items")
    .select(select)
    .in("jan_code", variants)
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
  if (error) throw error;
  return (data ?? []) as unknown as Array<{
    id: number;
    condition_type: string | null;
    created_at: string | null;
    order_id: string | null;
  }>;
}

function resolveOrderJan(orderJan: string | null | undefined, mapList: Array<{ jan_code: unknown }>): string | null {
  let jan = normalizeOtherPlatformJan(orderJan);
  if (!jan) jan = uniqueJanFromSkuMappings(mapList);
  return jan;
}

function filterAvailableByOrderId<T extends { order_id: string | null }>(rows: T[], orderId: string): T[] {
  const oidWant = String(orderId).trim();
  return rows.filter((row) => {
    const oid = row.order_id != null ? String(row.order_id).trim() : "";
    return !oid || oid === oidWant;
  });
}

async function finalizeReconciledInboundIds(
  inboundIds: number[],
  orderId: string,
  orderRowId: string,
  janForRow: string
): Promise<void> {
  const linked: number[] = [];
  for (const id of inboundIds) {
    const { error: uErr } = await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", id);
    if (uErr) {
      await unlinkInboundFromOrder(linked, orderId);
      throw new Error(uErr.message);
    }
    linked.push(id);
  }
  const { error: oErr } = await updateOtherOrderReconciliation(orderRowId, OTHER_ORDER_STATUS_RECONCILED, janForRow);
  if (oErr) {
    await unlinkInboundFromOrder(inboundIds, orderId);
    throw oErr;
  }
}

export async function POST() {
  try {
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("other_orders")
      .select("id, order_id, platform, sku, condition_id, quantity, jan_code")
      .eq("reconciliation_status", OTHER_ORDER_STATUS_PENDING)
      .order("created_at", { ascending: true })
      .limit(20);

    if (fetchError) throw fetchError;
    if (!pendingOrders?.length) {
      return NextResponse.json({
        ok: true,
        message: "対象の pending 注文がありません。",
        processed: 0,
        completed: 0,
        manual_required: 0,
        skipped_used_safety: 0,
      });
    }

    let completed = 0;
    let manualRequired = 0;
    let skippedUsedSafety = 0;

    for (const order of pendingOrders) {
      const orderId = String(order.order_id ?? "").trim();
      const platform = String(order.platform ?? "").trim();
      const orderQty = Math.max(1, Number(order.quantity) || 1);
      const sku = String(order.sku ?? "").trim();

      const orderCond = normalizeOrderCondition(order.condition_id);
      if (!orderCond) {
        const { error } = await updateOtherOrderReconciliation(
          order.id,
          OTHER_ORDER_STATUS_MANUAL_REQUIRED,
          normalizeOtherPlatformJan(order.jan_code)
        );
        if (error) throw error;
        manualRequired++;
        continue;
      }

      const { data: mappings } = await supabase
        .from("sku_mappings")
        .select("jan_code, quantity")
        .eq("sku", sku)
        .eq("platform", platform);

      const mapList = mappings ?? [];
      const isSetProduct =
        mapList.length > 0 && (mapList.length > 1 || (Number(mapList[0].quantity) || 1) > 1);

      if (isSetProduct) {
        if (orderCond === "used" && orderQty >= 2) {
          const janForRow =
            normalizeOtherPlatformJan(order.jan_code) ||
            uniqueJanFromSkuMappings(mapList) ||
            normalizeOtherPlatformJan(mapList[0]?.jan_code) ||
            null;
          const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, janForRow);
          if (error) throw error;
          manualRequired++;
          skippedUsedSafety++;
          continue;
        }
        try {
          const collectedIds: number[] = [];
          let setOk = true;
          let usedSafetyAbortSet = false;
          for (const m of mapList) {
            const need = (Number(m.quantity) || 1) * orderQty;
            const mappingJan = normalizeOtherPlatformJan(m.jan_code);
            if (!mappingJan) {
              setOk = false;
              break;
            }
            const stockRows = await fetchInboundByJanVariants(
              mappingJan,
              "id, condition_type, created_at, order_id"
            );
            const available = filterAvailableByOrderId(stockRows ?? [], orderId);
            const matching = available
              .filter((row) => normalizeStockCondition(row.condition_type) === orderCond)
              .sort(sortFifo);
            if (matching.length < need) {
              setOk = false;
              break;
            }
            if (orderCond === "used" && matching.length > need) {
              setOk = false;
              usedSafetyAbortSet = true;
              break;
            }
            collectedIds.push(...matching.slice(0, need).map((r) => r.id));
          }
          if (usedSafetyAbortSet) {
            const janForRow =
              normalizeOtherPlatformJan(order.jan_code) ||
              uniqueJanFromSkuMappings(mapList) ||
              normalizeOtherPlatformJan(mapList[0]?.jan_code) ||
              null;
            const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, janForRow);
            if (error) throw error;
            manualRequired++;
            skippedUsedSafety++;
            continue;
          }
          if (setOk && collectedIds.length > 0) {
            const janForRow =
              normalizeOtherPlatformJan(order.jan_code) ||
              uniqueJanFromSkuMappings(mapList) ||
              normalizeOtherPlatformJan(mapList[0]?.jan_code) ||
              null;
            if (!janForRow) {
              const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, null);
              if (error) throw error;
              manualRequired++;
              continue;
            }
            await finalizeReconciledInboundIds(collectedIds, orderId, order.id, janForRow);
            completed++;
            continue;
          }
        } catch (e) {
          console.error("[other-platform/reconcile] set product failed order id=%s:", order.id, e);
        }
      }

      let jan = resolveOrderJan(order.jan_code, mapList);
      if (!jan) {
        const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, null);
        if (error) throw error;
        manualRequired++;
        continue;
      }


      const stockRows = await fetchInboundByJanVariants(jan, "id, condition_type, created_at, order_id");
      const available = filterAvailableByOrderId(stockRows, orderId);
      const matching = available
        .filter((row) => normalizeStockCondition(row.condition_type) === orderCond)
        .sort(sortFifo);

      const finalizeReconciled = async (pick: typeof matching) => {
        await finalizeReconciledInboundIds(
          pick.map((p) => p.id),
          orderId,
          order.id,
          jan
        );
        completed++;
      };

      try {
        if (orderCond === "new") {
          if (matching.length >= orderQty) {
            await finalizeReconciled(matching.slice(0, orderQty));
          } else {
            const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, jan);
            if (error) throw error;
            manualRequired++;
          }
          continue;
        }

        if (matching.length === 1 && orderQty === 1) {
          await finalizeReconciled(matching);
          continue;
        }

        const { error } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, jan);
        if (error) throw error;
        manualRequired++;
        skippedUsedSafety++;
      } catch (e) {
        console.error("[other-platform/reconcile] order row id=%s failure:", order.id, e);
        const { error: mErr } = await updateOtherOrderReconciliation(order.id, OTHER_ORDER_STATUS_MANUAL_REQUIRED, jan);
        if (mErr) throw mErr;
        manualRequired++;
      }
    }

    return NextResponse.json({
      ok: true,
      message: "在庫引当を実行しました。",
      processed: pendingOrders.length,
      completed,
      manual_required: manualRequired,
      skipped_used_safety: skippedUsedSafety,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫引当に失敗しました。";
    console.error("[other-platform/reconcile]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
