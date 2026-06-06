/**
 * 経営ダッシュボード用集計（Asia/Tokyo 暦月）
 */
import { supabase } from "@/lib/supabase";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";
import { isSalesPrincipalRow, isSalesTaxRow, type PrincipalTaxQuadRowLike } from "@/lib/amazon-principal-tax-quad";
import type { DashboardPeriod, MonthlyDashboardRow } from "@/lib/dashboard-types";

const PAGE = 1000;
const ORDER_ID_BATCH = 80;

/** Charge / その他プラットフォームの売上行 */
const REVENUE_AMOUNT_TYPES = new Set(["Charge", "Sell"]);
/** 手数料・調整（DB上は多くがマイナス） */
const FEE_LIKE_AMOUNT_TYPES = new Set(["Fee", "FeeAdjustment", "ChargeAdjustment"]);

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function monthBoundsTokyo(year?: number, month?: number): DashboardPeriod {
  const tz = "Asia/Tokyo";
  let y: number;
  let m: number;
  if (year != null && month != null) {
    y = year;
    m = month;
  } else {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [yStr, mStr] = ymd.split("-");
    y = Number(yStr);
    m = Number(mStr);
  }
  const label = `${y}年${m}月`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStart = `${y}-${pad(m)}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const dateEndExclusive = `${nextY}-${pad(nextM)}-01`;
  const startIso = new Date(`${dateStart}T00:00:00+09:00`).toISOString();
  const endExclusiveIso = new Date(`${dateEndExclusive}T00:00:00+09:00`).toISOString();
  return { label, startIso, endExclusiveIso, dateStart, dateEndExclusive };
}

/** YYYY-MM をパース。不正なら null */
export function parseYearMonth(ym: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/** fromYm 〜 toYm（YYYY-MM）の各月を古い順に返す */
export function listMonthPeriods(fromYm: string, toYm: string): DashboardPeriod[] {
  const from = parseYearMonth(fromYm);
  const to = parseYearMonth(toYm);
  if (!from || !to) return [];
  let y = from.year;
  let m = from.month;
  const periods: DashboardPeriod[] = [];
  for (;;) {
    periods.push(monthBoundsTokyo(y, m));
    if (y === to.year && m === to.month) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (periods.length > 36) break;
  }
  return periods;
}

/** 当月から monthsBack ヶ月前の YYYY-MM（monthsBack=23 → 24ヶ月分） */
export function defaultMonthlyRange(monthsBack = 23): { from: string; to: string } {
  const current = monthBoundsTokyo();
  const toMatch = /^(\d{4})-(\d{2})/.exec(current.dateStart);
  if (!toMatch) return { from: current.dateStart.slice(0, 7), to: current.dateStart.slice(0, 7) };
  let y = Number(toMatch[1]);
  let m = Number(toMatch[2]);
  m -= monthsBack;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${y}-${pad(m)}`, to: `${toMatch[1]}-${toMatch[2]}` };
}

export async function aggregateCurrentInventory(): Promise<{ count: number; totalAmount: number }> {
  let count = 0;
  let totalAmount = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("effective_unit_price")
      .is("settled_at", null)
      .is("exit_type", null)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      count += 1;
      totalAmount += num(row.effective_unit_price);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { count, totalAmount };
}

/** 月末時点の在庫（翌月1日 00:00 JST 直前） */
export async function aggregateInventoryAtMonthEnd(period: DashboardPeriod): Promise<{ count: number; totalAmount: number }> {
  const endExclusiveIso = period.endExclusiveIso;
  let count = 0;
  let totalAmount = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("effective_unit_price, settled_at, exit_type, registered_at, stock_status")
      .lt("created_at", endExclusiveIso)
      .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const settledAt = row.settled_at as string | null;
      if (settledAt != null && settledAt < endExclusiveIso) continue;
      const exitType = row.exit_type as string | null;
      const registeredAt = row.registered_at as string | null;
      if (exitType != null && registeredAt != null && registeredAt < endExclusiveIso) continue;
      count += 1;
      totalAmount += num(row.effective_unit_price);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { count, totalAmount };
}

