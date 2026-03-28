/**
 * Amazon 注文明細用: ASIN / SKU から JAN（13桁 EAN）を解決する。
 * 1) SKU が13桁ならそのまま
 * 2) products マスタ（asin）
 * 3) Catalog Items API getCatalogItem（identifiers の EAN / JAN / GTIN）
 */
import type { SupabaseClient } from "@supabase/supabase-js";

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
  spClient: SpClientLike,
  params: { sku: string; asin: string | null }
): Promise<string | null> {
  const sku = String(params.sku ?? "").trim();
  if (is13DigitJan(sku)) return sku;

  const asin = params.asin?.trim() ?? null;
  if (!asin) return null;

  const { data: productRow } = await supabase.from("products").select("jan_code").eq("asin", asin).maybeSingle();
  const fromProducts = productRow?.jan_code != null ? String(productRow.jan_code).trim() : "";
  if (is13DigitJan(fromProducts)) return fromProducts;

  const fromCatalog = await fetchJanFromAsinCatalog(spClient, asin);
  if (fromCatalog) return fromCatalog;

  return null;
}
