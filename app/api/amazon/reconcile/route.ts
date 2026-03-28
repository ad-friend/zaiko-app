/**
 * Amazon注文 自動消込エンジン（API）
 * POST: reconciliation_status = 'pending' のみ処理。
 * 1) pending かつ jan 未設定: ユニーク ASIN をバルク解決（products / amazon_orders / Catalog 各 ASIN 1 回＋sleep）
 * 2) sku_mappings セット品 → 単品 JAN 照合の既存フロー
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  AMAZON_ORDER_STATUS_MANUAL_REQUIRED,
  AMAZON_ORDER_STATUS_PENDING,
  AMAZON_ORDER_STATUS_RECONCILED,
} from "@/lib/amazon-order-reconciliation-status";
import { normalizeOrderCondition, normalizeStockCondition } from "@/lib/amazon-condition-match";
import { buildAsinToJanMap, is13DigitJan } from "@/lib/amazon-resolve-order-jan";
import { tryCreateSpClient } from "@/lib/amazon-sp-try-client";

function chunkIds(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
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
  orderDbId: number,
  janForRow: string
): Promise<void> {
  const linked: number[] = [];
  for (const id of inboundIds) {
    const { error: uErr } = await supabase.from("inbound_items").update({ order_id: amazonOrderId }).eq("id", id);
    if (uErr) {
      await unlinkInboundFromOrder(linked, amazonOrderId);
      throw new Error(uErr.message);
    }
    linked.push(id);
  }
  const { error: oErr } = await updateAmazonOrderReconciliation(orderDbId, AMAZON_ORDER_STATUS_RECONCILED, janForRow);
  if (oErr) {
    await unlinkInboundFromOrder(inboundIds, amazonOrderId);
    throw oErr;
  }
}

export async function POST() {
  try {
    const { data: pendingForJanFill, error: janFetchErr } = await supabase
      .from("amazon_orders")
      .select("id, sku, asin, jan_code")
      .eq("reconciliation_status", AMAZON_ORDER_STATUS_PENDING)
      .order("created_at", { ascending: true });

    if (janFetchErr) throw janFetchErr;

    if (!pendingForJanFill?.length) {
      return NextResponse.json({
        ok: true,
        message: "対象のpending注文がありません。",
        processed: 0,
        completed: 0,
        manual_required: 0,
      });
    }

    const needJan = pendingForJanFill.filter((r) => !String(r.jan_code ?? "").trim());
    if (needJan.length > 0) {
      const uniqueAsins = new Set<string>();
      for (const row of needJan) {
        const sku = String(row.sku ?? "").trim();
        if (is13DigitJan(sku)) continue;
        const asin = row.asin != null ? String(row.asin).trim() : "";
        if (asin.length >= 10) uniqueAsins.add(asin);
      }

      const asinToJan =
        uniqueAsins.size > 0
          ? await buildAsinToJanMap(supabase, tryCreateSpClient(), [...uniqueAsins])
          : new Map<string, string>();

      const janToOrderIds = new Map<string, number[]>();
      for (const row of needJan) {
        const sku = String(row.sku ?? "").trim();
        let resolved: string | null = null;
        if (is13DigitJan(sku)) resolved = sku;
        else {
          const asin = row.asin != null ? String(row.asin).trim() : "";
          if (asin.length >= 10) resolved = asinToJan.get(asin) ?? null;
        }
        if (!resolved) continue;
        const list = janToOrderIds.get(resolved) ?? [];
        list.push(row.id);
        janToOrderIds.set(resolved, list);
      }

      const nowJanIso = new Date().toISOString();
      for (const [jan, ids] of janToOrderIds) {
        for (const idChunk of chunkIds(ids, 200)) {
          const { error: upJanErr } = await supabase
            .from("amazon_orders")
            .update({ jan_code: jan, updated_at: nowJanIso })
            .in("id", idChunk);
          if (upJanErr) throw upJanErr;
        }
      }
    }

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
        try {
          const collectedIds: number[] = [];
          let setOk = true;
          for (const m of mapList) {
            const need = (Number(m.quantity) || 1) * orderQty;
            const { data: stockRows, error: stockErr } = await supabase
              .from("inbound_items")
              .select("id, condition_type, created_at, order_id")
              .eq("jan_code", m.jan_code)
              .is("settled_at", null);
            if (stockErr) throw stockErr;
            const available = filterAvailableByOrderId(stockRows ?? [], orderId);
            const matching = available
              .filter((row) => normalizeStockCondition(row.condition_type) === orderCond)
              .sort(sortFifo);
            if (matching.length < need) {
              setOk = false;
              break;
            }
            collectedIds.push(...matching.slice(0, need).map((r) => r.id));
          }
          if (setOk && collectedIds.length > 0) {
            const janForRow =
              String(order.jan_code ?? "").trim() ||
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
      if (!jan && mapList.length === 1 && !isSetProduct) {
        jan = String(mapList[0].jan_code ?? "").trim();
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
        .is("settled_at", null);

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
