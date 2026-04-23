/**
 * SP-API listFinancialEvents の取得・sales_transactions への保存（チャンク対応）
 */
import { createHash } from "crypto";
import { supabase } from "@/lib/supabase";
import {
  computeSalesTransactionIdempotencyKey,
  dedupeUpsertChunkByIdempotencyKey,
} from "@/lib/sales-transaction-idempotency";
import { applyCanonicalToSalesTransactionRowForApi } from "@/lib/canonical-sales-transaction";

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
  /** 返金などで ShipmentItemList が空のとき、明細がこちらにのみ載ることがある */
  ShipmentItemAdjustmentList?: ShipmentItem[];
};
type AdjustmentItem = {
  SellerSKU?: string;
  TotalAmount?: Currency;
  Quantity?: string | number;
  PerUnitAmount?: Currency;
  /** SP-API によっては明細に注文番号が載る場合がある */
  AmazonOrderId?: string;
};
type AdjustmentEvent = {
  PostedDate?: string;
  AdjustmentType?: string;
  AdjustmentAmount?: Currency;
  AdjustmentItemList?: AdjustmentItem[];
  /** イベント直下に注文番号が載る場合がある（型に無いキーも readAdjustmentAmazonOrderId で走査） */
  AmazonOrderId?: string;
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
  /** 補填の数量分割などで同一ビジネスキーを区別。通常 0 */
  dedupe_slot?: number;
  /** 既定 1。補填分割時も各行 1 */
  item_quantity?: number;
  finance_line_group_id?: string | null;
  /** Quantity・PerUnit・Total が揃い P×Q≈T のときのみ false */
  needs_quantity_review?: boolean;
};

/** Shipment / Refund イベントの明細行（API により ShipmentItemList と ShipmentItemAdjustmentList のどちらか一方のみのことが多い） */
function lineItemsFromShipmentEvent(ev: ShipmentEvent): ShipmentItem[] {
  const a = Array.isArray(ev.ShipmentItemList) ? ev.ShipmentItemList : [];
  const b = Array.isArray(ev.ShipmentItemAdjustmentList) ? ev.ShipmentItemAdjustmentList : [];
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return [...a, ...b];
}

/** PostedDate が欠ける返金イベント向け。トップレベルの別名のみ（深い再帰はしない） */
function postedDateForShipmentEvent(ev: ShipmentEvent): string {
  const rec = ev as Record<string, unknown>;
  const candidates = [
    (ev.PostedDate ?? "").trim(),
    String(rec.ShipmentDate ?? "").trim(),
    String(rec.PostedDateTime ?? "").trim(),
    String(rec.EffectiveDate ?? "").trim(),
  ];
  for (const c of candidates) {
    if (c) return c;
  }
  return "";
}

function nfkcTrimFeeType(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKC")
    .trim();
}

