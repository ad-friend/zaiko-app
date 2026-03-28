/**
 * Amazon 注文明細用: ASIN / SKU から JAN（13桁 EAN）を解決する。
 * 1) SKU が13桁ならそのまま
 * 2) products マスタ（asin）
 * 3) Catalog Items API getCatalogItem（identifiers の EAN / JAN / GTIN）
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sleep } from "@/lib/amazon-sp-try-client";

const IN_CHUNK = 80;

const MARKETPLACE_ID_JP = "A1VC38T7YXB528";

export function is13DigitJan(s: string): boolean {
  return /^\d{13}$/.test(String(s).trim());
}

function normalize13DigitFromIdentifier(raw: string): string | null {
  const digits = String(raw).replace(/\D/g, "");
  if (/^\d{13}$/.test(digits)) return digits;
  if (/^\d{12}$/.test(digits)) return digits.padStart(13, "0");
  return null;
}

/** getCatalogItem / searchCatalogItems のレスポンスから13桁JAN候補を再帰探索 */
export function extractJanFromCatalogPayload(payload: unknown): string | null {
  const visit = (node: unknown): string | null => {
    if (node == null) return null;
    if (typeof node === "string") return normalize13DigitFromIdentifier(node);
    if (typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const r = visit(x);
        if (r) return r;
      }
      return null;
    }
    const o = node as Record<string, unknown>;
    const typeStr = String(o.identifierType ?? o.type ?? "").toUpperCase();
    const idVal = o.identifier;
    if (typeof idVal === "string" && (typeStr === "EAN" || typeStr === "JAN" || typeStr === "GTIN")) {
      const j = normalize13DigitFromIdentifier(idVal);
      if (j) return j;
    }
    for (const v of Object.values(o)) {
      const r = visit(v);
      if (r) return r;
    }
    return null;
  };
  return visit(payload);
}

type SpClientLike = {
  callAPI: (params: Record<string, unknown>) => Promise<unknown>;
};

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * ユニーク ASIN ごとに 1 回だけ JAN を解決する（自動消込前のバルク補完用）。
 * 順序: products 一括 → amazon_orders の既存 jan 一括 → 未解決のみ Catalog API（各 ASIN 後に sleep）
 */
export async function buildAsinToJanMap(
  supabase: SupabaseClient,
  spClient: SpClientLike | null,
  uniqueAsins: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const normalized = [
    ...new Set(
      uniqueAsins
        .map((a) => String(a ?? "").trim())
        .filter((a) => a.length >= 10)
    ),
  ];

  for (const part of chunkArray(normalized, IN_CHUNK)) {
    const { data: prows } = await supabase.from("products").select("asin, jan_code").in("asin", part);
    for (const p of prows ?? []) {
      const a = String(p.asin ?? "").trim();
      const j = String(p.jan_code ?? "").trim();
      if (a && is13DigitJan(j)) map.set(a, j);
    }
  }

  const afterProducts = normalized.filter((a) => !map.has(a));
  for (const part of chunkArray(afterProducts, IN_CHUNK)) {
    const { data: orows } = await supabase
      .from("amazon_orders")
      .select("asin, jan_code")
      .in("asin", part)
      .not("jan_code", "is", null);
    for (const o of orows ?? []) {
      const a = String(o.asin ?? "").trim();
      const j = String(o.jan_code ?? "").trim();
      if (a && is13DigitJan(j) && !map.has(a)) map.set(a, j);
    }
  }

  const needCatalog = normalized.filter((a) => !map.has(a));
  if (!spClient || needCatalog.length === 0) return map;

  for (const asin of needCatalog) {
    const j = await fetchJanFromAsinCatalog(spClient, asin);
    if (j) map.set(asin, j);
    await sleep(250);
  }

  return map;
}

export async function fetchJanFromAsinCatalog(spClient: SpClientLike, asin: string): Promise<string | null> {
  const a = String(asin ?? "").trim();
  if (!a || a.length < 10) return null;
  try {
    const res = await spClient.callAPI({
      operation: "getCatalogItem",
      endpoint: "catalogItems",
      path: { asin: a },
      query: {
        marketplaceIds: [MARKETPLACE_ID_JP],
        includedData: ["identifiers", "summaries"],
      },
      options: { version: "2022-04-01" },
    });
    return extractJanFromCatalogPayload(res);
  } catch (e) {
    console.warn(`[amazon-resolve-order-jan] getCatalogItem failed asin=${a}`, e);
    return null;
  }
}

export async function resolveJanForAmazonOrderLine(
  supabase: SupabaseClient,
  spClient: SpClientLike | null,
  params: { sku: string; asin: string | null }
): Promise<string | null> {
  const sku = String(params.sku ?? "").trim();
  if (is13DigitJan(sku)) return sku;

  const asin = params.asin?.trim() ?? null;
  if (!asin) return null;

  const { data: productRow } = await supabase.from("products").select("jan_code").eq("asin", asin).maybeSingle();
  const fromProducts = productRow?.jan_code != null ? String(productRow.jan_code).trim() : "";
  if (is13DigitJan(fromProducts)) return fromProducts;

  if (!spClient) return null;

  const fromCatalog = await fetchJanFromAsinCatalog(spClient, asin);
  if (fromCatalog) return fromCatalog;

  return null;
}

/** Orders API の OrderItem（ConditionId 等）— 実装は `amazon-sp-order-items` */
export type { AmazonOrderItemLine } from "@/lib/amazon-sp-order-items";
export { buildAmazonOrderSkuToConditionMap, normalizeOrderItemConditionId } from "@/lib/amazon-sp-order-items";
