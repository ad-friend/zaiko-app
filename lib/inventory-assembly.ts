/**
 * パーツ組み付け（親子ツリー）ヘルパ。
 * 未使用在庫（parent_item_id IS NULL）は現行どおり単体引当対象。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export const ITEM_KIND_PRODUCT = "product";
export const ITEM_KIND_PART = "part";

export type ItemKind = typeof ITEM_KIND_PRODUCT | typeof ITEM_KIND_PART;

export type AssemblyItemRow = {
  id: number;
  parent_item_id: number | null;
  item_kind: string | null;
  effective_unit_price: number;
  order_id: string | null;
  settled_at: string | null;
  exit_type: string | null;
  stock_status: string | null;
  product_name: string | null;
  jan_code: string | null;
  brand: string | null;
  model_number: string | null;
};

function nonempty(s: string | null | undefined): boolean {
  return s != null && String(s).trim().length > 0;
}

/** 単体で引当・販売可能な状態か（組み付け済みは別判定） */
export function isSalableStandaloneState(row: {
  settled_at?: string | null;
  exit_type?: string | null;
  stock_status?: string | null;
  order_id?: string | null;
}): boolean {
  if (nonempty(row.settled_at)) return false;
  if (nonempty(row.exit_type)) return false;
  if (nonempty(row.order_id)) return false;
  const stock = String(row.stock_status ?? "").trim().toLowerCase();
  if (stock && stock !== "available") return false;
  return true;
}

