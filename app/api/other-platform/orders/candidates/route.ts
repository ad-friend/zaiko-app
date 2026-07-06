/**
 * 他販路 手動引当: 在庫候補一覧（JAN 一致 + コンディション）
 * GET: ?other_order_id=uuid&order_id=xxx&platform=ラクマ
 * GET: ?search=JANまたは商品名&order_id=xxx — レスキュー検索
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { normalizeOrderCondition, type NormalizedListingCondition } from "@/lib/amazon-condition-match";
import { INBOUND_FILTER_SALABLE_FOR_ALLOCATION } from "@/lib/inbound-stock-status";
import {
  normalizeOtherPlatformJan,
  otherPlatformJanLookupVariants,
} from "@/lib/other-platform-jan";

const SEARCH_MAX_LEN = 120;

function orderIdAvailabilityOr(orderId: string): string {
  const id = orderId.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `order_id.is.null,order_id.eq."${id}",order_id.eq.""`;
}

function conditionTypeOrFilter(norm: NormalizedListingCondition): string {
  if (norm === "new") {
    return ["condition_type.ilike.new%", "condition_type.eq.新品"].join(",");
  }
  return ["condition_type.ilike.used%", "condition_type.eq.中古"].join(",");
}

type Row = {
  id: number;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
  effective_unit_price: number | string | null;
  condition_type: string | null;
  created_at: string | null;
  order_id: string | null;
};

function toPayload(r: Row) {
  return {
    id: r.id,
    jan_code: r.jan_code,
    brand: r.brand,
    model_number: r.model_number,
    effective_unit_price: Number(r.effective_unit_price ?? 0),
    condition_type: r.condition_type,
    created_at: r.created_at,
    order_id: r.order_id,
  };
}

function baseInboundSelect() {
  return supabase
    .from("inbound_items")
    .select("id, jan_code, brand, model_number, effective_unit_price, condition_type, created_at, order_id")
    .is("settled_at", null)
    .or(INBOUND_FILTER_SALABLE_FOR_ALLOCATION);
}

function buildRescueBase(orderId: string) {
  let q = baseInboundSelect().is("exit_type", null);
  if (orderId) {
    q = q.or(orderIdAvailabilityOr(orderId));
  } else {
    q = q.or('order_id.is.null,order_id.eq.""');
  }
  return q;
}

async function searchInboundRescue(search: string, orderId: string) {
  const q = search.trim();
  if (q.length < 1) return [];

  const like = `%${q}%`;
  const [janRes, nameRes] = await Promise.all([
    buildRescueBase(orderId).ilike("jan_code", like).order("created_at", { ascending: true }).limit(80),
    buildRescueBase(orderId).ilike("product_name", like).order("created_at", { ascending: true }).limit(80),
  ]);

  if (janRes.error) throw janRes.error;
  if (nameRes.error) throw nameRes.error;

  const rows = [...(janRes.data ?? []), ...(nameRes.data ?? [])];
  const seen = new Set<number>();
  const out: ReturnType<typeof toPayload>[] = [];
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(toPayload(row as Row));
  }
  out.sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  return out.slice(0, 80);
}

function uniqueJanFromMappings(mapList: Array<{ jan_code: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = normalizeOtherPlatformJan(String(m.jan_code ?? "").trim());
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  return [...jans][0] ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const searchRaw = searchParams.get("search")?.trim() ?? "";
    const orderId = searchParams.get("order_id")?.trim() ?? "";
    const platform = searchParams.get("platform")?.trim() ?? "";
    const otherOrderId = searchParams.get("other_order_id")?.trim() ?? "";
    const janOverride = searchParams.get("jan_code")?.trim() ?? "";

    if (searchRaw.length > 0) {
      if (searchRaw.length > SEARCH_MAX_LEN) {
        return NextResponse.json({ error: `search は ${SEARCH_MAX_LEN} 文字以内にしてください。` }, { status: 400 });
      }
      const rescue = await searchInboundRescue(searchRaw, orderId);
      return NextResponse.json(rescue);
    }

    if (!otherOrderId && !orderId) {
      return NextResponse.json({ error: "other_order_id または order_id を指定してください。" }, { status: 400 });
    }

    let orderRow: {
      id: string;
      order_id: string;
      platform: string;
      sku: string | null;
      jan_code: string | null;
      condition_id: string | null;
    } | null = null;

    if (otherOrderId) {
      const { data, error } = await supabase
        .from("other_orders")
        .select("id, order_id, platform, sku, jan_code, condition_id")
        .eq("id", otherOrderId)
        .maybeSingle();
      if (error) throw error;
      orderRow = data;
    } else if (orderId && platform) {
      const { data, error } = await supabase
        .from("other_orders")
        .select("id, order_id, platform, sku, jan_code, condition_id")
        .eq("order_id", orderId)
        .eq("platform", platform)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      orderRow = data;
    }

    if (!orderRow) {
      return NextResponse.json({ error: "該当する他販路注文が見つかりません。" }, { status: 404 });
    }

    const oid = String(orderRow.order_id ?? "").trim();
    const plat = String(orderRow.platform ?? "").trim();
    const sku = String(orderRow.sku ?? "").trim();
    const condNorm = normalizeOrderCondition(orderRow.condition_id);

    if (condNorm === null) {
      return NextResponse.json([]);
    }

    let jan = normalizeOtherPlatformJan(janOverride) || normalizeOtherPlatformJan(orderRow.jan_code);
    if (!jan && sku && plat) {
      const { data: mappings } = await supabase
        .from("sku_mappings")
        .select("jan_code")
        .eq("sku", sku)
        .eq("platform", plat);
      const fromMaps = uniqueJanFromMappings(mappings ?? []);
      if (fromMaps) jan = fromMaps;
    }

    if (!jan) {
      return NextResponse.json([]);
    }

    const janVariants = otherPlatformJanLookupVariants(jan);
    let q = baseInboundSelect().in("jan_code", janVariants).or(orderIdAvailabilityOr(oid));
    if (condNorm) {
      q = q.or(conditionTypeOrFilter(condNorm));
    }
    const { data, error } = await q.order("created_at", { ascending: true });
    if (error) throw error;

    return NextResponse.json((data ?? []).map((r) => toPayload(r as Row)));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "在庫候補の取得に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
