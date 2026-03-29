/**
 * CSV インポート用: SKU からコンディションをローカル DB のみで解決（SP-API なし）。
 * 優先順: amazon_sku_conditions → sku_mappings（列＋title）→ products（JAN 経由）。
 * いずれでも決まらない SKU は最終フォールバックで 'New'。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const CHUNK = 100;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeToNewUsed(raw: string | null | undefined): "New" | "Used" | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "new" || s === "newitem" || s === "new_item" || s === "新品" || s.startsWith("new")) return "New";
  if (s === "used" || s === "中古" || s.startsWith("used")) return "Used";
  return null;
}

/** 行にあれば優先する候補カラム（将来の sku_conditions 連携やマイグレーション用） */
const SKU_MAPPING_CONDITION_KEYS = [
  "listing_condition",
  "default_listing_condition",
  "condition_id",
  "amazon_condition",
  "condition_type",
] as const;

const PRODUCT_CONDITION_KEYS = [
  "listing_condition",
  "default_listing_condition",
  "condition_id",
  "amazon_condition",
  "condition_type",
] as const;

/** 辞書テーブル amazon_sku_conditions 想定カラム */
const AMAZON_SKU_CONDITION_KEYS = [
  "condition_id",
  "listing_condition",
  "condition",
  "condition_type",
  "amazon_condition",
  "default_listing_condition",
] as const;

function isMissingRelationError(err: { message?: string; code?: string }): boolean {
  const msg = String(err.message ?? "");
  return (
    err.code === "42P01" ||
    /does not exist|relation.*not found|schema cache/i.test(msg)
  );
}

function conditionFromRecord(
  row: Record<string, unknown>,
  keys: readonly string[]
): "New" | "Used" | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string") {
      const n = normalizeToNewUsed(v);
      if (n) return n;
    }
  }
  return null;
}

/** title に明示的な新品/中古表記がある場合のみ（誤爆を抑える） */
function conditionFromSkuMappingTitle(title: unknown): "New" | "Used" | null {
  const t = String(title ?? "");
  if (/【\s*中古\s*】|【中古】|\(中古\)|\b中古品\b/i.test(t)) return "Used";
  if (/【\s*新品\s*】|【新品】|\(新品\)/i.test(t)) return "New";
  return null;
}

/**
 * SKU → New/Used。辞書・マスタ・title 推定のいずれでも決まらない SKU は 'New'。
 */
export async function buildSkuToConditionMap(
  supabase: SupabaseClient,
  skus: string[]
): Promise<Map<string, "New" | "Used">> {
  const out = new Map<string, "New" | "Used">();
  const normSkus = [...new Set(skus.map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (normSkus.length === 0) return out;

  for (const part of chunkArray(normSkus, CHUNK)) {
    const { data, error } = await supabase.from("amazon_sku_conditions").select("*").in("sku", part);
    if (error) {
      if (!isMissingRelationError(error)) {
        console.warn("[amazon-order-import-condition] amazon_sku_conditions select failed:", error.message);
      }
      break;
    }
    for (const row of data ?? []) {
      const rec = row as Record<string, unknown>;
      const sku = String(rec.sku ?? "").trim();
      if (!sku) continue;
      const c = conditionFromRecord(rec, AMAZON_SKU_CONDITION_KEYS);
      if (c && !out.has(sku)) out.set(sku, c);
    }
  }

  const skuToJan = new Map<string, string>();

  for (const part of chunkArray(normSkus, CHUNK)) {
    const { data, error } = await supabase
      .from("sku_mappings")
      .select("*")
      .in("sku", part)
      .eq("platform", "Amazon");
    if (error) {
      console.warn("[amazon-order-import-condition] sku_mappings select failed:", error.message);
      continue;
    }
    for (const row of data ?? []) {
      const rec = row as Record<string, unknown>;
      const sku = String(rec.sku ?? "").trim();
      if (!sku) continue;
      if (!out.has(sku)) {
        const fromCols = conditionFromRecord(rec, SKU_MAPPING_CONDITION_KEYS);
        const fromTitle = conditionFromSkuMappingTitle(rec.title);
        const resolved = fromCols ?? fromTitle;
        if (resolved) out.set(sku, resolved);
      }
      const jan = String(rec.jan_code ?? "").trim();
      if (jan && !skuToJan.has(sku)) skuToJan.set(sku, jan);
    }
  }

  const jans = [...new Set(skuToJan.values())].filter(Boolean);
  const janToCond = new Map<string, "New" | "Used">();
  for (const part of chunkArray(jans, CHUNK)) {
    const { data, error } = await supabase.from("products").select("*").in("jan_code", part);
    if (error) {
      console.warn("[amazon-order-import-condition] products select failed:", error.message);
      continue;
    }
    for (const row of data ?? []) {
      const rec = row as Record<string, unknown>;
      const jan = String(rec.jan_code ?? "").trim();
      if (!jan) continue;
      const c = conditionFromRecord(rec, PRODUCT_CONDITION_KEYS);
      if (c && !janToCond.has(jan)) janToCond.set(jan, c);
    }
  }

  for (const sku of normSkus) {
    if (out.has(sku)) continue;
    const jan = skuToJan.get(sku);
    if (!jan) continue;
    const c = janToCond.get(jan);
    if (c) out.set(sku, c);
  }

  for (const sku of normSkus) {
    if (!out.has(sku)) out.set(sku, "New");
  }

  return out;
}