function flattenShipmentEvents(list: ShipmentEvent[] | undefined, transactionType: string): SalesTransactionRow[] {
  const rows: SalesTransactionRow[] = [];
  if (!Array.isArray(list)) return rows;
  let rowIndex = 0;
  list.forEach((ev, eventIndex) => {
    const orderId = ev.AmazonOrderId?.trim() ?? null;
    const posted = postedDateForShipmentEvent(ev);
    if (!posted) return;
    const items = lineItemsFromShipmentEvent(ev);
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
          item_quantity: 1,
          finance_line_group_id: null,
          needs_quantity_review: false,
          dedupe_slot: 0,
        });
      }
      for (const f of fees) {
        const feeType = nfkcTrimFeeType(f.FeeType);
        const base = toAmountMaybe(f.FeeAmount);
        if (base == null) continue;
        const amount =
          transactionType === "Refund" && feeType === "Commission" ? base : toSignedAmount(base, true);
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
          item_quantity: 1,
          finance_line_group_id: null,
          needs_quantity_review: false,
          dedupe_slot: 0,
        });
      }
      const chargeAdj = item.ItemChargeAdjustmentList ?? [];
      const feeAdj = item.ItemFeeAdjustmentList ?? [];
      for (const c of chargeAdj) {
        const base = toAmountMaybe(c.ChargeAmount);
        if (base == null) continue;
        // Refund の ChargeAdjustment は API の符号が会計上そのまま正しい。Order 等は従来どおり手数料系の符号寄せを維持。
        const amount = transactionType === "Refund" ? base : toSignedAmount(base, true);
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
          item_quantity: 1,
          finance_line_group_id: null,
          needs_quantity_review: false,
          dedupe_slot: 0,
        });
      }
      for (const f of feeAdj) {
        const feeType = nfkcTrimFeeType(f.FeeType);
        const base = toAmountMaybe(f.FeeAmount);
        if (base == null) continue;
        const amount =
          transactionType === "Refund" && feeType === "Commission" ? base : toSignedAmount(base, true);
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
          item_quantity: 1,
          finance_line_group_id: null,
          needs_quantity_review: false,
          dedupe_slot: 0,
        });
      }
    }
  });
  return rows;
}

/** AdjustmentEvent / AdjustmentItem から注文番号を拾う（存在する場合のみ。無ければ null） */
const ADJUSTMENT_AMAZON_ORDER_ID_KEYS = [
  "AmazonOrderId",
  "amazonOrderId",
  "amazon_order_id",
  "OrderId",
  "orderId",
  "MerchantOrderId",
  "merchantOrderId",
  "SellerOrderId",
  "sellerOrderId",
] as const;

