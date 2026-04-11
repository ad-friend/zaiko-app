/** 在庫一覧 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export type RecordRow = {
  id: number;
  jan_code: string | null;
  asin?: string | null;
  product_name: string | null;
  brand: string | null;
  model_number: string | null;
  condition_type: string | null;
  base_price: number;
  effective_unit_price: number;
  created_at: string;
  /** 入庫登録処理実行時刻（登録日） */
  registered_at?: string;
  order_id?: string | null;
  settled_at?: string | null;
  /** 在庫調整理由（damaged 等） */
  exit_type?: string | null;
  stock_status?: string | null;
  /** DB 生成列。進捗ソート用（getInventoryStatusSortRank と同一ロジック） */
  inventory_progress_rank?: number;
  header: {
    id: number;
    purchase_date: string;
    supplier: string | null;
    genre: string | null;
    created_at: string;
  } | null;
};

const SELECT_WITH_REGISTERED = `
  id,
  jan_code,
  asin,
  product_name,
  brand,
  model_number,
  condition_type,
  base_price,
  effective_unit_price,
  created_at,
  registered_at,
  order_id,
  settled_at,
  exit_type,
  stock_status,
  inventory_progress_rank,
  inbound_headers (
    id,
    purchase_date,
    supplier,
    genre,
    created_at
  )
`;

export const LIST_MAX_ROWS = 50000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
/** 仕入先解決→header_id.in の上限（URL・PostgREST 負荷対策） */
const MAX_HEADER_IDS_FOR_SEARCH = 3500;

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_%");
}

