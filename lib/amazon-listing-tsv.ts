/**
 * 出品詳細レポート（GET_MERCHANT_LISTINGS_ALL_DATA 等）の TSV/CSV を読む。英語・日本語の列名の両方に対応。
 * 2026-11-17 相談-12：app/api/amazon/sync-sku-conditions/route.ts の読み方（手動の取り込み）をそのまま写し、
 * 定期処理（listing_report_poll）でも使う。手動側のファイルは変えていない。
 */
import Papa from "papaparse";
/** 全角英数字・見えない空白を吸収しつつ、大文字小文字無視で列名を比較する */
function normalizeHeaderKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .replace(/[\-_.:()]/g, "")
    .replace(/\//g, "");
}

function pickHeaderKey(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers
    .map((h) => ({ actual: h, norm: normalizeHeaderKey(h) }))
    .filter((x) => x.norm.length > 0);

  for (const c of candidates) {
    const cand = normalizeHeaderKey(c);
    if (!cand) continue;
    const exact = normalizedHeaders.find((h) => h.norm === cand);
    if (exact) return exact.actual;
    const includes = normalizedHeaders.find((h) => h.norm.includes(cand));
    if (includes) return includes.actual;
  }
  return null;
}

function conditionFromItemCondition(raw: string): "New" | "Used" {
  const n = Number(String(raw ?? "").trim());
  if (n === 11) return "New";
  return "Used";
}

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

export function parseActiveListingsTsv(text: string): {
  rows: Array<{ sku: string; asin: string | null; condition_id: "New" | "Used" }>;
  parseErrors: string[];
} {
  const bomStripped = text.replace(/^\uFEFF/, "");
  const firstLine =
    bomStripped
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const delimiter = tabCount >= commaCount ? "\t" : ",";

  const parsed = Papa.parse<Record<string, string>>(bomStripped, {
    header: true,
    delimiter,
    skipEmptyLines: "greedy",
  });

  const parseErrors: string[] = [];
  if (parsed.errors?.length) {
    for (const e of parsed.errors.slice(0, 20)) {
      parseErrors.push(e.message ?? String(e));
    }
  }

  const headers = (parsed.meta.fields ?? []).filter((h): h is string => typeof h === "string");
  // 英語・日本語セラーセントラル双方の列名（normalizeHeaderKey で比較）
  const skuHeader = pickHeaderKey(headers, [
    "seller-sku",
    "sellersku",
    "sku",
    "出品者sku",
    "出品者SKU",
  ]);
  const asinHeader = pickHeaderKey(headers, [
    "asin1",
    "asin",
    "ASIN 1",
    "asin 1",
    "商品ID",
    "商品id",
  ]);
  const conditionHeader = pickHeaderKey(headers, [
    "item-condition",
    "itemcondition",
    "condition",
    "コンディション",
  ]);

  if (!skuHeader || !asinHeader) {
    return {
      rows: [],
      parseErrors: [
        ...parseErrors,
        "必須列が見つかりません。次のいずれかの列が必要です: seller-sku（出品者SKU）/ asin1・ASIN 1・asin・商品ID。",
      ],
    };
  }

  if (!conditionHeader) {
    parseErrors.push(
      "コンディション列がありません。全行を新品(New)として登録します。"
    );
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];
  const bySku = new Map<string, { sku: string; asin: string | null; condition_id: "New" | "Used" }>();

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || typeof r !== "object") continue;
    const sku = toTrimmedString(r[skuHeader]);
    if (!sku) continue;
    const asinRaw = toTrimmedString(r[asinHeader]);
    const condition_id: "New" | "Used" = conditionHeader
      ? conditionFromItemCondition(toTrimmedString(r[conditionHeader]))
      : "New";
    bySku.set(sku, {
      sku,
      asin: asinRaw || null,
      condition_id,
    });
  }

  return { rows: [...bySku.values()], parseErrors };
}