function readAdjustmentAmazonOrderId(source: unknown): string | null {
  if (source == null || typeof source !== "object") return null;
  const o = source as Record<string, unknown>;
  for (const k of ADJUSTMENT_AMAZON_ORDER_ID_KEYS) {
    const v = o[k];
    if (v == null) continue;
    const s = String(v).normalize("NFKC").trim();
    if (s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") return s;
  }
  return null;
}

function amazonOrderIdForAdjustmentRow(ev: AdjustmentEvent, item: AdjustmentItem | undefined): string | null {
  return readAdjustmentAmazonOrderId(ev) ?? (item ? readAdjustmentAmazonOrderId(item) : null);
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
        const amazonOrderId = amazonOrderIdForAdjustmentRow(ev, it);
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
            amazon_order_id: amazonOrderId,
            sku,
            transaction_type: "Adjustment",
            amount_type: adjType,
            amount_description: null,
            amount: itemSignedTotal,
            posted_date: posted,
            amazon_event_hash: buildEventHash(amazonOrderId, "Adjustment", adjType, null, itemSignedTotal, posted, eventIndex, rowIndex++),
            item_quantity: 1,
            finance_line_group_id: gid,
            needs_quantity_review,
            dedupe_slot: 0,
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
            amazon_order_id: amazonOrderId,
            sku,
            transaction_type: "Adjustment",
            amount_type: adjType,
            amount_description: null,
            amount: amt,
            posted_date: posted,
            amazon_event_hash: buildEventHash(amazonOrderId, "Adjustment", adjType, null, amt, posted, eventIndex, rowIndex++, u),
            item_quantity: 1,
            finance_line_group_id: gid,
            needs_quantity_review,
            dedupe_slot: u,
          });
        }
      });
    } else {
      if (eventBase == null) return;
      const amazonOrderId = amazonOrderIdForAdjustmentRow(ev, undefined);
      const amount = toSignedAmount(eventBase, false);
      const eventGid = buildFinanceLineGroupId([
        "adj_event",
        String(eventIndex),
        posted,
        adjType,
        String(amount),
      ]);
      rows.push({
        amazon_order_id: amazonOrderId,
        sku: null,
        transaction_type: "Adjustment",
        amount_type: adjType,
        amount_description: null,
        amount,
        posted_date: posted,
        amazon_event_hash: buildEventHash(amazonOrderId, "Adjustment", adjType, null, amount, posted, eventIndex, rowIndex++),
        item_quantity: 1,
        finance_line_group_id: eventGid,
        needs_quantity_review: true,
        dedupe_slot: 0,
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

function isFinancialEventsShape(o: unknown): o is FinancialEventsPayload {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return (
    Array.isArray(x.ShipmentEventList) ||
    Array.isArray(x.RefundEventList) ||
    Array.isArray(x.AdjustmentEventList)
  );
}

function readFinancesNextToken(res: unknown, events: FinancialEventsPayload): string | null {
  const top = res as Record<string, unknown>;
  const fromTop = top.NextToken;
  if (typeof fromTop === "string" && fromTop.length > 0) return fromTop;
  const payload = top.payload;
  if (payload && typeof payload === "object") {
    const pt = (payload as Record<string, unknown>).NextToken;
    if (typeof pt === "string" && pt.length > 0) return pt;
  }
  const evNt = (events as { NextToken?: string }).NextToken;
  if (typeof evNt === "string" && evNt.length > 0) return evNt;
  return null;
}

/** SP-API 応答から FinancialEvents ブロックを取り出す（payload ラップの差を吸収） */
export function extractFinancialEventsPayload(res: unknown): FinancialEventsPayload {
  const r = res as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return {};
  const payload = r.payload;
  if (payload && typeof payload === "object") {
    const pl = payload as Record<string, unknown>;
    if (isFinancialEventsShape(pl.FinancialEvents)) {
      return pl.FinancialEvents as FinancialEventsPayload;
    }
    if (isFinancialEventsShape(pl)) {
      return pl as FinancialEventsPayload;
    }
  }
  if (isFinancialEventsShape(r.FinancialEvents)) {
    return r.FinancialEvents as FinancialEventsPayload;
  }
  if (isFinancialEventsShape(r)) {
    return r as FinancialEventsPayload;
  }
  return {};
}

/** Shipment / Refund / Adjustment を sales_transactions 行に展開（listFinancialEvents / ByOrderId 共通） */
export function financialEventsPayloadToRows(events: FinancialEventsPayload): SalesTransactionRow[] {
  const list = Array.isArray(events.ShipmentEventList) ? events.ShipmentEventList : [];
  const refundList = Array.isArray(events.RefundEventList) ? events.RefundEventList : [];
  const adjList = Array.isArray(events.AdjustmentEventList) ? events.AdjustmentEventList : [];
  return [
    ...flattenShipmentEvents(list, "Order"),
    ...flattenShipmentEvents(refundList, "Refund"),
    ...flattenAdjustmentEvents(adjList),
  ];
}

/** 環境変数 FINANCES_LOOKBACK_DAYS（未設定時 45、1～120 にクランプ） */
export function parseFinancesLookbackDaysFromEnv(): number {
  const raw = process.env.FINANCES_LOOKBACK_DAYS;
  const n = raw != null && String(raw).trim() !== "" ? parseInt(String(raw).trim(), 10) : NaN;
  if (!Number.isFinite(n)) return 45;
  return Math.min(120, Math.max(1, Math.trunc(n)));
}

/**
 * 日次 cron 用: 東京日付キーと、その日の最初の実行で固定する Posted 窓（同日中は state の postedAfter/Before を再利用）。
 * 窓は「実行時点の now から lookback 日前」～「now（クランプ済み）」。
 */
export function rollingFinancesBoundsForCronDay(lookbackDays: number): {
  postedAfter: string;
  postedBefore: string;
  dateKey: string;
  label: string;
} {
  const lb = Math.min(120, Math.max(1, Math.trunc(lookbackDays)));
  const tz = "Asia/Tokyo";
  const fmtEn = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateKey = fmtEn.format(new Date());
  const nowMs = Date.now();
  const afterMs = nowMs - lb * 86400000;
  const postedAfterRaw = new Date(afterMs).toISOString();
  const postedBeforeRaw = new Date().toISOString();
  const c = clampFinancialQueryBounds(postedAfterRaw, postedBeforeRaw);
  return {
    postedAfter: c.postedAfter,
    postedBefore: c.postedBefore,
    dateKey,
    label: `過去${lb}日（東京日付 ${dateKey} 基準・実行時点の窓）`,
  };
}

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
    })) as FinancialEventsPayload & { FinancialEvents?: FinancialEventsPayload; NextToken?: string; payload?: { FinancialEvents?: FinancialEventsPayload } };

    const events = extractFinancialEventsPayload(res);
    rows.push(...financialEventsPayloadToRows(events));

    pagesFetched += 1;
    nextToken = readFinancesNextToken(res, events);
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