function mapDbRow(row: Record<string, unknown>): RecordRow {
  const r = row;
  return {
    id: Number(r.id),
    jan_code: r.jan_code != null ? String(r.jan_code) : null,
    asin: r.asin != null ? String(r.asin) : null,
    product_name: r.product_name != null ? String(r.product_name) : null,
    brand: r.brand != null ? String(r.brand) : null,
    model_number: r.model_number != null ? String(r.model_number) : null,
    condition_type: r.condition_type != null ? String(r.condition_type) : null,
    base_price: Number(r.base_price ?? 0),
    effective_unit_price: Number(r.effective_unit_price ?? 0),
    created_at: r.created_at != null ? String(r.created_at) : "",
    registered_at: (r.registered_at || r.created_at)
      ? new Date(String(r.registered_at || r.created_at)).toLocaleDateString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .replace(/\//g, "-")
      : "",
    order_id: r.order_id != null ? String(r.order_id) : null,
    settled_at: r.settled_at != null ? String(r.settled_at) : null,
    exit_type: r.exit_type != null ? String(r.exit_type) : null,
    stock_status: r.stock_status != null ? String(r.stock_status) : null,
    inventory_progress_rank:
      r.inventory_progress_rank != null ? Number(r.inventory_progress_rank) : undefined,
    header: Array.isArray(r.inbound_headers)
      ? (r.inbound_headers[0] as RecordRow["header"])
      : ((r.inbound_headers as RecordRow["header"]) ?? null),
  };
}

function ilikeValue(raw: string): string {
  const esc = escapeIlikePattern(raw.trim());
  return `%${esc}%`;
}

/**
 * 仕入先文字列（inbound_headers.supplier の部分一致）と、
 * suppliers マスタの name/kana 一致→保存カナと完全一致するヘッダをまとめて解決する。
 * （親テーブル .or() に inbound_headers.supplier を混ぜない）
 */
async function resolveHeaderIdsForSupplierSearch(rawQ: string): Promise<number[]> {
  const t = rawQ.trim();
  if (!t) return [];
  const p = ilikeValue(t);
  const idSet = new Set<number>();

  const addIds = (rows: { id: unknown }[] | null | undefined) => {
    for (const r of rows ?? []) {
      if (idSet.size >= MAX_HEADER_IDS_FOR_SEARCH) break;
      const n = Number(r.id);
      if (Number.isInteger(n) && n > 0) idSet.add(n);
    }
  };

  const { data: bySupplierIlike, error: errIlike } = await supabase
    .from("inbound_headers")
    .select("id")
    .ilike("supplier", p)
    .limit(5000);
  if (errIlike) {
    console.error("[records] resolveHeaderIds inbound_headers ilike:", errIlike.message);
  } else {
    addIds(bySupplierIlike);
  }

  if (idSet.size < MAX_HEADER_IDS_FOR_SEARCH) {
    const { data: byName, error: errName } = await supabase.from("suppliers").select("kana").ilike("name", p).limit(150);
    const { data: byKana, error: errKana } = await supabase.from("suppliers").select("kana").ilike("kana", p).limit(150);
    if (errName) console.error("[records] resolveHeaderIds suppliers name:", errName.message);
    if (errKana) console.error("[records] resolveHeaderIds suppliers kana:", errKana.message);
    const kanas = new Set<string>();
    for (const row of [...(byName ?? []), ...(byKana ?? [])]) {
      const k = String((row as { kana?: unknown }).kana ?? "").trim();
      if (k) kanas.add(k);
    }
    if (kanas.size > 0) {
      const kanaList = [...kanas];
      const chunkSize = 80;
      for (let i = 0; i < kanaList.length && idSet.size < MAX_HEADER_IDS_FOR_SEARCH; i += chunkSize) {
        const chunk = kanaList.slice(i, i + chunkSize);
        const { data: byExactSupplier, error: errH } = await supabase
          .from("inbound_headers")
          .select("id")
          .in("supplier", chunk)
          .limit(5000);
        if (errH) {
          console.error("[records] resolveHeaderIds inbound_headers in supplier:", errH.message);
          break;
        }
        addIds(byExactSupplier);
      }
    }
  }

  return [...idSet].slice(0, MAX_HEADER_IDS_FOR_SEARCH);
}

function buildSearchOrClause(q: string, headerIds: number[]): string | null {
  const t = q.trim();
  if (!t) return null;
  const p = ilikeValue(t);
  const parts: string[] = [
    `jan_code.ilike.${p}`,
    `product_name.ilike.${p}`,
    `brand.ilike.${p}`,
    `model_number.ilike.${p}`,
    `order_id.ilike.${p}`,
    `asin.ilike.${p}`,
    `condition_type.ilike.${p}`,
  ];
  if (headerIds.length > 0) {
    parts.push(`header_id.in.(${headerIds.join(",")})`);
  }
  if (/^\d+$/.test(t) && t.length <= 15) {
    parts.push(`id.eq.${t}`);
  }
  const lower = t.toLowerCase();
  if (t.includes("新品") || lower === "new") parts.push("condition_type.eq.new");
  if (t.includes("中古") || lower === "used") parts.push("condition_type.eq.used");
  return parts.join(",");
}

type SortKey =
  | "id"
  | "registered_at"
  | "created_at"
  | "supplier"
  | "genre"
  | "jan_code"
  | "product_name"
  | "brand"
  | "model_number"
  | "order_id"
  | "base_price"
  | "effective_unit_price"
  | "condition_type"
  | "inventory_progress";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOrdering(q: any, sortKey: SortKey | null, sortDir: "asc" | "desc"): any {
  const ascending = sortDir === "asc";
  const nullsFirst = false;

  if (!sortKey) {
    return q
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false });
  }

  switch (sortKey) {
    case "inventory_progress":
      return q
        .order("inventory_progress_rank", { ascending, nullsFirst: false })
        .order("id", { ascending });
    case "created_at":
      return q
        .order("purchase_date", { ascending, nullsFirst, foreignTable: "inbound_headers" })
        .order("id", { ascending });
    case "supplier":
      return q
        .order("supplier", { ascending, nullsFirst, foreignTable: "inbound_headers" })
        .order("id", { ascending });
    case "genre":
      return q
        .order("genre", { ascending, nullsFirst, foreignTable: "inbound_headers" })
        .order("id", { ascending });
    case "registered_at":
      return q.order("registered_at", { ascending, nullsFirst }).order("id", { ascending });
    case "id":
    case "jan_code":
    case "product_name":
    case "brand":
    case "model_number":
    case "order_id":
    case "base_price":
    case "effective_unit_price":
    case "condition_type":
      return q.order(sortKey, { ascending, nullsFirst }).order("id", { ascending });
    default:
      return q
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false });
  }
}

