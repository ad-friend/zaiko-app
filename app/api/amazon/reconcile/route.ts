/**
 * Amazon注文 自動消込エンジン（API）
 * POST: reconciliation_status = 'pending' の注文のみ処理（reconciled / manual_required / canceled は対象外）
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
} from "@/lib/amazon-order-reconciliation-status";

type NormalizedCondition = "new" | "used";

function normalizeOrderCondition(conditionId: string | null | undefined): NormalizedCondition | null {
  const raw = String(conditionId ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "new" || raw === "新品" || raw.startsWith("new")) return "new";
  if (raw === "used" || raw === "中古" || raw.startsWith("used")) return "used";
  return null;
}

function normalizeStockCondition(conditionType: string | null | undefined): NormalizedCondition | null {
  const raw = String(conditionType ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "new" || raw === "新品") return "new";
  if (raw === "used" || raw === "中古") return "used";
  if (raw.includes("新品") && !raw.includes("中古")) return "new";
  if (raw.includes("中古")) return "used";
  if (raw.includes("new") && !raw.includes("used")) return "new";
  if (raw.includes("used")) return "used";
  return null;
}

function sortFifo(a: { id: number; created_at: string | null }, b: { id: number; created_at: string | null }): number {
  const ta = a.created_at ? Date.parse(a.created_at) : 0;
  const tb = b.created_at ? Date.parse(b.created_at) : 0;
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

async function updateAmazonOrderReconciliation(
  orderDbId: number,
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
    .eq("id", orderDbId);
  return { error: error ? new Error(error.message) : null };
}

async function unlinkInboundFromOrder(inboundIds: number[], amazonOrderId: string): Promise<void> {
  if (inboundIds.length === 0) return;
  await supabase.from("inbound_items").update({ order_id: null }).in("id", inboundIds).eq("order_id", amazonOrderId);
}

export async function POST() {
  try {
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, condition_id, quantity, jan_code")
      .eq("reconciliation_status", AMAZON_ORDER_STATUS_PENDING)
      .order("created_at", { ascending: true });

    if (fetchError) throw fetchError;
    if (!pendingOrders?.length) {
      return NextResponse.json({
        ok: true,
        message: "対象のpending注文がありません。",
        processed: 0,
        completed: 0,
        manual_required: 0,
      });
    }

    let completed = 0;
    let manualRequired = 0;

    for (const order of pendingOrders) {
      const orderId = order.amazon_order_id;
      const orderQty = Math.max(1, Number(order.quantity) || 1);
      const jan = String(order.jan_code ?? "").trim();

      console.log(`\n=== 🔍 注文チェック: ${orderId} ===`);
      console.log(`SKU: ${order.sku}, コンディション: ${order.condition_id}, 注文JAN: ${jan}`);

      if (!jan) {
        console.log("❌ amazon_orders.jan_code が空のため手動確認");
        const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, null);
        if (error) throw error;
        manualRequired++;
        continue;
      }

      const orderCond = normalizeOrderCondition(order.condition_id);
      if (!orderCond) {
        console.log(`❌ 注文コンディションを new/used に判定できない: ${order.condition_id}`);
        const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, jan);
        if (error) throw error;
        manualRequired++;
        continue;
      }

      const { data: stockRows, error: stockErr } = await supabase
        .from("inbound_items")
        .select("id, condition_type, created_at, order_id")
        .eq("jan_code", jan)
        .is("settled_at", null);

      if (stockErr) throw stockErr;

      const available = (stockRows ?? []).filter((row) => {
        const oid = row.order_id != null ? String(row.order_id).trim() : "";
        return !oid || oid === String(orderId).trim();
      });

      const matching = available
        .filter((row) => normalizeStockCondition(row.condition_type) === orderCond)
        .sort(sortFifo);

      console.log(`📦 JAN一致・未販売・条件一致: ${matching.length} 件（注文側=${orderCond}, 必要数=${orderQty}）`);

      const finalizeReconciled = async (pick: typeof matching) => {
        const ids = pick.map((p) => p.id);
        const linked: number[] = [];
        for (const row of pick) {
          const { error: uErr } = await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", row.id);
          if (uErr) {
            await unlinkInboundFromOrder(linked, orderId);
            throw new Error(uErr.message);
          }
          linked.push(row.id);
        }
        const { error: oErr } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_RECONCILED, jan);
        if (oErr) {
          await unlinkInboundFromOrder(ids, orderId);
          throw oErr;
        }
        completed++;
      };

      try {
        if (orderCond === "new") {
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
          const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, jan);
          if (error) throw error;
          manualRequired++;
          continue;
        }
        if (matching.length === 1 && orderQty === 1) {
          await finalizeReconciled(matching);
        } else {
          const { error } = await updateAmazonOrderReconciliation(order.id, AMAZON_ORDER_STATUS_MANUAL_REQUIRED, jan);
          if (error) throw error;
          manualRequired++;
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
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "消込処理に失敗しました。";
    console.error("[amazon/reconcile]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
