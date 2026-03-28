/**
 * 経営ダッシュボード用集計（当月＝Asia/Tokyo の暦月）
 * 売上・原価の基準: inbound_items.settled_at が入ったタイミング（在庫引当＋ペイメント確定後の計上想定）
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import type { DashboardPayload, DashboardPeriod } from "@/lib/dashboard-types";

const PAGE = 1000;
const ORDER_ID_BATCH = 80;

/** Charge / その他プラットフォームの売上行 */
const REVENUE_AMOUNT_TYPES = new Set(["Charge", "Sell"]);
/** 手数料・調整（DB上は多くがマイナス） */
const FEE_LIKE_AMOUNT_TYPES = new Set(["Fee", "FeeAdjustment", "ChargeAdjustment"]);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function monthBoundsTokyo(): DashboardPeriod {
  const tz = "Asia/Tokyo";
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [yStr, mStr] = ymd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
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

async function aggregateCurrentInventory(): Promise<{ count: number; totalAmount: number }> {
  let count = 0;
  let totalAmount = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("effective_unit_price")
      .is("settled_at", null)
      .is("exit_type", null)
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

/** created_at が当月の明細 */
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

/** 伝票 purchase_date が当月の明細 */
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

async function aggregateMonthlyPurchase(period: DashboardPeriod): Promise<{ count: number; totalAmount: number }> {
  const byId = new Map<number, number>();
  await collectPurchaseByCreatedAt(period.startIso, period.endExclusiveIso, byId);
  await collectPurchaseByHeaderDate(period.dateStart, period.dateEndExclusive, byId);
  let totalAmount = 0;
  for (const v of byId.values()) totalAmount += v;
  return { count: byId.size, totalAmount };
}

async function aggregateMonthlyLoss(period: DashboardPeriod): Promise<{ count: number; totalAmount: number }> {
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

async function fetchSettledInMonth(period: DashboardPeriod): Promise<{
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

async function sumSalesTransactionsForOrders(
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

export async function GET() {
  try {
    const period = monthBoundsTokyo();
    const [inventory, monthlyPurchase, monthlyLoss, settled] = await Promise.all([
      aggregateCurrentInventory(),
      aggregateMonthlyPurchase(period),
      aggregateMonthlyLoss(period),
      fetchSettledInMonth(period),
    ]);
    const { revenue, feesAndAdjustments } = await sumSalesTransactionsForOrders(settled.orderIds, period);
    const profit = revenue + feesAndAdjustments - settled.costOfGoodsSold - monthlyLoss.totalAmount;

    const payload: DashboardPayload = {
      period: {
        label: period.label,
        startIso: period.startIso,
        endExclusiveIso: period.endExclusiveIso,
        dateStart: period.dateStart,
        dateEndExclusive: period.dateEndExclusive,
      },
      inventory,
      monthlyPurchase,
      monthlyLoss,
      monthlySettled: {
        soldCount: settled.soldCount,
        costOfGoodsSold: settled.costOfGoodsSold,
        revenue,
        feesAndAdjustments,
        profit,
      },
    };
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "ダッシュボードの集計に失敗しました。";
    console.error("[dashboard]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
