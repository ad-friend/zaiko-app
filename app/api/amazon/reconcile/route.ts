/**
 * Amazon注文 自動消込エンジン（API）
 * POST: 画面上のボタンから実行。reconciliation_status = 'pending' の注文に対して消込ロジックを実行する。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const CONDITION_NEW = "New";
const CONDITION_USED = "Used";

function is13DigitJan(sku: string): boolean {
  return /^\d{13}$/.test(String(sku).trim());
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
      const sku = String(order.sku ?? "").trim();
      const conditionId = String(order.condition_id ?? "").trim();
      const orderQty = Math.max(1, Number(order.quantity) || 1);
      console.log(`\n=== 🔍 注文チェック: ${orderId} ===`);
      console.log(`SKU: ${sku}, コンディション: ${conditionId}, 注文のJAN: ${order.jan_code}`);

      // --- 最優先：SKUマスタ（sku_mappings）を検索 ---
      const { data: mappings } = await supabase
        .from("sku_mappings")
        .select("jan_code, quantity")
        .eq("sku", sku)
        .eq("platform", "Amazon");

      let masterJan = null;
      let isSetProduct = false;

      if (mappings && mappings.length > 0) {
        masterJan = mappings[0].jan_code; 
        isSetProduct = mappings.length > 1 || (mappings[0].quantity && mappings[0].quantity > 1);

        if (isSetProduct) {
          let allFound = true;
          const toUpdate: number[] = [];

          for (const m of mappings) {
            const need = (Number(m.quantity) || 1) * orderQty;
            const { data: items } = await supabase
              .from("inbound_items")
              .select("id")
              .eq("jan_code", m.jan_code)
              .or("order_id.is.null,order_id.eq.")
              .order("created_at", { ascending: true })
              .limit(need);
            
            if (!items || items.length < need) {
              allFound = false;
              break;
            }
            toUpdate.push(...items.map((x) => x.id));
          }

          if (allFound && toUpdate.length > 0) {
            for (const inboundId of toUpdate) {
              await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", inboundId);
            }
            await supabase.from("amazon_orders").update({ reconciliation_status: "completed", updated_at: new Date().toISOString() }).eq("id", order.id);
            completed++;
          }
          continue; 
        }
      }

      // --- JANコードの決定 ---
      const targetJan = masterJan || order.jan_code?.trim() || (is13DigitJan(sku) ? sku : null);
      console.log(`🎯 判定されたJAN: ${targetJan}`);
      if (!targetJan) console.log("⚠️ JANが特定できないためスキップします");

      if (!targetJan) continue; 

      // --- 新品（単一）の消込 ---
      if (conditionId === CONDITION_NEW) {
        const { data: candidates } = await supabase
          .from("inbound_items")
          .select("id")
          .eq("jan_code", targetJan)
          // ★修正：「新品」または「new」を含む在庫を探す
          .or("condition_type.eq.新品,condition_type.ilike.%new%") 
          .or("order_id.is.null,order_id.eq.")
          .order("created_at", { ascending: true })
          .limit(orderQty); 
          console.log(`📦 新品の在庫検索結果:`, candidates);

        if (candidates && candidates.length === orderQty) {
          for (const c of candidates) {
            await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", c.id);
          }
          await supabase.from("amazon_orders").update({ reconciliation_status: "completed", updated_at: new Date().toISOString() }).eq("id", order.id);
          completed++;
        }
        continue;
      }

      // --- 中古品（個体管理）の消込 ---
      if (conditionId === CONDITION_USED) {
        const { data: usedCandidates } = await supabase
          .from("inbound_items")
          .select("id")
          .eq("jan_code", targetJan)
          // ★修正：「中古」または「used」を含む在庫を探す
          .or("condition_type.eq.中古,condition_type.ilike.%used%") 
          .or("order_id.is.null,order_id.eq.")
          .order("created_at", { ascending: true });
          console.log(`📦 中古の在庫検索結果:`, usedCandidates);

        const count = usedCandidates?.length ?? 0;
        
        if (count === 1 && usedCandidates) {
          await supabase.from("inbound_items").update({ order_id: orderId }).eq("id", usedCandidates[0].id);
          await supabase.from("amazon_orders").update({ reconciliation_status: "completed", updated_at: new Date().toISOString() }).eq("id", order.id);
          completed++;
        } else if (count >= 2) {
          await supabase.from("amazon_orders").update({
              reconciliation_status: "manual_required",
              jan_code: targetJan,
              updated_at: new Date().toISOString(),
            }).eq("id", order.id);
          manualRequired++;
        }
        continue;
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