/**
 * SP-API listFinancialEvents の取得・sales_transactions への保存（チャンク対応）
 */
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";

const UPSERT_CHUNK = 500;

export type Currency = { CurrencyCode?: string; CurrencyAmount?: number };
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
type AdjustmentItem = {
  SellerSKU?: string;
  TotalAmount?: Currency;
  Quantity?: string | number;
  PerUnitAmount?: Currency;
};
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAmazonFinancesSpClient(): any {
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

function toAmountMaybe(c: Currency | undefined): number | null {
  if (c == null) return null;
  const n = Number(c.CurrencyAmount);
  return Number.isFinite(n) ? n : null;
}

function toSignedAmount(amount: number, isFeeOrAdjustment: boolean): number {
  if (isFeeOrAdjustment && amount > 0) return -amount;
  return amount;
}

/**
 * 重複排除キー。従来どおり 8 要素のみで hash（デプロイ前の行と一致）。
 * 補填を同一 AdjustmentItem から数量分割した行だけ、末尾に u0 / u1 / … を足して区別する。
 */
function buildEventHash(
  amazonOrderId: string | null,
  transactionType: string,
  amountType: string,
  amountDescription: string | null,
  amount: number,
  postedDate: string,
  eventIndex: number,
  rowIndex: number,
  unitIndex?: number | null
): string {
  const parts = [
    amazonOrderId ?? "",
    transactionType,
    amountType,
    amountDescription ?? "",
    String(amount),
    postedDate,
    String(eventIndex),
    String(rowIndex),
  ];
  if (unitIndex != null && unitIndex >= 0) {
    parts.push(`u${unitIndex}`);
  }
  return createHash("sha256").update(parts.join("_")).digest("hex");
}

/** 円ベース: 1 円未満の誤差まで許容 */
function amountsClose(a: number, b: number, eps = 0.015): boolean {
  return Math.abs(a - b) <= eps + 1e-9;
}

function splitSignedAmountToUnits(total: number, q: number): number[] {
  const units = Math.max(1, Math.floor(q));
  const cents = Math.round(total * 100);
  const sign = cents >= 0 ? 1 : -1;
  const mag = Math.abs(cents);
  const base = Math.floor(mag / units);
  const rem = mag - base * units;
  const out: number[] = [];
  for (let i = 0; i < units; i += 1) {
    const c = base + (i < rem ? 1 : 0);
    out.push((sign * c) / 100);
  }
  return out;
}

function parseAdjustmentQuantity(it: AdjustmentItem): { fromApi: boolean; q: number } {
  const raw = (it as { Quantity?: string | number }).Quantity;
  if (raw == null) return { fromApi: false, q: 1 };
  const s = String(raw).trim();
  if (!s) return { fromApi: false, q: 1 };
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) return { fromApi: false, q: 1 };
  return { fromApi: true, q: n };
}

function buildFinanceLineGroupId(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
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
  /** 既定 1。補填分割時も各行 1 */
  item_quantity?: number;
  finance_line_group_id?: string | null;
  /** Quantity・PerUnit・Total が揃い P×Q≈T のときのみ false */
  needs_quantity_review?: boolean;
};

