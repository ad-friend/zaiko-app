/**
 * 経営ダッシュボード用集計（当月＝Asia/Tokyo の暦月）
 * 売上・原価の基準: inbound_items.settled_at が入ったタイミング（在庫引当＋ペイメント確定後の計上想定）
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  aggregateCurrentInventory,
  aggregateMonthlyLoss,
  aggregateMonthlyPurchase,
  fetchSettledInMonth,
  monthBoundsTokyo,
  sumSalesTransactionsForOrders,
} from "@/lib/dashboard-aggregates";
import type { DashboardPayload } from "@/lib/dashboard-types";

async function fetchUndismissedDashboardNotices(): Promise<DashboardPayload["notices"]> {
  const { data, error } = await supabase
    .from("dashboard_notices")
    .select("id, notice_type, payload, created_at")
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error) {
    const msg = error.message ?? "";
    if (error.code === "42P01" || msg.includes("does not exist") || msg.includes("schema cache")) {
      return [];
    }
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    notice_type: String(row.notice_type ?? ""),
    payload: typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {},
    created_at: String(row.created_at ?? ""),
  }));
}

export async function GET() {
  try {
    const period = monthBoundsTokyo();
    const [inventory, monthlyPurchase, monthlyLoss, settled, notices] = await Promise.all([
      aggregateCurrentInventory(),
      aggregateMonthlyPurchase(period),
      aggregateMonthlyLoss(period),
      fetchSettledInMonth(period),
      fetchUndismissedDashboardNotices(),
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
      notices,
    };
    return NextResponse.json(payload);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "ダッシュボードの集計に失敗しました。";
    console.error("[dashboard]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
