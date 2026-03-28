/**
 * Amazon注文 自動消込エンジン（API）
 * POST: reconciliation_status = 'pending' の注文に対して消込ロジックを実行する。
 *
 * ルール（ブレない前提）:
 * - 基準JANは amazon_orders.jan_code のみ（ASIN・SKUマスタで上書きしない）
 * - 対象在庫: inbound_items で jan_code が一致し settled_at IS NULL（未販売）
 * - 新品注文: 同一JAN・新品在庫が複数でも FIFO で必要数を自動消込（manual_required にしない）
 * - 中古注文: 同一JAN・中古在庫が 2 件以上なら必ず manual_required。ちょうど 1 件かつ注文数量 1 のみ自動消込
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

type NormalizedCondition = "new" | "used";

/** 注文側 condition_id（New / Used 等）を new | used に正規化 */
function normalizeOrderCondition(conditionId: string | null | undefined): NormalizedCondition | null {
  const raw = String(conditionId ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "new" || raw === "新品" || raw.startsWith("new")) return "new";
  if (raw === "used" || raw === "中古" || raw.startsWith("used")) return "used";
  return null;
}

/** 在庫側 condition_type（new / used / 新品 / 中古 等）を new | used に正規化 */
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

async function markManual(orderDbId: number, jan: string | null) {
  await supabase
    .from("amazon_orders")
    .update({
      reconciliation_status: "manual_required",
      jan_code: jan,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderDbId);
}

async function markCompleted(orderDbId: number, jan: string) {
  await supabase
    .from("amazon_orders")
    .update({
      reconciliation_status: "completed",
      jan_code: jan,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderDbId);
}

export async function POST() {
  try {
    const { data: pendingOrders, error: fetchError } = await supabase
      .from("amazon_orders")
      .select("id, amazon_order_id, sku, condition_id, quantity, jan_code")
      .eq("reconciliation_status", "pending")
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
        await markManual(order.id, null);
        manualRequired++;
        continue;
      }

      const orderCond = normalizeOrderCondition(order.condition_id);
      if (!orderCond) {
        console.log(`❌ 注文コンディションを new/used に判定できない: ${order.condition_id}`);
        await markManual(order.id, jan);
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

      if (orderCond === "new") {
        if (matching.length >= orderQty) {
          const pick = matching.slice(0, orderQty);
          for (const row of pick) {
            await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", row.id);
          }
          await markCompleted(order.id, jan);
          completed++;
        } else {
          await markManual(order.id, jan);
          manualRequired++;
        }
        continue;
      }

      // 中古
      if (matching.length >= 2) {
        await markManual(order.id, jan);
        manualRequired++;
        continue;
      }
      if (matching.length === 1 && orderQty === 1) {
        await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", matching[0].id);
        await markCompleted(order.id, jan);
        completed++;
      } else {
        await markManual(order.id, jan);
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