function flattenShipmentEvents(list: ShipmentEvent[] | undefined, transactionType: string): SalesTransactionRow[] {
  const rows: SalesTransactionRow[] = [];
  if (!Array.isArray(list)) return rows;
  let rowIndex = 0;
  list.forEach((ev, eventIndex) => {
    const orderId = ev.AmazonOrderId?.trim() ?? null;
    const posted = (ev.PostedDate ?? "").trim();
    if (!posted) return;
    const items = ev.ShipmentItemList ?? [];
    for (const item of items) {
      const sku = item.SellerSKU?.trim() ?? null;
      const charges = item.ItemChargeList ?? [];
      const fees = item.ItemFeeList ?? [];
      for (const c of charges) {
        const base = toAmountMaybe(c.ChargeAmount);
        if (base == null) continue;
        const amount = toSignedAmount(base, false);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "Charge",
          amount_description: c.ChargeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(
            orderId,
            transactionType,
            "Charge",
            c.ChargeType ?? null,
            amount,
            posted,
            eventIndex,
            rowIndex++
          ),
        });
      }
      for (const f of fees) {
        const base = toAmountMaybe(f.FeeAmount);
        if (base == null) continue;
        const amount = toSignedAmount(base, true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "Fee",
          amount_description: f.FeeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(
            orderId,
            transactionType,
            "Fee",
            f.FeeType ?? null,
            amount,
            posted,
            eventIndex,
            rowIndex++
          ),
        });
      }
      const chargeAdj = item.ItemChargeAdjustmentList ?? [];
      const feeAdj = item.ItemFeeAdjustmentList ?? [];
      for (const c of chargeAdj) {
        const base = toAmountMaybe(c.ChargeAmount);
        if (base == null) continue;
        const amount = toSignedAmount(base, true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "ChargeAdjustment",
          amount_description: c.ChargeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(
            orderId,
            transactionType,
            "ChargeAdjustment",
            c.ChargeType ?? null,
            amount,
            posted,
            eventIndex,
            rowIndex++
          ),
        });
      }
      for (const f of feeAdj) {
        const base = toAmountMaybe(f.FeeAmount);
        if (base == null) continue;
        const amount = toSignedAmount(base, true);
        rows.push({
          amazon_order_id: orderId,
          sku,
          transaction_type: transactionType,
          amount_type: "FeeAdjustment",
          amount_description: f.FeeType?.trim() ?? null,
          amount,
          posted_date: posted,
          amazon_event_hash: buildEventHash(
            orderId,
            transactionType,
            "FeeAdjustment",
            f.FeeType ?? null,
            amount,
            posted,
            eventIndex,
            rowIndex++
          ),
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
    const posted = (ev.PostedDate ?? "").trim();
    if (!posted) return;
    const adjType = ev.AdjustmentType?.trim() ?? "Adjustment";
    const eventBase = toAmountMaybe(ev.AdjustmentAmount);
    const items = ev.AdjustmentItemList ?? [];
    if (items.length > 0) {
      items.forEach((it, itemIdx) => {
        const sku = it.SellerSKU?.trim() ?? null;
        const base = toAmountMaybe(it.TotalAmount);
        if (base == null) return;
        const itemSignedTotal = toSignedAmount(base, false);
        const { fromApi, q: qRaw } = parseAdjustmentQuantity(it);
        const q = Math.min(1000, Math.max(1, qRaw));
        const perUnitBase = toAmountMaybe(it.PerUnitAmount);
        const Psigned = perUnitBase != null ? toSignedAmount(perUnitBase, false) : null;
        const quantityCertain =
          fromApi && Psigned != null && amountsClose(Psigned * q, itemSignedTotal);
        const needs_quantity_review = !quantityCertain;
        const gid = buildFinanceLineGroupId([
          "adj",
          String(eventIndex),
          String(itemIdx),
          posted,
          adjType,
          sku ?? "",
          String(itemSignedTotal),
        ]);

        if (q <= 1) {
          rows.push({
            amazon_order_id: null,
            sku,
            transaction_type: "Adjustment",
            amount_type: adjType,
            amount_description: null,
            amount: itemSignedTotal,
            posted_date: posted,
            amazon_event_hash: buildEventHash(null, "Adjustment", adjType, null, itemSignedTotal, posted, eventIndex, rowIndex++),
            item_quantity: 1,
            finance_line_group_id: gid,
            needs_quantity_review,
          });
          return;
        }

        const unitAmounts =
          quantityCertain && Psigned != null
            ? Array.from({ length: q }, () => Psigned)
            : splitSignedAmountToUnits(itemSignedTotal, q);

        for (let u = 0; u < q; u += 1) {
          const amt = unitAmounts[u] ?? itemSignedTotal / q;
          rows.push({
            amazon_order_id: null,
            sku,
            transaction_type: "Adjustment",
            amount_type: adjType,
            amount_description: null,
            amount: amt,
            posted_date: posted,
            amazon_event_hash: buildEventHash(null, "Adjustment", adjType, null, amt, posted, eventIndex, rowIndex++, u),
            item_quantity: 1,
            finance_line_group_id: gid,
            needs_quantity_review,
          });
        }
      });
    } else {
      if (eventBase == null) return;
      const amount = toSignedAmount(eventBase, false);
      rows.push({
        amazon_order_id: null,
        sku: null,
        transaction_type: "Adjustment",
        amount_type: adjType,
        amount_description: null,
        amount,
        posted_date: posted,
        amazon_event_hash: buildEventHash(null, "Adjustment", adjType, null, amount, posted, eventIndex, rowIndex++),
        item_quantity: 1,
        finance_line_group_id: null,
        needs_quantity_review: true,
      });
    }
  });
  return rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** startDate/endDate（yyyy-MM-dd または ISO）から PostedAfter / PostedBefore（排他）を算出し SP-API 用にクランプ */
export function postedBoundsFromDateRange(startDate: string, endDate: string): { postedAfter: string; postedBefore: string } {
  let sd = startDate.trim();
  let ed = endDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(sd)) sd = sd.replace(/\./g, "-");
  if (!/^\d{4}-\d{2}-\d{2}/.test(ed)) ed = ed.replace(/\./g, "-");
  const postedAfter = sd.length <= 10 ? `${sd.slice(0, 10)}T00:00:00Z` : sd;
  const endPart = ed.length <= 10 ? ed.slice(0, 10) : ed.slice(0, 10);
  const endDay = new Date(endPart + "T00:00:00Z");
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  let postedBefore = endDay.toISOString().slice(0, 19) + "Z";
  return clampFinancialQueryBounds(postedAfter, postedBefore);
}

