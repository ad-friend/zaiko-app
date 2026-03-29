import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";

type ParsedOtherSalesRow = {
  orderId: string;
  platform: string;
  sellPrice: number;
  janCode?: string;
  sku?: string;
};

type OtherOrderStatus = "pending" | "completed" | "manual_required";

const buildTxEventHash = (payload: {
  orderId: string;
  platform: string;
  sellPrice: number;
}): string => {
  // sales_transactions 側の一意制約(amazon_event_hash)用。stockId は含めない（手動確定で upsert し直すため）
  const raw = [payload.orderId, payload.platform, String(payload.sellPrice), "OtherSales", "Sell"].join("_");
  return createHash("sha256").update(raw).digest("hex");
};

const toNullableString = (v: unknown) => {
  const s = v == null ? "" : String(v);
  const t = s.trim();
  return t ? t : null;
};

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;

    let q = supabase
      .from("other_orders")
      .select("id, order_id, platform, sell_price, jan_code, stock_id, status, created_at, updated_at");

    if (status) q = q.eq("status", status as OtherOrderStatus);

    q = q.order("created_at", { ascending: false });

    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 自動一括消込エンジン（API）
 * POST: { orderId, platform, sellPrice, janCode?, sku? }[] を受け取り、
 * - other_orders を pending で insert/upsert
 * - 在庫を sku 優先（created_at 古い順1件）→janCode 古い順1件で引当
 * - 成功時: inbound_items更新 + sales_transactions insert + other_orders completed
 * - 失敗時: other_orders manual_required に更新
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rows: ParsedOtherSalesRow[] = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : [];

    if (!rows.length) {
      return NextResponse.json({ error: "CSVのパース結果（配列）を送ってください。" }, { status: 400 });
    }

    let completed = 0;
    let manualRequired = 0;
    const results: Array<
      | {
          ok: true;
          input: ParsedOtherSalesRow;
          otherOrderId: string | null;
          status: "completed" | "manual_required";
          matchedStockId?: number | null;
        }
      | { ok: false; input: ParsedOtherSalesRow; otherOrderId: string | null; status: "error"; error: string }
    > = [];

    for (const input of rows) {
      const orderId = String(input.orderId ?? "").trim();
      const platform = String(input.platform ?? "").trim();
      const sellPrice = Number(input.sellPrice);
      const janCode = toNullableString(input.janCode);
      const sku = toNullableString(input.sku);

      const otherOrderPayload = {
        order_id: orderId,
        platform,
        sell_price: Number.isFinite(sellPrice) ? sellPrice : 0,
        jan_code: janCode,
        stock_id: null,
        status: "pending" as OtherOrderStatus,
      };

      if (!orderId || !platform || !Number.isFinite(sellPrice) || sellPrice < 0) {
        results.push({
          ok: false,
          input,
          otherOrderId: null,
          status: "error",
          error: "入力データが不正です（orderId/platform/sellPrice）",
        });
        continue;
      }

      const nowIso = new Date().toISOString();

      try {
        // DB 側のユニーク制約が無いケースも考慮して、手動で「insert or update（疑似 upsert）」する
        const { data: existingRow, error: existingErr } = await supabase
          .from("other_orders")
          .select("id")
          .eq("order_id", orderId)
          .eq("platform", platform)
          .maybeSingle();

        if (existingErr) throw existingErr;

        let otherOrderId: string | null = existingRow?.id ?? null;

        if (otherOrderId) {
          const { error: updErr } = await supabase
            .from("other_orders")
            .update({ ...otherOrderPayload, updated_at: nowIso })
            .eq("id", otherOrderId);
          if (updErr) throw updErr;
        } else {
          const { data: insertedRow, error: insertErr } = await supabase
            .from("other_orders")
            .insert([{ ...otherOrderPayload, updated_at: nowIso }])
            .select("id")
            .single();
          if (insertErr) throw insertErr;
          otherOrderId = insertedRow?.id ?? null;
        }

        if (!otherOrderId) throw new Error("other_orders の UUID 取得に失敗しました。");

        // 1) sku 優先で引当（created_at の古い順）
        let matchedStockId: number | null = null;
        let matchedEffectiveUnitPrice: number | null = null;

        // 1) CSVに sku がある場合
        //    sku_mappings を引き、対応する jan_code を使って inbound_items から古い順1件（settled_at=null）を取得する
        if (sku) {
          const { data: mappings, error: mapErr } = await supabase
            .from("sku_mappings")
            .select("jan_code")
            .eq("sku", sku)
            .order("created_at", { ascending: true })
            .limit(1);

          if (mapErr) throw mapErr;

          const mappedJanCode = mappings?.[0]?.jan_code ?? null;
          if (!mappedJanCode) {
            const { error: updErr } = await supabase
              .from("other_orders")
              .update({ status: "manual_required", updated_at: nowIso })
              .eq("id", otherOrderId);
            if (updErr) throw updErr;

            manualRequired++;
            results.push({
              ok: true,
              input,
              otherOrderId,
              status: "manual_required",
              matchedStockId: null,
            });
            continue;
          }

          const { data: stockRows, error: stockErr } = await supabase
            .from("inbound_items")
            .select("id,effective_unit_price")
            .eq("jan_code", mappedJanCode)
            .is("settled_at", null)
            .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
            .order("created_at", { ascending: true })
            .limit(1);

          if (stockErr) throw stockErr;
          if (stockRows?.[0]?.id) {
            matchedStockId = stockRows[0].id;
            matchedEffectiveUnitPrice =
              stockRows[0].effective_unit_price != null ? Number(stockRows[0].effective_unit_price) : null;
          }
        }

        // 2) CSVに sku がなく、janCode がある場合
        if (!sku && matchedStockId == null && janCode) {
          const { data: candidateRows, error: candErr } = await supabase
            .from("inbound_items")
            .select("id,effective_unit_price")
            .eq("jan_code", janCode)
            .is("settled_at", null)
            .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
            .order("created_at", { ascending: true })
            .limit(1);

          if (candErr) throw candErr;
          if (candidateRows?.[0]?.id) {
            matchedStockId = candidateRows[0].id;
            matchedEffectiveUnitPrice =
              candidateRows[0].effective_unit_price != null ? Number(candidateRows[0].effective_unit_price) : null;
          }
        }

        if (matchedStockId == null) {
          const { error: updErr } = await supabase
            .from("other_orders")
            .update({ status: "manual_required", updated_at: nowIso })
            .eq("id", otherOrderId);

          if (updErr) throw updErr;

          manualRequired++;
          results.push({
            ok: true,
            input,
            otherOrderId,
            status: "manual_required",
            matchedStockId: null,
          });
          continue;
        }

        const unitCost = matchedEffectiveUnitPrice != null ? matchedEffectiveUnitPrice : 0;

        // 在庫更新（settled_at + order_id）
        const { error: updateStockErr } = await supabase
          .from("inbound_items")
          .update({ settled_at: nowIso, order_id: orderId })
          .eq("id", matchedStockId)
          .is("settled_at", null);

        if (updateStockErr) throw updateStockErr;

        // 売上トランザクション作成
        const txEventHash = buildTxEventHash({ orderId, platform, sellPrice });
        const insertPayload = {
          amazon_order_id: orderId,
          sku: sku ?? null,
          transaction_type: "Order",
          amount_type: "Sell",
          amount_description: platform,
          amount: sellPrice,
          posted_date: nowIso,
          amazon_event_hash: txEventHash,
          stock_id: matchedStockId,
          unit_cost: unitCost,
        };

        const { error: insertTxErr } = await supabase
          .from("sales_transactions")
          .upsert([insertPayload], { onConflict: "amazon_event_hash" })
          .select("id");

        if (insertTxErr) throw insertTxErr;

        // other_orders 完了
        const { error: updOtherErr } = await supabase
          .from("other_orders")
          .update({ status: "completed", stock_id: matchedStockId, updated_at: nowIso })
          .eq("id", otherOrderId);

        if (updOtherErr) throw updOtherErr;

        completed++;
        results.push({
          ok: true,
          input,
          otherOrderId,
          status: "completed",
          matchedStockId,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "処理に失敗しました";
        results.push({
          ok: false,
          input,
          otherOrderId: null,
          status: "error",
          error: message,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      processed: rows.length,
      completed,
      manual_required: manualRequired,
      results,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "自動消込に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