/**
 * 注文 ID 単位の財務イベント取得（listFinancialEventsByOrderId）。
 * Posted 期間指定は不要。ページングは NextToken。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchFinancialEventsByOrderIdChunk(
  spClient: any,
  options: {
    orderId: string;
    startNextToken?: string | null;
    maxPages?: number | null;
  }
): Promise<FinancialChunkResult> {
  const orderId = String(options.orderId ?? "").trim();
  if (!orderId) {
    return { rows: [], nextToken: null, pagesFetched: 0, complete: true };
  }
  const maxPages = options.maxPages == null ? 30 : Math.max(1, options.maxPages);
  let nextToken: string | null = options.startNextToken ?? null;
  const rows: SalesTransactionRow[] = [];
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const query: Record<string, unknown> = { MaxResultsPerPage: 100 };
    if (nextToken) query.NextToken = nextToken;

    const res = (await spClient.callAPI({
      operation: "listFinancialEventsByOrderId",
      endpoint: "finances",
      path: { orderId },
      query,
    })) as FinancialEventsPayload & { FinancialEvents?: FinancialEventsPayload; NextToken?: string; payload?: { FinancialEvents?: FinancialEventsPayload } };

    const events = extractFinancialEventsPayload(res);
    rows.push(...financialEventsPayloadToRows(events));

    pagesFetched += 1;
    nextToken = readFinancesNextToken(res, events);
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

/** `fetchFinancialEventsChunk` が現状 sales_transactions に展開している EventList キー */
export const FINANCIAL_EVENT_LIST_KEYS_IMPORTED = new Set([
  "ShipmentEventList",
  "RefundEventList",
  "AdjustmentEventList",
]);

function snippetForFinancialEventItem(ev: unknown): Record<string, unknown> {
  if (ev == null) return { _note: "null" };
  if (typeof ev !== "object") return { _type: typeof ev, _value: String(ev).slice(0, 200) };
  const o = ev as Record<string, unknown>;
  const sn: Record<string, unknown> = {};
  for (const k of ["AmazonOrderId", "PostedDate", "SellerOrderId", "ShipmentId", "MarketplaceName"]) {
    if (k in o) sn[k] = o[k];
  }
  sn._topKeys = Object.keys(o).slice(0, 60);
  return sn;
}

function collectArrayKeysFromEventsBlock(events: Record<string, unknown>): string[] {
  return Object.keys(events).filter((k) => Array.isArray(events[k]));
}

function countOrderHitsInArray(arr: unknown[], orderId: string): number {
  if (!orderId) return 0;
  let n = 0;
  for (const item of arr) {
    try {
      if (item != null && JSON.stringify(item).includes(orderId)) n += 1;
    } catch {
      // 循環参照等は無視
    }
  }
  return n;
}