/** 既に ISO の窓に対し、Now-5分 未満にクランプし逆転を防ぐ */
export function clampFinancialQueryBounds(postedAfterIn: string, postedBeforeIn: string): { postedAfter: string; postedBefore: string } {
  let postedAfter = postedAfterIn.includes("T")
    ? postedAfterIn.slice(0, 19) + "Z"
    : `${postedAfterIn.slice(0, 10)}T00:00:00Z`;
  let postedBefore = postedBeforeIn.includes("T")
    ? postedBeforeIn.slice(0, 19) + "Z"
    : `${postedBeforeIn.slice(0, 10)}T00:00:00Z`;

  const maxDate = new Date(Date.now() - 5 * 60 * 1000);
  if (new Date(postedBefore) > maxDate) {
    postedBefore = maxDate.toISOString().slice(0, 19) + "Z";
  }
  if (new Date(postedAfter) > maxDate) {
    postedAfter = maxDate.toISOString().slice(0, 19) + "Z";
  }
  if (new Date(postedAfter) >= new Date(postedBefore)) {
    postedAfter = new Date(maxDate.getTime() - 60 * 1000).toISOString().slice(0, 19) + "Z";
  }
  return { postedAfter, postedBefore };
}

export type FinancialChunkResult = {
  rows: SalesTransactionRow[];
  nextToken: string | null;
  pagesFetched: number;
  complete: boolean;
};

/**
 * listFinancialEvents を最大 maxPages ページまで取得。
 * maxPages が null / undefined のときは NextToken が尽きるまで取得。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchFinancialEventsChunk(
  spClient: any,
  options: {
    postedAfter: string;
    postedBefore: string;
    startNextToken?: string | null;
    maxPages?: number | null;
  }
): Promise<FinancialChunkResult> {
  const maxPages = options.maxPages == null ? Number.POSITIVE_INFINITY : Math.max(1, options.maxPages);
  let nextToken: string | null = options.startNextToken ?? null;
  const rows: SalesTransactionRow[] = [];
  let pagesFetched = 0;
  const { postedAfter, postedBefore } = clampFinancialQueryBounds(options.postedAfter, options.postedBefore);

  while (pagesFetched < maxPages) {
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

    rows.push(
      ...flattenShipmentEvents(list, "Order"),
      ...flattenShipmentEvents(refundList, "Refund"),
      ...flattenAdjustmentEvents(adjList)
    );

    pagesFetched += 1;
    nextToken = res.NextToken ?? events.NextToken ?? null;
    if (!nextToken) {
      return { rows, nextToken: null, pagesFetched, complete: true };
    }
    if (pagesFetched >= maxPages) {
      return { rows, nextToken, pagesFetched, complete: false };
    }
    await sleep(1500);
  }

  return { rows, nextToken, pagesFetched, complete: !nextToken };
}

export type UpsertSalesResult = { inserted: number; skipped: number; tableMissing: boolean };

export async function upsertSalesTransactionRows(allRows: SalesTransactionRow[]): Promise<UpsertSalesResult> {
  if (allRows.length === 0) {
    return { inserted: 0, skipped: 0, tableMissing: false };
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
    item_quantity: r.item_quantity ?? 1,
    finance_line_group_id: r.finance_line_group_id ?? null,
    needs_quantity_review: r.needs_quantity_review ?? false,
  }));

  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < insertPayload.length; i += UPSERT_CHUNK) {
    const chunk = insertPayload.slice(i, i + UPSERT_CHUNK);
    const { data, error } = await supabase
      .from("sales_transactions")
      .upsert(chunk, {
        onConflict: "amazon_event_hash",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      if (error.code === "42P01") {
        return { inserted: 0, skipped: 0, tableMissing: true };
      }
      throw error;
    }

    const insertedInChunk = Array.isArray(data) ? data.length : 0;
    inserted += insertedInChunk;
    skipped += chunk.length - insertedInChunk;
  }
  return { inserted, skipped, tableMissing: false };
}
