/**
 * 他販路 消込在庫一覧（プラットフォーム・決済日期間で絞り込み）
 * GET ?platforms_only=1 — 取込実績のある platform 一覧のみ
 * GET ?from=yyyy-MM-dd&to=yyyy-MM-dd&platform=ラクマ&platform=楽天 — 在庫行一覧
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { OTHER_ORDER_STATUS_RECONCILED } from "@/lib/other-platform-reconciliation-status";
import { parseFlexiblePostedDateToIso } from "@/lib/settlement-posted-date";

const MAX_ORDERS = 500;
const INBOUND_CHUNK = 150;

type OrderRow = {
  order_id: string;
  platform: string;
  sku: string | null;
  jan_code: string | null;
  sell_price: number;
  posted_date: string | null;
  condition_id: string | null;
  quantity: number;
};

type InboundRow = {
  id: number;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  effective_unit_price: number | string | null;
  settled_at: string | null;
  order_id: string | null;
};

export type ReconciledInventoryRow = {
  order_id: string;
  platform: string;
  sku: string | null;
  jan_code: string | null;
  sell_price: number;
  posted_date: string | null;
  condition_id: string | null;
  quantity: number;
  stock_id: number;
  stock_jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  unit_cost: number;
  settled_at: string | null;
};

function dateRangeEndIso(yyyyMmDd: string): string | null {
  const t = yyyyMmDd.trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return parseFlexiblePostedDateToIso(t);
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T23:59:59.999+09:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchDistinctPlatforms(): Promise<string[]> {
  const { data, error } = await supabase.from("other_orders").select("platform");
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) {
    const p = String((row as { platform?: unknown }).platform ?? "").trim();
    if (p) set.add(p);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    if (searchParams.get("platforms_only") === "1") {
      const platforms = await fetchDistinctPlatforms();
      return NextResponse.json({ platforms });
    }

    const fromRaw = searchParams.get("from")?.trim() ?? "";
    const toRaw = searchParams.get("to")?.trim() ?? "";
    const platforms = [...new Set(searchParams.getAll("platform").map((s) => s.trim()).filter(Boolean))];

    if (!fromRaw || !toRaw) {
      return NextResponse.json({ error: "from と to（yyyy-MM-dd）を指定してください。" }, { status: 400 });
    }
    if (platforms.length === 0) {
      return NextResponse.json({ error: "プラットフォームを1つ以上選択してください。" }, { status: 400 });
    }

    const fromIso = parseFlexiblePostedDateToIso(fromRaw);
    const toIso = dateRangeEndIso(toRaw);
    if (!fromIso || !toIso) {
      return NextResponse.json({ error: "日付の形式が不正です（yyyy-MM-dd）。" }, { status: 400 });
    }
    if (Date.parse(fromIso) > Date.parse(toIso)) {
      return NextResponse.json({ error: "開始日は終了日以前にしてください。" }, { status: 400 });
    }

    const { data: orderRows, error: orderErr } = await supabase
      .from("other_orders")
      .select("order_id, platform, sku, jan_code, sell_price, posted_date, condition_id, quantity, reconciliation_status, status")
      .in("platform", platforms)
      .gte("posted_date", fromIso)
      .lte("posted_date", toIso)
      .or(`reconciliation_status.eq.${OTHER_ORDER_STATUS_RECONCILED},status.eq.completed`)
      .order("posted_date", { ascending: true })
      .limit(MAX_ORDERS + 1);

    if (orderErr) throw orderErr;

    const allOrders = (orderRows ?? []) as OrderRow[];
    const truncated = allOrders.length > MAX_ORDERS;
    const orders = truncated ? allOrders.slice(0, MAX_ORDERS) : allOrders;

    const orderById = new Map<string, OrderRow>();
    for (const o of orders) {
      const oid = String(o.order_id ?? "").trim();
      if (oid && !orderById.has(oid)) orderById.set(oid, o);
    }

    const orderIds = [...orderById.keys()];
    const inboundByOrderId = new Map<string, InboundRow[]>();

    for (const chunk of chunkArray(orderIds, INBOUND_CHUNK)) {
      const { data: inboundRows, error: inboundErr } = await supabase
        .from("inbound_items")
        .select("id, jan_code, brand, model_number, effective_unit_price, settled_at, order_id")
        .in("order_id", chunk);
      if (inboundErr) throw inboundErr;
      for (const row of (inboundRows ?? []) as InboundRow[]) {
        const oid = String(row.order_id ?? "").trim();
        if (!oid) continue;
        if (!inboundByOrderId.has(oid)) inboundByOrderId.set(oid, []);
        inboundByOrderId.get(oid)!.push(row);
      }
    }

    const rows: ReconciledInventoryRow[] = [];
    for (const [oid, order] of orderById) {
      const stocks = inboundByOrderId.get(oid) ?? [];
      if (stocks.length === 0) continue;
      for (const s of stocks) {
        rows.push({
          order_id: oid,
          platform: String(order.platform ?? "").trim(),
          sku: order.sku != null ? String(order.sku).trim() || null : null,
          jan_code: order.jan_code != null ? String(order.jan_code).trim() || null : null,
          sell_price: Number(order.sell_price ?? 0),
          posted_date: order.posted_date != null ? String(order.posted_date) : null,
          condition_id: order.condition_id != null ? String(order.condition_id) : null,
          quantity: Math.max(1, Number(order.quantity) || 1),
          stock_id: s.id,
          stock_jan_code: s.jan_code != null ? String(s.jan_code).trim() || null : null,
          brand: s.brand != null ? String(s.brand).trim() || null : null,
          model_number: s.model_number != null ? String(s.model_number).trim() || null : null,
          unit_cost: Number(s.effective_unit_price ?? 0),
          settled_at: s.settled_at != null ? String(s.settled_at) : null,
        });
      }
    }

    const platformList = await fetchDistinctPlatforms();

    return NextResponse.json({
      rows,
      orderCount: orderById.size,
      stockCount: rows.length,
      truncated,
      platforms: platformList,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "消込在庫の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