export type DebugScanListFinancialEventsResult = {
  postedAfter: string;
  postedBefore: string;
  pagesFetched: number;
  complete: boolean;
  nextTokenRemaining: string | null;
  totalArrayLengths: Record<string, number>;
  totalOrderHits: Record<string, number>;
  /** 件数が >0 で、現行取込が未処理の配列キー */
  unhandledNonEmptyArrayKeys: string[];
  firstOrderHitSnippets: Array<{ listKey: string; snippet: Record<string, unknown> }>;
  perPage: Array<{
    pageIndex: number;
    arrayLengths: Record<string, number>;
    orderHits: Record<string, number>;
  }>;
};

/**
 * listFinancialEvents の生ブロックをページ走査し、配列キーごとの件数と
 * 任意の amazon_order_id がどのリストに出現するかを集計する（DB には書かない）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function debugScanListFinancialEvents(
  spClient: any,
  options: {
    postedAfter: string;
    postedBefore: string;
    amazonOrderId?: string | null;
    maxPages?: number;
  }
): Promise<DebugScanListFinancialEventsResult> {
  const maxPages = Math.min(100, Math.max(1, options.maxPages ?? 15));
  const orderId = (options.amazonOrderId ?? "").trim();
  let nextToken: string | null = null;
  const { postedAfter, postedBefore } = clampFinancialQueryBounds(options.postedAfter, options.postedBefore);

  const totalArrayLengths: Record<string, number> = {};
  const totalOrderHits: Record<string, number> = {};
  const perPage: DebugScanListFinancialEventsResult["perPage"] = [];
  const firstOrderHitSnippets: Array<{ listKey: string; snippet: Record<string, unknown> }> = [];
  const seenListForSnippet = new Set<string>();

  let pagesFetched = 0;

  const buildResult = (complete: boolean, remainder: string | null): DebugScanListFinancialEventsResult => {
    const unhandledNonEmptyArrayKeys = Object.keys(totalArrayLengths)
      .filter((k) => (totalArrayLengths[k] ?? 0) > 0 && !FINANCIAL_EVENT_LIST_KEYS_IMPORTED.has(k))
      .sort();
    return {
      postedAfter,
      postedBefore,
      pagesFetched,
      complete,
      nextTokenRemaining: remainder,
      totalArrayLengths,
      totalOrderHits,
      unhandledNonEmptyArrayKeys,
      firstOrderHitSnippets,
      perPage,
    };
  };

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

    const eventsPayload = extractFinancialEventsPayload(res);
    const evObj = (eventsPayload && typeof eventsPayload === "object" ? eventsPayload : {}) as Record<string, unknown>;

    const arrayLengths: Record<string, number> = {};
    const orderHits: Record<string, number> = {};

    for (const k of collectArrayKeysFromEventsBlock(evObj)) {
      const arr = evObj[k] as unknown[];
      arrayLengths[k] = arr.length;
      totalArrayLengths[k] = (totalArrayLengths[k] ?? 0) + arr.length;
      if (orderId) {
        const hits = countOrderHitsInArray(arr, orderId);
        orderHits[k] = hits;
        totalOrderHits[k] = (totalOrderHits[k] ?? 0) + hits;
        if (hits > 0 && !seenListForSnippet.has(k) && firstOrderHitSnippets.length < 10) {
          const first = arr.find((item) => {
            try {
              return item != null && JSON.stringify(item).includes(orderId);
            } catch {
              return false;
            }
          });
          if (first != null) {
            seenListForSnippet.add(k);
            firstOrderHitSnippets.push({ listKey: k, snippet: snippetForFinancialEventItem(first) });
          }
        }
      }
    }

    perPage.push({
      pageIndex: pagesFetched,
      arrayLengths,
      orderHits: orderId ? orderHits : {},
    });

    pagesFetched += 1;
    nextToken = readFinancesNextToken(res, eventsPayload);

    if (!nextToken) {
      return buildResult(true, null);
    }
    if (pagesFetched >= maxPages) {
      return buildResult(false, nextToken);
    }
    await sleep(1500);
  }

  return buildResult(!nextToken, nextToken);
}

export type UpsertSalesResult = { inserted: number; skipped: number; tableMissing: boolean };

const WAREHOUSE_DAMAGE_TYPE = "WAREHOUSE_DAMAGE";
const WAREHOUSE_LOST_TYPE = "WAREHOUSE_LOST";

function nfkcTrimDedupe(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKC")
    .trim();
}

/**
 * Amazon が同一補填を WAREHOUSE_DAMAGE / WAREHOUSE_LOST の2行に分けて返す場合、片方（LOST）を除いて二重計上を防ぐ。
 * amount_type に AdjustmentType が入る（transaction_type は Adjustment）。
 * 厳密条件: 注文番号なし / Adjustment / 暦日・金額・SKU が一致 / 同一キー内が DAMAGE 1 行と LOST 1 行のみ。
 */
