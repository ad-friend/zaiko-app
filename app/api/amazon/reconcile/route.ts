/**
 * Amazon注文 自動消込エンジン（API）
 * - pending かつ (jan_code IS NULL OR condition_id IS NULL) を最大20件取得し、SP で JAN・condition・ASIN を補完（products は既存 JAN の asin のみ UPDATE）
 * - 続けて pending を最大20件マッチング（sku_mappings セット・コンディション正規化・Used 安全装置・引き当て時は order_id のみ。settled_at は本消込まで NULL）
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
} from "@/lib/amazon-order-reconciliation-status";
import { normalizeOrderCondition, normalizeStockCondition } from "@/lib/amazon-condition-match";
import { healReconcileOrdersFromSpApi } from "@/lib/amazon-reconcile-sp-heal";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

/** inbound_items.id は PostgREST 経由で number になることが多く、string 前提の localeCompare は落ちる */
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

async function updateAmazonOrderReconciliation(
  orderRowId: string,
  status: typeof AMAZON_ORDER_STATUS_RECONCILED | typeof AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  jan: string | null
): Promise<{ error: Error | null }> {
  const { error } = await supabase
    .from("amazon_orders")
    .update({
      reconciliation_status: status,
      jan_code: jan,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderRowId);
  return { error: error ? new Error(error.message) : null };
}

async function unlinkInboundFromOrder(inboundIds: number[], amazonOrderId: string): Promise<void> {
  if (inboundIds.length === 0) return;
  await supabase
    .from("inbound_items")
    .update({ order_id: null, settled_at: null })
    .in("id", inboundIds)
    .eq("order_id", amazonOrderId);
}

/** sku_mappings から JAN が一意に定まるときだけ返す（複数構成のセットは null） */
function uniqueJanFromSkuMappings(mapList: Array<{ jan_code: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = String(m.jan_code ?? "").trim();
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  const [only] = [...jans];
  return only ?? null;
}

function filterAvailableByOrderId<T extends { order_id: string | null }>(
  rows: T[],
  amazonOrderId: string
): T[] {
  const oidWant = String(amazonOrderId).trim();
  return rows.filter((row) => {
    const oid = row.order_id != null ? String(row.order_id).trim() : "";
    return !oid || oid === oidWant;
  });
}

async function finalizeReconciledInboundIds(
  inboundIds: number[],
  amazonOrderId: string,
  orderRowId: string,
  janForRow: string
): Promise<void> {
  const linked: number[] = [];
  for (const id of inboundIds) {
    const { error: uErr } = await supabase
      .from("inbound_items")
      .update({ order_id: amazonOrderId })
      .eq("id", id);
    if (uErr) {
      await unlinkInboundFromOrder(linked, amazonOrderId);
      throw new Error(uErr.message);
    }
    linked.push(id);
  }
  const { error: oErr } = await updateAmazonOrderReconciliation(orderRowId, AMAZON_ORDER_STATUS_RECONCILED, janForRow);
  if (oErr) {
    await unlinkInboundFromOrder(inboundIds, amazonOrderId);
    throw oErr;
  }
}

export async function POST() {
  try {
    const { data: healTargets, error: healFetchErr } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, condition_id, quantity, jan_code, asin")
      .eq("reconciliation_status", AMAZON_ORDER_STATUS_PENDING)
      .or("jan_code.is.null,condition_id.is.null")
      .order("created_at", { ascending: true })
      .limit(20);

    if (healFetchErr) throw healFetchErr;
    await healReconcileOrdersFromSpApi(supabase, healTargets ?? []);

    const { data: pendingOrders, error: fetchError } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, condition_id, quantity, jan_code, asin")
      .eq("reconciliation_status", AMAZON_ORDER_STATUS_PENDING)
      .order("created_at", { ascending: true })
      .limit(20);

    if (fetchError) throw fetchError;
    if (!pendingOrders?.length) {
      return NextResponse.json({
        ok: true,
        message: "対象のpending注文がありません。",
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
      const orderId = order.amazon_order_id;
      const orderQty = Math.max(1, Number(order.quantity) || 1);
      const sku = String(order.sku ?? "").trim();

      console.log(`\n=== 🔍 注文チェック: ${orderId} ===`);
      console.log(`SKU: ${sku}, コンディション: ${order.condition_id}, 注文JAN: ${order.jan_code}`);

      const orderCond = normalizeOrderCondition(order.condition_id);
      if (!orderCond) {
        console.log(`❌ 注文コンディションを new/used に判定できない: ${order.condition_id}`);
        const { error } = await updateAmazonOrderReconciliation(
          order.id,
          AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
          String(order.jan_code ?? "").trim() || null
        );
        if (error) throw error;
        manualRequired++;
        continue;
      }

      const { data: mappings } = await supabase
        .from("sku_mappings")
        .select("jan_code, quantity")
        .eq("sku", sku)
        .eq("platform", "Amazon");

      const mapList = mappings ?? [];
      const isSetProduct =
        mapList.length > 0 && (mapList.length > 1 || (Number(mapList[0].quantity) || 1) > 1);

      if (isSetProduct) {
        if (orderCond === "used" && orderQty >= 2) {
          skippedUsedSafety++;
          continue;
        }
        try {
          const collectedIds: number[] = [];
          let setOk = true;
          let usedSafetyAbortSet = false;
          for (const m of mapList) {
            const need = (Number(m.quantity) || 1) * orderQty;
            const { data: stockRows, error: stockErr } = await supabase
              .from("inbound_items")
              .select("id, condition_type, created_at, order_id")
              .eq("jan_code", m.jan_code)
              .is("settled_at", null)
              .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
            if (stockErr) throw stockErr;
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
            skippedUsedSafety++;
            continue;
          }
          if (setOk && collectedIds.length > 0) {
            const janForRow =
              String(order.jan_code ?? "").trim() ||
              uniqueJanFromSkuMappings(mapList) ||
              String(mapList[0]?.jan_code ?? "").trim() ||
              null;
            if (!janForRow) {
              const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, null);
              if (error) throw error;
              manualRequired++;
              continue;
            }
            await finalizeReconciledInboundIds(collectedIds, orderId, order.id, janForRow);
            completed++;
            continue;
          }
        } catch (e) {
          console.error("[amazon/reconcile] set product path failed order id=%s:", order.id, e);
        }
      }

      let jan = String(order.jan_code ?? "").trim();
      if (!jan) {
        const fromMaps = uniqueJanFromSkuMappings(mapList);
        if (fromMaps) jan = fromMaps;
      }
      if (!jan) {
        console.log("❌ jan_code が空のため手動確認");
        const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, null);
        if (error) throw error;
        manualRequired++;
        continue;
      }

      const { data: stockRows, error: stockErr } = await supabase
        .from("inbound_items")
        .select("id, condition_type, created_at, order_id")
        .eq("jan_code", jan)
        .is("settled_at", null)
        .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);

      if (stockErr) throw stockErr;

      const available = filterAvailableByOrderId(stockRows ?? [], orderId);

      const matching = available
        .filter((row) => normalizeStockCondition(row.condition_type) === orderCond)
        .sort(sortFifo);

      console.log(`📦 JAN一致・未販売・条件一致: ${matching.length} 件（注文側=${orderCond}, 必要数=${orderQty}）`);

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
          console.log(
            `📦 引当テスト: 注文ID=[${order.id}], 注文Cond=[${orderCond}], 必要数=[${orderQty}], 利用可能在庫数=[${available.length}], 条件一致在庫数=[${matching.length}], 検索JAN=[${jan}]`
          );
          if (matching.length >= orderQty) {
            await finalizeReconciled(matching.slice(0, orderQty));
          } else {
            const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, jan);
            if (error) throw error;
            manualRequired++;
          }
          continue;
        }

        if (matching.length >= 2) {
          skippedUsedSafety++;
          continue;
        }
        if (matching.length === 1 && orderQty === 1) {
          await finalizeReconciled(matching);
        } else {
          skippedUsedSafety++;
          continue;
        }
      } catch (e) {
        console.error("[amazon/reconcile] order row id=%s rollback or failure:", order.id, e);
        const { error: mErr } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, jan);
        if (mErr) throw mErr;
        manualRequired++;
      }
    }

    return NextResponse.json({
      ok: true,
      message: "消込処理を実行しました。",
      processed: pendingOrders.length,
      completed,
      manual_required: manualRequired,
      skipped_used_safety: skippedUsedSafety,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "消込処理に失敗しました。";
    console.error("[amazon/reconcile]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
