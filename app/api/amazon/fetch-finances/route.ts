/**
 * Amazon 売上・手数料・返品・補填データ取得API (POST)
 * SP-API Finances listFinancialEvents で指定期間の財務イベントを取得し、
 * sales_transactions に amazon_event_hash で重複排除して保存する。
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";

type Currency = { CurrencyCode?: string; CurrencyAmount?: number };
type ChargeComponent = { ChargeType?: string; ChargeAmount?: Currency };
type FeeComponent = { FeeType?: string; FeeAmount?: Currency };
type ShipmentItem = {
  SellerSKU?: string;
  ItemChargeList?: ChargeComponent[];
  ItemFeeList?: FeeComponent[];
  ItemChargeAdjustmentList?: ChargeComponent[];
  ItemFeeAdjustmentList?: FeeComponent[];
};
type ShipmentEvent = {
  AmazonOrderId?: string;
  PostedDate?: string;
  ShipmentItemList?: ShipmentItem[];
};
type AdjustmentItem = { SellerSKU?: string; TotalAmount?: Currency };
type AdjustmentEvent = {
  PostedDate?: string;
  AdjustmentType?: string;
  AdjustmentAmount?: Currency;
  AdjustmentItemList?: AdjustmentItem[];
};
type FinancialEventsPayload = {
  ShipmentEventList?: ShipmentEvent[];
  RefundEventList?: ShipmentEvent[];
  AdjustmentEventList?: AdjustmentEvent[];
  NextToken?: string;
  [key: string]: unknown;
};

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

function toAmount(c: Currency | undefined): number {
  if (c == null) return 0;
  const n = Number(c.CurrencyAmount);
  return Number.isFinite(n) ? n : 0;
}

/** 手数料・返金等は負の値で統一 */
function toSignedAmount(amount: number, isFeeOrAdjustment: boolean): number {
  if (isFeeOrAdjustment && amount > 0) return -amount;
  return amount;
}

function buildEventHash(
  amazonOrderId: string | null,
  transactionType: string,
  amountType: string,
  amountDescription: string | null,
  amount: number,
  postedDate: string,
  eventIndex: number,
  rowIndex: number
): string {
  const raw = [amazonOrderId ?? "", transactionType, amountType, amountDescription ?? "", String(amount), postedDate, String(eventIndex), String(rowIndex)].join("_");
  return createHash("sha256").update(raw).digest("hex");
}

export type SalesTransactionRow = {
  amazon_order_id: string | null;
  sku: string | null;
  transaction_type: string;
  amount_type: string;
  amount_description: string | null;
  amount: number;
  posted_date: string;
  amazon_event_hash: string;
};

function flattenShipmentEvents(list: ShipmentEvent[] | undefined, transactionType: string): SalesTransactionRow[] {
  const rows: SalesTransactionRow[] = [];
  if (!Array.isArray(list)) return rows;
  let rowIndex = 0;
  list.forEach((ev, eventIndex) => {
    const orderId = ev.AmazonOrderId?.trim() ?? null;
    const posted = ev.PostedDate ?? "";
    const items = ev.ShipmentItemList ?? [];
    for (const item of items) {
      const sku = item.SellerSKU?.trim() ?? null;
      const charges = item.ItemChargeList ?? [];
      const fees = item.ItemFeeList ?? [];
      for (const c of charges) {
        const amount = toSignedAmount(toAmount(c.ChargeAmount), false);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "Charge",
          amount_description: c.ChargeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(orderId, transactionType, "Charge", c.ChargeType ?? null, amount, posted, eventIndex, rowIndex++),
        });
      }
      for (const f of fees) {
        const amount = toSignedAmount(toAmount(f.FeeAmount), true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "Fee",
          amount_description: f.FeeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(orderId, transactionType, "Fee", f.FeeType ?? null, amount, posted, eventIndex, rowIndex++),
        });
      }
      const chargeAdj = item.ItemChargeAdjustmentList ?? [];
      const feeAdj = item.ItemFeeAdjustmentList ?? [];
      for (const c of chargeAdj) {
        const amount = toSignedAmount(toAmount(c.ChargeAmount), true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "ChargeAdjustment",
          amount_description: c.ChargeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(orderId, transactionType, "ChargeAdjustment", c.ChargeType ?? null, amount, posted, eventIndex, rowIndex++),
        });
      }
      for (const f of feeAdj) {
        const amount = toSignedAmount(toAmount(f.FeeAmount), true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "FeeAdjustment",
          amount_description: f.FeeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(orderId, transactionType, "FeeAdjustment", f.FeeType ?? null, amount, posted, eventIndex, rowIndex++),
        });
      }
    }
  });
  return rows;
}