async function runListQuery(
  cutoffIso: string,
  page: number,
  pageSize: number,
  searchOr: string | null,
  sortKey: SortKey | null,
  sortDirRaw: "asc" | "desc"
): Promise<{ rows: RecordRow[]; total: number; error: Error | null }> {
  let listQuery = supabase
    .from("inbound_items")
    .select(SELECT_WITH_REGISTERED, { count: "exact" })
    .gte("created_at", cutoffIso);

  if (searchOr) {
    listQuery = listQuery.or(searchOr);
  }

  listQuery = applyOrdering(listQuery, sortKey, sortDirRaw);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  listQuery = listQuery.range(from, to);

  const { data, error, count } = await listQuery;

  if (error) {
    return { rows: [], total: 0, error: new Error(error.message) };
  }

  const rows = (data || []).map((row) => mapDbRow(row as Record<string, unknown>));
  const total = count ?? rows.length;
  return { rows, total, error: null };
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;

    const yearsParam = sp.get("years");
    let years = 30;
    if (yearsParam !== null && yearsParam !== "") {
      const n = parseInt(yearsParam, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 100) years = n;
    }

    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    const cutoffIso = cutoff.toISOString();

    let page = parseInt(sp.get("page") ?? "1", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;

    let pageSize = parseInt(sp.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
    pageSize = Math.min(pageSize, MAX_PAGE_SIZE);

    const qRaw = sp.get("q") ?? "";

    const sortKeyRaw = sp.get("sort") ?? "";
    const sortDirRaw = (sp.get("dir") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const allowedSort = new Set<SortKey>([
      "id",
      "registered_at",
      "created_at",
      "supplier",
      "genre",
      "jan_code",
      "product_name",
      "brand",
      "model_number",
      "order_id",
      "base_price",
      "effective_unit_price",
      "condition_type",
      "inventory_progress",
    ]);
    const sortKey: SortKey | null =
      sortKeyRaw && allowedSort.has(sortKeyRaw as SortKey) ? (sortKeyRaw as SortKey) : null;

    const supplierHeaderIds = qRaw.trim() ? await resolveHeaderIdsForSupplierSearch(qRaw) : [];
    const searchOr = buildSearchOrClause(qRaw, supplierHeaderIds);
    const result = await runListQuery(cutoffIso, page, pageSize, searchOr, sortKey, sortDirRaw);

    if (result.error) throw result.error;

    return NextResponse.json({
      rows: result.rows,
      total: result.total,
      page,
      pageSize,
      listMaxRows: LIST_MAX_ROWS,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[records] GET error:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function normalizeDeleteIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : Number(String(x).trim());
    if (!Number.isInteger(n) || n < 1) continue;
    out.push(n);
  }
  return [...new Set(out)];
}

export async function DELETE(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正なJSONです" }, { status: 400 });
  }
  if (body === null || typeof body !== "object") {
    return NextResponse.json({ error: "リクエストボディが必要です" }, { status: 400 });
  }
  const ids = normalizeDeleteIds((body as { ids?: unknown }).ids);
  if (ids.length === 0) {
    return NextResponse.json({ error: "削除対象の ids を1件以上、正しい整数で指定してください" }, { status: 400 });
  }

  const CHUNK = 120;
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const { data, error } = await supabase.from("inbound_items").delete().in("id", chunk).select("id");
      if (error) {
        console.error("[records] DELETE chunk error:", error);
        return NextResponse.json({ error: error.message || "inbound_items の削除に失敗しました" }, { status: 500 });
      }
      deleted += data?.length ?? 0;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "削除処理中にエラーが発生しました";
    console.error("[records] DELETE error:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (deleted === 0) {
    return NextResponse.json(
      {
        error:
          "いずれの id にも該当する inbound_items が削除できませんでした（存在しない・既に削除済み、または権限・RLSの制限の可能性があります）",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, deleted, requested: ids.length });
}