/**
 * PostgREST クエリに「未組み付け」条件を付与。
 * 呼び出し側で settled_at / exit_type / stock_status と併用する。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyUnattachedInboundFilter(query: any): any {
  return query.is("parent_item_id", null);
}

async function fetchChildrenOf(
  client: SupabaseClient,
  parentIds: number[]
): Promise<Array<{ id: number; parent_item_id: number | null; effective_unit_price: number }>> {
  const ids = [...new Set(parentIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const out: Array<{ id: number; parent_item_id: number | null; effective_unit_price: number }> = [];
  const chunkSize = 200;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await client
      .from("inbound_items")
      .select("id, parent_item_id, effective_unit_price")
      .in("parent_item_id", chunk);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      out.push({
        id: Number(r.id),
        parent_item_id: r.parent_item_id != null ? Number(r.parent_item_id) : null,
        effective_unit_price: Number(r.effective_unit_price ?? 0),
      });
    }
  }
  return out;
}

/** ルート ID 群の子孫をすべて収集（ルート自身は含まない） */
export async function fetchDescendantIds(
  rootIds: number[],
  client: SupabaseClient = supabase
): Promise<number[]> {
  const roots = [...new Set(rootIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!roots.length) return [];
  const found = new Set<number>();
  let frontier = roots;
  while (frontier.length) {
    const children = await fetchChildrenOf(client, frontier);
    const next: number[] = [];
    for (const c of children) {
      if (found.has(c.id) || roots.includes(c.id)) continue;
      found.add(c.id);
      next.push(c.id);
    }
    frontier = next;
  }
  return [...found];
}

/** ルート + 子孫 */
export async function expandWithDescendantIds(
  rootIds: number[],
  client: SupabaseClient = supabase
): Promise<number[]> {
  const roots = [...new Set(rootIds.filter((n) => Number.isInteger(n) && n > 0))];
  const descendants = await fetchDescendantIds(roots, client);
  return [...new Set([...roots, ...descendants])];
}

/**
 * 各ルートのサブツリー合算原価（ルート自身 + 子孫の effective_unit_price）。
 * ルートに子孫が無い場合はルート原価のみ。
 */
export async function sumSubtreeCostsByRootId(
  roots: Array<{ id: number; effective_unit_price: number }>,
  client: SupabaseClient = supabase
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  for (const r of roots) {
    result.set(r.id, Number(r.effective_unit_price) || 0);
  }
  if (!roots.length) return result;

  const rootIds = roots.map((r) => r.id);
  const rootSet = new Set(rootIds);

  // parent_id -> root_id（サブツリー所属のルート）
  const ownerRoot = new Map<number, number>();
  for (const id of rootIds) ownerRoot.set(id, id);

  let frontier = rootIds;
  while (frontier.length) {
    const children = await fetchChildrenOf(client, frontier);
    const next: number[] = [];
    for (const c of children) {
      const parentId = c.parent_item_id;
      if (parentId == null) continue;
      const rootId = ownerRoot.get(parentId);
      if (rootId == null || !rootSet.has(rootId)) continue;
      if (ownerRoot.has(c.id)) continue;
      ownerRoot.set(c.id, rootId);
      result.set(rootId, (result.get(rootId) ?? 0) + (Number(c.effective_unit_price) || 0));
      next.push(c.id);
    }
    frontier = next;
  }
  return result;
}

export async function sumSubtreeCostForRoot(
  rootId: number,
  rootEffectiveUnitPrice: number,
  client: SupabaseClient = supabase
): Promise<number> {
  const map = await sumSubtreeCostsByRootId(
    [{ id: rootId, effective_unit_price: rootEffectiveUnitPrice }],
    client
  );
  return map.get(rootId) ?? rootEffectiveUnitPrice;
}

/** child を parent の下に付けると循環になるか */
export async function wouldCreateCycle(
  parentId: number,
  childId: number,
  client: SupabaseClient = supabase
): Promise<boolean> {
  if (parentId === childId) return true;
  const seen = new Set<number>();
  let walkId = parentId;
  for (let i = 0; i < 50; i += 1) {
    if (walkId === childId) return true;
    if (seen.has(walkId)) return false;
    seen.add(walkId);
    const { data, error } = await client
      .from("inbound_items")
      .select("parent_item_id")
      .eq("id", walkId)
      .maybeSingle<{ parent_item_id: number | null }>();
    if (error) throw new Error(error.message);
    if (data?.parent_item_id == null) return false;
    walkId = Number(data.parent_item_id);
    if (!Number.isFinite(walkId) || walkId < 1) return false;
  }
  return false;
}

async function loadAssemblyRow(
  id: number,
  client: SupabaseClient
): Promise<AssemblyItemRow | null> {
  const { data, error } = await client
    .from("inbound_items")
    .select(
      "id, parent_item_id, item_kind, effective_unit_price, order_id, settled_at, exit_type, stock_status, product_name, jan_code, brand, model_number"
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: Number(data.id),
    parent_item_id: data.parent_item_id != null ? Number(data.parent_item_id) : null,
    item_kind: data.item_kind != null ? String(data.item_kind) : ITEM_KIND_PRODUCT,
    effective_unit_price: Number(data.effective_unit_price ?? 0),
    order_id: data.order_id != null ? String(data.order_id) : null,
    settled_at: data.settled_at != null ? String(data.settled_at) : null,
    exit_type: data.exit_type != null ? String(data.exit_type) : null,
    stock_status: data.stock_status != null ? String(data.stock_status) : null,
    product_name: data.product_name != null ? String(data.product_name) : null,
    jan_code: data.jan_code != null ? String(data.jan_code) : null,
    brand: data.brand != null ? String(data.brand) : null,
    model_number: data.model_number != null ? String(data.model_number) : null,
  };
}

export type AssembleResult =
  | { ok: true; parent: AssemblyItemRow; child: AssemblyItemRow }
  | { ok: false; error: string };

export async function assembleItems(
  parentId: number,
  childId: number,
  client: SupabaseClient = supabase
): Promise<AssembleResult> {
  if (!Number.isInteger(parentId) || parentId < 1 || !Number.isInteger(childId) || childId < 1) {
    return { ok: false, error: "parentId / childId が不正です。" };
  }
  if (parentId === childId) {
    return { ok: false, error: "同じ在庫同士は組み付けできません。" };
  }

  const parent = await loadAssemblyRow(parentId, client);
  const child = await loadAssemblyRow(childId, client);
  if (!parent) return { ok: false, error: `親在庫 id=${parentId} が見つかりません。` };
  if (!child) return { ok: false, error: `子在庫 id=${childId} が見つかりません。` };

  if (child.parent_item_id != null) {
    return { ok: false, error: `子在庫 id=${childId} は既に id=${child.parent_item_id} に組み付け済みです。` };
  }
  if (!isSalableStandaloneState(parent)) {
    return { ok: false, error: "親在庫が引当済・販売済・除外済みのため組み付けできません。" };
  }
  if (!isSalableStandaloneState(child)) {
    return { ok: false, error: "子在庫が引当済・販売済・除外済みのため組み付けできません。" };
  }
  if (await wouldCreateCycle(parentId, childId, client)) {
    return { ok: false, error: "循環する組み付けにはできません。" };
  }

  const { error } = await client.from("inbound_items").update({ parent_item_id: parentId }).eq("id", childId);
  if (error) return { ok: false, error: error.message };

  return { ok: true, parent, child: { ...child, parent_item_id: parentId } };
}

export type DisassembleResult =
  | { ok: true; child: AssemblyItemRow; previousParentId: number }
  | { ok: false; error: string };

export async function disassembleItem(
  childId: number,
  client: SupabaseClient = supabase
): Promise<DisassembleResult> {
  if (!Number.isInteger(childId) || childId < 1) {
    return { ok: false, error: "childId が不正です。" };
  }
  const child = await loadAssemblyRow(childId, client);
  if (!child) return { ok: false, error: `在庫 id=${childId} が見つかりません。` };
  if (child.parent_item_id == null) {
    return { ok: false, error: "この在庫は組み付けされていません。" };
  }
  if (nonempty(child.settled_at) || nonempty(child.order_id)) {
    return { ok: false, error: "引当済・販売済の在庫は取り外せません。" };
  }

  const previousParentId = child.parent_item_id;
  const { error } = await client.from("inbound_items").update({ parent_item_id: null }).eq("id", childId);
  if (error) return { ok: false, error: error.message };

  return { ok: true, child: { ...child, parent_item_id: null }, previousParentId };
}

/**
 * ルート在庫に order_id を付け、子孫にも同じ order_id を伝播する。
 * （本消込の .eq('order_id') 更新・解放が子孫にも効くようにする）
 */
export async function assignOrderIdToRootsAndDescendants(
  rootIds: number[],
  orderId: string,
  client: SupabaseClient = supabase
): Promise<number[]> {
  const oid = String(orderId ?? "").trim();
  if (!oid) throw new Error("order_id が空です。");
  const allIds = await expandWithDescendantIds(rootIds, client);
  if (!allIds.length) return [];
  const chunkSize = 200;
  for (let i = 0; i < allIds.length; i += chunkSize) {
    const chunk = allIds.slice(i, i + chunkSize);
    const { error } = await client.from("inbound_items").update({ order_id: oid }).in("id", chunk);
    if (error) throw new Error(error.message);
  }
  return allIds;
}

/** order_id 解除時もルート指定なら子孫を含める */
export async function clearOrderIdOnRootsAndDescendants(
  rootIds: number[],
  expectedOrderId: string | null,
  client: SupabaseClient = supabase
): Promise<number[]> {
  const allIds = await expandWithDescendantIds(rootIds, client);
  if (!allIds.length) return [];
  const chunkSize = 200;
  for (let i = 0; i < allIds.length; i += chunkSize) {
    const chunk = allIds.slice(i, i + chunkSize);
    let q = client.from("inbound_items").update({ order_id: null }).in("id", chunk);
    if (expectedOrderId != null && String(expectedOrderId).trim()) {
      q = q.eq("order_id", String(expectedOrderId).trim());
    }
    const { error } = await q;
    if (error) throw new Error(error.message);
  }
  return allIds;
}

export type AssemblySummary = {
  id: number;
  parent_item_id: number | null;
  item_kind: string;
  child_count: number;
  assembled_cost: number;
  children: Array<{
    id: number;
    product_name: string | null;
    jan_code: string | null;
    effective_unit_price: number;
    item_kind: string;
  }>;
};

/** 一覧ページ用: 直下の子と合算原価（深い子孫の原価も合算に含む） */
export async function buildAssemblySummariesForIds(
  rows: Array<{ id: number; parent_item_id?: number | null; item_kind?: string | null; effective_unit_price: number }>,
  client: SupabaseClient = supabase
): Promise<Map<number, AssemblySummary>> {
  const map = new Map<number, AssemblySummary>();
  if (!rows.length) return map;

  const ids = rows.map((r) => r.id);
  const costByRoot = await sumSubtreeCostsByRootId(
    rows.map((r) => ({ id: r.id, effective_unit_price: r.effective_unit_price })),
    client
  );

  const { data: directChildren, error } = await client
    .from("inbound_items")
    .select("id, parent_item_id, product_name, jan_code, effective_unit_price, item_kind")
    .in("parent_item_id", ids);
  if (error) throw new Error(error.message);

  const childrenByParent = new Map<number, AssemblySummary["children"]>();
  for (const c of directChildren ?? []) {
    const pid = Number(c.parent_item_id);
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push({
      id: Number(c.id),
      product_name: c.product_name != null ? String(c.product_name) : null,
      jan_code: c.jan_code != null ? String(c.jan_code) : null,
      effective_unit_price: Number(c.effective_unit_price ?? 0),
      item_kind: c.item_kind != null ? String(c.item_kind) : ITEM_KIND_PRODUCT,
    });
  }

  for (const r of rows) {
    const children = childrenByParent.get(r.id) ?? [];
    map.set(r.id, {
      id: r.id,
      parent_item_id: r.parent_item_id != null ? Number(r.parent_item_id) : null,
      item_kind: r.item_kind != null ? String(r.item_kind) : ITEM_KIND_PRODUCT,
      child_count: children.length,
      assembled_cost: costByRoot.get(r.id) ?? (Number(r.effective_unit_price) || 0),
      children,
    });
  }
  return map;
}
