import Papa from "papaparse";

export type AmazonReturnImportRow = {
  amazon_order_id: string;
  disposition: string;
};

function normalizeHeaderKey(s: string): string {
  return s
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

function guessDelimiter(fileName: string, headerLine: string): "," | "\t" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) return "\t";
  if (lower.endsWith(".csv")) return ",";

  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const tabCount = (headerLine.match(/\t/g) ?? []).length;
  return tabCount > commaCount ? "\t" : ",";
}

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/**
 * FBA 返品レポート等の CSV/TSV から order id と disposition を抽出する。
 */
export function parseAmazonReturnsDelimitedText(text: string, fileName: string): {
  rows: AmazonReturnImportRow[];
  rowErrors: string[];
} {
  const firstNonEmptyLine =
    text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  const delimiter = guessDelimiter(fileName, firstNonEmptyLine);

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter: delimiter === "," ? "," : "\t",
    skipEmptyLines: "greedy",
  });

  const headers = (parsed.meta.fields ?? []).filter((h) => typeof h === "string") as string[];

  const orderIdHeader = pickHeaderKey(headers, [
    "amazon-order-id",
    "amazon order id",
    "amazonorderid",
    "order-id",
    "order id",
    "orderid",
    "注文ID",
    "注文番号",
  ]);

  const dispositionHeader = pickHeaderKey(headers, [
    "disposition",
    "detailed-disposition",
    "detailed disposition",
    "detaileddisposition",
    "返品区分",
    "処理区分",
  ]);

  const rowErrors: string[] = [];
  const rows: AmazonReturnImportRow[] = [];

  if (!orderIdHeader) {
    throw new Error(
      "必須ヘッダーが見つかりません（amazon-order-id / order-id などの注文ID列）。"
    );
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || typeof r !== "object") continue;

    const amazon_order_id = toTrimmedString(r[orderIdHeader]);
    const disposition = dispositionHeader ? toTrimmedString(r[dispositionHeader]) : "";

    if (!amazon_order_id) {
      rowErrors.push(`行 ${i + 2}: 注文IDが空です。`);
      continue;
    }

    rows.push({
      amazon_order_id,
      disposition,
    });
  }

  return { rows, rowErrors };
}