function flattenAdjustmentEvents(list: AdjustmentEvent[] | undefined): SalesTransactionRow[] {
  const rows: SalesTransactionRow[] = [];
  if (!Array.isArray(list)) return rows;
  let rowIndex = 0;
  list.forEach((ev, eventIndex) => {
    const posted = ev.PostedDate ?? "";
    const adjType = ev.AdjustmentType?.trim() ?? "Adjustment";
    const amount = toSignedAmount(toAmount(ev.AdjustmentAmount), false);
    const items = ev.AdjustmentItemList ?? [];
    if (items.length > 0) {
      for (const it of items) {
        const sku = it.SellerSKU?.trim() ?? null;
        const itemAmount = toSignedAmount(toAmount(it.TotalAmount), false);
        rows.push({
          amazon_order_id: null,
          sku,
          transaction_type: "Adjustment",
          amount_type: adjType,
          amount_description: null,
          amount: itemAmount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(null, "Adjustment", adjType, null, itemAmount, posted, eventIndex, rowIndex++),
        });
      }
    } else {
      rows.push({
        amazon_order_id: null,
        sku: null,
        transaction_type: "Adjustment",
        amount_type: adjType,
        amount_description: null,
        amount,
        posted_date: posted,
        amazon_event_hash: buildEventHash(null, "Adjustment", adjType, null, amount, posted, eventIndex, rowIndex++),
      });
    }
  });
  return rows;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    let startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    let endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    if (!startDate || !endDate) {
      return NextResponse.json(
        { error: "startDate と endDate を ISO 8601 形式で指定してください。" },
        { status: 400 }
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(startDate)) startDate = startDate.replace(/\./g, "-");
    if (!/^\d{4}-\d{2}-\d{2}/.test(endDate)) endDate = endDate.replace(/\./g, "-");
    let postedAfter = startDate.length <= 10 ? `${startDate}T00:00:00Z` : startDate;
    const endPart = endDate.length <= 10 ? endDate : endDate.slice(0, 10);
    const endDay = new Date(endPart + "T00:00:00Z");
    endDay.setUTCDate(endDay.getUTCDate() + 1);
    let postedBefore = endDay.toISOString().slice(0, 19) + "Z";

    const maxDate = new Date(Date.now() - 3 * 60 * 1000); // 余裕を持って3分前に設定
    if (new Date(postedBefore) > maxDate) {
      postedBefore = maxDate.toISOString().slice(0, 19) + "Z";
    }
    if (new Date(postedAfter) > maxDate) {
      postedAfter = maxDate.toISOString().slice(0, 19) + "Z";
    }
    // startDateとendDateが近すぎて逆転してしまった場合のエラー防止
    if (new Date(postedAfter) >= new Date(postedBefore)) {
      postedAfter = new Date(maxDate.getTime() - 60 * 1000).toISOString().slice(0, 19) + "Z";
    }

    const spClient = createSpClient();
    const allRows: SalesTransactionRow[] = [];
    let nextToken: string | null = null;

    do {
      const query: Record<string, unknown> = {
        PostedAfter: postedAfter,
        PostedBefore: postedBefore,
        MaxResultsPerPage: 100,
      };
      if (nextToken) query.NextToken = nextToken;

      const res = (await spClient.callAPI({
        operation: "listFinancialEvents",
        endpoint: "finances",
        query,
      })) as FinancialEventsPayload & { FinancialEvents?: FinancialEventsPayload; NextToken?: string };

      const events = res?.FinancialEvents ?? res;
      const list = Array.isArray(events.ShipmentEventList) ? events.ShipmentEventList : [];
      const refundList = Array.isArray(events.RefundEventList) ? events.RefundEventList : [];
      const adjList = Array.isArray(events.AdjustmentEventList) ? events.AdjustmentEventList : [];

      allRows.push(
        ...flattenShipmentEvents(list, "Order"),
        ...flattenShipmentEvents(refundList, "Refund"),
        ...flattenAdjustmentEvents(adjList)
      );

      nextToken = res.NextToken ?? events.NextToken ?? null;
      if (nextToken) await new Promise((r) => setTimeout(r, 1500));
    } while (nextToken);

    if (allRows.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "指定期間に財務イベントはありませんでした。",
        rowsInserted: 0,
        rowsSkipped: 0,
      });
    }

    const insertPayload = allRows.map((r) => ({
      amazon_order_id: r.amazon_order_id,
      sku: r.sku,
      transaction_type: r.transaction_type,
      amount_type: r.amount_type,
      amount_description: r.amount_description,
      amount: r.amount,
      posted_date: r.posted_date,
      amazon_event_hash: r.amazon_event_hash,
    }));

    const { data, error } = await supabase
      .from("sales_transactions")
      .upsert(insertPayload, {
        onConflict: "amazon_event_hash",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      if (error.code === "42P01") {
        return NextResponse.json(
          {
            error:
              "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。",
          },
          { status: 500 }
        );
      }
      throw error;
    }

    const inserted = Array.isArray(data) ? data.length : 0;
    const skipped = allRows.length - inserted;

    return NextResponse.json({
      ok: true,
      message: "財務イベントを取得し、sales_transactions に保存しました。",
      rowsInserted: inserted,
      rowsSkipped: skipped,
      totalFetched: allRows.length,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "財務データの取得・保存に失敗しました。";
    console.error("[fetch-finances]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
