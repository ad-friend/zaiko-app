/**
 * amazon_orders 向け JAN 解決（ローカル DB のみ。SP-API は使わない）
 * products.asin → jan_code、sku_mappings（platform=Amazon）→ jan_code
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const CHUNK = 100;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function is13DigitJan(s: string): boolean {
  return /^\d{13}$/.test(String(s).trim());
}

export async function buildLocalJanLookupMaps(
  supabase: SupabaseClient,
  asins: string[],
  skus: string[]
): Promise<{ asinToJan: Map<string, string>; skuToJan: Map<string, string> }> {
  const asinToJan = new Map<string, string>();
  const skuToJan = new Map<string, string>();

  const normAsins = [...new Set(asins.map((a) => String(a ?? "").trim()).filter((a) => a.length >= 10))];
  const normSkus = [...new Set(skus.map((s) => String(s ?? "").trim()).filter(Boolean))];

  for (const part of chunkArray(normAsins, CHUNK)) {
    const { data } = await supabase.from("products").select("asin, jan_code").in("asin", part);
    for (const p of data ?? []) {
      const j = String(p.jan_code ?? "").trim();
      if (is13DigitJan(j)) asinToJan.set(String(p.asin ?? "").trim(), j);
    }
  }

  for (const part of chunkArray(normSkus, CHUNK)) {
    const { data } = await supabase
      .from("sku_mappings")
      .select("sku, jan_code")
      .in("sku", part)
      .eq("platform", "Amazon");
    for (const m of data ?? []) {
      const s = String(m.sku ?? "").trim();
      const j = String(m.jan_code ?? "").trim();
      if (!skuToJan.has(s) && is13DigitJan(j)) skuToJan.set(s, j);
    }
  }

  return { asinToJan, skuToJan };
}

export function resolveJanFromLocalMaps(
  sku: string,
  asin: string | null | undefined,
  asinToJan: Map<string, string>,
  skuToJan: Map<string, string>
): string | null {
  const s = String(sku ?? "").trim();
  if (is13DigitJan(s)) return s;
  const a = String(asin ?? "").trim();
  if (a && asinToJan.has(a)) return asinToJan.get(a)!;
  if (skuToJan.has(s)) return skuToJan.get(s)!;
  return null;
}