async function collectPurchaseByCreatedAt(startIso: string, endExclusiveIso: string, byId: Map<number, number>) {
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("id, effective_unit_price")
      .gte("created_at", startIso)
      .lt("created_at", endExclusiveIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      if (!byId.has(id)) byId.set(id, num(row.effective_unit_price));
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
}

async function collectPurchaseByHeaderDate(dateStart: string, dateEndExclusive: string, byId: Map<number, number>) {
  let hFrom = 0;
  const headerIds: number[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_headers")
      .select("id")
      .gte("purchase_date", dateStart)
      .lt("purchase_date", dateEndExclusive)
      .order("id", { ascending: true })
      .range(hFrom, hFrom + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const h of data) {
      const hid = Number(h.id);
      if (Number.isFinite(hid)) headerIds.push(hid);
    }
    if (data.length < PAGE) break;
    hFrom += PAGE;
  }
  for (let i = 0; i < headerIds.length; i += ORDER_ID_BATCH) {
    const chunk = headerIds.slice(i, i + ORDER_ID_BATCH);
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("inbound_items")
        .select("id, effective_unit_price")
        .in("header_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data) {
        const id = Number(row.id);
        if (!Number.isFinite(id)) continue;
        if (!byId.has(id)) byId.set(id, num(row.effective_unit_price));
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
}

export async function aggregateMonthlyPurchase(period: DashboardPeriod): Promise<{ count: number; totalAmount: number }> {
  const byId = new Map<number, number>();
  await collectPurchaseByCreatedAt(period.startIso, period.endExclusiveIso, byId);
  await collectPurchaseByHeaderDate(period.dateStart, period.dateEndExclusive, byId);
  let totalAmount = 0;
  for (const v of byId.values()) totalAmount += v;
  return { count: byId.size, totalAmount };
}

export async function aggregateMonthlyLoss(period: DashboardPeriod): Promise<{ count: number; totalAmount: number }> {
  let count = 0;
  let totalAmount = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("effective_unit_price")
      .not("exit_type", "is", null)
      .gte("registered_at", period.startIso)
      .lt("registered_at", period.endExclusiveIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      count += 1;
      totalAmount += num(row.effective_unit_price);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { count, totalAmount };
}

type SettledRow = { order_id: string | null; effective_unit_price: unknown };

export async function fetchSettledInMonth(period: DashboardPeriod): Promise<{
  soldCount: number;
  costOfGoodsSold: number;
  orderIds: string[];
}> {
  const orderIdSet = new Set<string>();
  let soldCount = 0;
  let costOfGoodsSold = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("order_id, effective_unit_price")
      .not("settled_at", "is", null)
      .gte("settled_at", period.startIso)
      .lt("settled_at", period.endExclusiveIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as SettledRow[];
    if (!rows.length) break;
    for (const row of rows) {
      soldCount += 1;
      costOfGoodsSold += num(row.effective_unit_price);
      const oid = row.order_id?.trim();
      if (oid) orderIdSet.add(oid);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return { soldCount, costOfGoodsSold, orderIds: [...orderIdSet] };
}

export async function sumSalesTransactionsForOrders(
  orderIds: string[],
  period: DashboardPeriod
): Promise<{ revenue: number; feesAndAdjustments: number }> {
  let revenue = 0;
  let feesAndAdjustments = 0;
  for (let i = 0; i < orderIds.length; i += ORDER_ID_BATCH) {
    const batch = orderIds.slice(i, i + ORDER_ID_BATCH);
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("sales_transactions")
        .select("amount, amount_type")
        .in("amazon_order_id", batch)
        .gte("posted_date", period.startIso)
        .lt("posted_date", period.endExclusiveIso)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        if (error.code === "42P01") return { revenue: 0, feesAndAdjustments: 0 };
        throw error;
      }
      if (!data?.length) break;
      for (const row of data) {
        const t = String(row.amount_type ?? "");
        const a = num(row.amount);
        if (REVENUE_AMOUNT_TYPES.has(t)) revenue += a;
        else if (FEE_LIKE_AMOUNT_TYPES.has(t)) feesAndAdjustments += a;
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  return { revenue, feesAndAdjustments };
}

type SalesTxRow = {
  amount: unknown;
  amount_type: string | null;
  amount_description: string | null;
  transaction_type: string | null;
};

function classifySalesRow(row: SalesTxRow): { salesTotal: number; consumptionTax: number; netDeposit: number } {
  const amount = num(row.amount);
  const amountType = String(row.amount_type ?? "");
  const like: PrincipalTaxQuadRowLike = {
    amount,
    amount_type: row.amount_type,
    amount_description: row.amount_description,
    transaction_type: row.transaction_type,
  };

  let salesTotal = 0;
  let consumptionTax = 0;

  if (amountType === "Sell") {
    salesTotal = amount;
  } else if (amountType === "Charge") {
    if (isSalesTaxRow(like)) {
      consumptionTax = amount;
    } else if (isSalesPrincipalRow(like)) {
      salesTotal = amount;
    }
  }

  return { salesTotal, consumptionTax, netDeposit: amount };
}

/** posted_date 基準で当月の全 sales_transactions を集計 */
export async function sumSalesTransactionsByPostedDate(period: DashboardPeriod): Promise<{
  salesTotal: number;
  consumptionTax: number;
  netDeposit: number;
}> {
  let salesTotal = 0;
  let consumptionTax = 0;
  let netDeposit = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("sales_transactions")
      .select("amount, amount_type, amount_description, transaction_type")
      .gte("posted_date", period.startIso)
      .lt("posted_date", period.endExclusiveIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      if (error.code === "42P01") return { salesTotal: 0, consumptionTax: 0, netDeposit: 0 };
      throw error;
    }
    if (!data?.length) break;
    for (const row of data) {
      const c = classifySalesRow(row as SalesTxRow);
      salesTotal += c.salesTotal;
      consumptionTax += c.consumptionTax;
      netDeposit += c.netDeposit;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { salesTotal, consumptionTax, netDeposit };
}

export async function aggregateMonthlyDashboardRow(period: DashboardPeriod): Promise<MonthlyDashboardRow> {
  const [monthlyPurchase, monthlyLoss, settled, inventoryAtMonthEnd, sales] = await Promise.all([
    aggregateMonthlyPurchase(period),
    aggregateMonthlyLoss(period),
    fetchSettledInMonth(period),
    aggregateInventoryAtMonthEnd(period),
    sumSalesTransactionsByPostedDate(period),
  ]);
  const profit = sales.netDeposit - settled.costOfGoodsSold - monthlyLoss.totalAmount;
  return {
    period: {
      label: period.label,
      startIso: period.startIso,
      endExclusiveIso: period.endExclusiveIso,
      dateStart: period.dateStart,
      dateEndExclusive: period.dateEndExclusive,
    },
    salesTotal: sales.salesTotal,
    consumptionTax: sales.consumptionTax,
    monthlyPurchase,
    inventoryAtMonthEnd,
    soldCount: settled.soldCount,
    netDeposit: sales.netDeposit,
    costOfGoodsSold: settled.costOfGoodsSold,
    monthlyLoss,
    profit,
  };
}

/** 同時実行数を制限して複数月を集計 */
export async function aggregateMonthlyDashboardRows(periods: DashboardPeriod[], concurrency = 4): Promise<MonthlyDashboardRow[]> {
  const rows: MonthlyDashboardRow[] = new Array(periods.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= periods.length) break;
      rows[i] = await aggregateMonthlyDashboardRow(periods[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, periods.length) }, () => worker()));
  return rows;
}
