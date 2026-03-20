/**
 * Amazon注文取得API (GET)
 * SP-API で注文一覧・Order Items を取得し、amazon_orders に upsert する。
 * 明細の ASIN はそのまま asin カラムに保存（JAN変換は行わない。消込は注文asinと在庫asinの一致で行う）。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const MARKETPLACE_ID_JP = "A1VC38T7YXB528";

function is13DigitJan(s: string): boolean {
  return /^\d{13}$/.test(String(s).trim());
}

function normalizeConditionId(conditionId: string | null | undefined): "New" | "Used" {
  const c = String(conditionId ?? "").trim().toLowerCase();
  if (c === "new" || c === "newitem" || c === "new_item") return "New";
  return "Used";
}

function parseDateRange(startDate: string | null, endDate: string | null): { createdAfter: string; createdBefore: string } {
  let createdAfter: string;
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())) {
    createdAfter = `${startDate.trim()}T00:00:00Z`;
  } else {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    createdAfter = `${y}-${m}-${day}T00:00:00Z`;
  }
  let createdBefore: string;
  if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
    const endDay = new Date(endDate.trim() + "T00:00:00Z");
    endDay.setUTCDate(endDay.getUTCDate() + 1);
    createdBefore = endDay.toISOString().slice(0, 19) + "Z";
  } else {
    createdBefore = new Date().toISOString().slice(0, 19) + "Z";
  }
  return { createdAfter, createdBefore };
}

function createSpClient() {
  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;
  const accessKey = process.env.SP_API_AWS_ACCESS_KEY;
  const secretKey = process.env.SP_API_AWS_SECRET_KEY;
  if (!clientId || !clientSecret || !refreshToken || !accessKey || !secretKey) {
    throw new Error("SP-APIの認証情報が不足しています（.env.local の SP_API_* を確認してください）");
  }
  const SellingPartnerAPI = require("amazon-sp-api");
  return new SellingPartnerAPI({
    region: "fe",
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      AWS_SELLING_PARTNER_ROLE: "",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const { createdAfter, createdBefore } = parseDateRange(startDate, endDate);

    const spClient = createSpClient();

    const allOrders: Array<{ AmazonOrderId: string; OrderStatus?: string }> = [];
    let nextToken: string | null = null;

    do {
      const query: Record<string, unknown> = {
        CreatedAfter: createdAfter,
        CreatedBefore: createdBefore,
        MarketplaceIds: [MARKETPLACE_ID_JP],
        OrderStatuses: ["Unshipped", "PartiallyShipped", "Shipped", "Canceled"],
      };
      if (nextToken) query.NextToken = nextToken;

      const ordersRes = (await spClient.callAPI({
        operation: "getOrders",
        endpoint: "orders",
        query,
      })) as { Orders?: Array<{ AmazonOrderId: string; OrderStatus?: string }>; NextToken?: string };

      const orders = ordersRes?.Orders ?? [];
      allOrders.push(...orders);
      nextToken = ordersRes?.NextToken ?? null;
      if (nextToken) await sleep(1000);
    } while (nextToken);

    const rows: Array<{
      amazon_order_id: string;
      sku: string;
      quantity: number;
      condition_id: string;
      reconciliation_status: string;
      jan_code: string | null;
      asin: string | null;
    }> = [];
    const seenOrderIds = new Set<string>();

    for (const order of allOrders) {
      const amazonOrderId = order.AmazonOrderId;
      if (!amazonOrderId) continue;

      // 発送前キャンセル（Canceled）: 引き当てを巻き戻す
      if (order.OrderStatus === "Canceled") {
        const { error: rollbackErr } = await supabase
          .from("inbound_items")
          .update({ settled_at: null, order_id: null })
          .eq("order_id", amazonOrderId);

        if (rollbackErr) throw rollbackErr;
        continue;
      }

      if (seenOrderIds.has(amazonOrderId)) continue;
      seenOrderIds.add(amazonOrderId);

      let orderItems: Array<{
        SellerSKU?: string;
        ASIN?: string;
        QuantityOrdered?: number;
        ConditionId?: string;
      }> = [];
      let fetchSuccess = false;

      // API制限対策：最大3回までリトライする
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const itemsRes = (await spClient.callAPI({
            operation: "getOrderItems",
            endpoint: "orders",
            path: { orderId: amazonOrderId },
          })) as { OrderItems?: typeof orderItems };
          
          orderItems = itemsRes?.OrderItems ?? [];
          fetchSuccess = true;
          await sleep(500); // 成功時も少し待機してAPI制限を予防
          break; // 成功したらリトライループを抜ける
        } catch (e) {
          console.warn(`[fetch-orders] getOrderItems failed: ${amazonOrderId} (試行 ${attempt}/3)`, e);
          if (attempt < 3) {
            await sleep(2000); // エラー時は2秒待機して再挑戦
          }
        }
      }

      // 3回やってもダメだった場合
      if (!fetchSuccess) {
        console.warn(`[fetch-orders] ${amazonOrderId} の明細取得を断念。ASINなしで保存を続行します。`);
        // ここにあった continue; を削除したため、スキップされずに空のまま保存されます
      }

      for (const item of orderItems) {
        const sku = String(item.SellerSKU ?? "").trim();
        const qty = Math.max(1, Number(item.QuantityOrdered) || 1);
        const conditionId = normalizeConditionId(item.ConditionId);
        const asin = item.ASIN ? String(item.ASIN).trim() : null;
        const jan_code = is13DigitJan(sku) ? sku : null;

        rows.push({
          amazon_order_id: amazonOrderId,
          sku: sku || "UNKNOWN",
          quantity: qty,
          condition_id: conditionId,
          reconciliation_status: "pending",
          jan_code,
          asin,
        });
      }

      await sleep(300);
    }

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "取得した注文は0件でした。",
        ordersFetched: allOrders.length,
        orderItemsProcessed: 0,
        rowsUpserted: 0,
      });
    }

    const { data: upserted, error } = await supabase
      .from("amazon_orders")
      .upsert(
        rows.map((r) => ({
          ...r,
          updated_at: new Date().toISOString(),
        })),
        {
          onConflict: "amazon_order_id,sku",
          ignoreDuplicates: false,
        }
      )
      .select("id");

    if (error) {
      if (error.code === "42P01") {
        return NextResponse.json(
          {
            error:
              "amazon_orders テーブルが存在しません。docs/amazon_orders_table.sql を実行し、かつ (amazon_order_id, sku) の UNIQUE 制約を追加してください。",
          },
          { status: 500 }
        );
      }
      throw error;
    }

    const rowsUpserted = Array.isArray(upserted) ? upserted.length : 0;

    return NextResponse.json({
      ok: true,
      message: "注文データを取得し、amazon_orders に保存しました。",
      ordersFetched: allOrders.length,
      orderItemsProcessed: rows.length,
      rowsUpserted,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "注文の取得・保存に失敗しました。";
    console.error("[fetch-orders]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