export function dedupeWarehouseDamageLostAdjustmentRows(rows: SalesTransactionRow[]): SalesTransactionRow[] {
  const buckets = new Map<string, { damages: SalesTransactionRow[]; losts: SalesTransactionRow[] }>();
  const nonBucket: SalesTransactionRow[] = [];

  for (const r of rows) {
    if (nfkcTrimDedupe(r.amazon_order_id)) {
      nonBucket.push(r);
      continue;
    }
    if (nfkcTrimDedupe(r.transaction_type) !== "Adjustment") {
      nonBucket.push(r);
      continue;
    }
    const at = nfkcTrimDedupe(r.amount_type).toUpperCase();
    if (at !== WAREHOUSE_DAMAGE_TYPE && at !== WAREHOUSE_LOST_TYPE) {
      nonBucket.push(r);
      continue;
    }
    const day = nfkcTrimDedupe(r.posted_date).slice(0, 10);
    if (day.length < 10) {
      nonBucket.push(r);
      continue;
    }
    const sku = nfkcTrimDedupe(r.sku).toUpperCase();
    const amt = Number(r.amount);
    if (!Number.isFinite(amt)) {
      nonBucket.push(r);
      continue;
    }
    const k = `${day}|${sku}|${amt.toFixed(4)}`;
    let b = buckets.get(k);
    if (!b) {
      b = { damages: [], losts: [] };
      buckets.set(k, b);
    }
    if (at === WAREHOUSE_DAMAGE_TYPE) b.damages.push(r);
    else b.losts.push(r);
  }

  const out: SalesTransactionRow[] = [...nonBucket];
  for (const [, b] of buckets) {
    if (b.damages.length === 1 && b.losts.length === 1) {
      out.push(b.damages[0]!);
    } else {
      out.push(...b.damages, ...b.losts);
    }
  }
  return out;
}

export async function upsertSalesTransactionRows(allRows: SalesTransactionRow[]): Promise<UpsertSalesResult> {
  if (allRows.length === 0) {
    return { inserted: 0, skipped: 0, tableMissing: false };
  }
  const deduped = dedupeWarehouseDamageLostAdjustmentRows(allRows);
  const rows = deduped.map(applyCanonicalToSalesTransactionRowForApi);
  const insertPayload = rows.map((r) => {
    const dedupe_slot = r.dedupe_slot ?? 0;
    return {
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
      dedupe_slot,
      idempotency_key: computeSalesTransactionIdempotencyKey({
        amazon_order_id: r.amazon_order_id,
        sku: r.sku,
        transaction_type: r.transaction_type,
        amount_type: r.amount_type,
        amount_description: r.amount_description,
        amount: r.amount,
        posted_date: r.posted_date,
        dedupe_slot,
      }),
    };
  });

  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < insertPayload.length; i += UPSERT_CHUNK) {
    const chunk = dedupeUpsertChunkByIdempotencyKey(insertPayload.slice(i, i + UPSERT_CHUNK));
    const { data, error } = await supabase
      .from("sales_transactions")
      .upsert(chunk, {
        onConflict: "idempotency_key",
        ignoreDuplicates: false,
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
