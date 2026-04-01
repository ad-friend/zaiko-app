import Papa from "papaparse";

export type AmazonReturnImportRow = {
  amazon_order_id: string;
  disposition: string;
  /** レポートの返品日列の生文字列 */
  return_date_raw: string;
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

/** 返品レポートの日付文字列を ISO に正規化（失敗時は null） */
export function parseAmazonReturnDateToIso(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  const norm = s.split("/").join("-").split(".").join("-");
  const t2 = Date.parse(norm);
  if (Number.isFinite(t2)) return new Date(t2).toISOString();
  return null;
}

/** より早い日時の ISO を採用 */
export function pickEarlierIso(a: string | null, b: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function stripToHeaderLine(text: string, fileName: string): { stripped: string; skippedPrefixLines: number } {
  const bomStripped = text.replace(/^\uFEFF/, "");
  const lines = bomStripped.split(/\r?\n/);

  // 返品レポートは先頭からヘッダーのことが多いが、タイトル/説明行が付くケースもあるため
  // 「注文ID列が含まれていそうな行」までスキップする。
  const headerHint = /注文番号|注文id|amazon[\s_-]*order[\s_-]*id|order[\s_-]*id/i;

  // 先頭50行まで探索（十分なはず）
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;

    const delim = guessDelimiter(fileName, line);
    const cols = line.split(delim).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;

    if (headerHint.test(line)) {
      return { stripped: lines.slice(i).join("\n"), skippedPrefixLines: i };
    }
  }

  return { stripped: bomStripped, skippedPrefixLines: 0 };
}

/**
 * FBA 返品レポート等の CSV/TSV から order id と disposition を抽出する。
 */
export function parseAmazonReturnsDelimitedText(text: string, fileName: string): {
  rows: AmazonReturnImportRow[];
  rowErrors: string[];
} {
  const { stripped, skippedPrefixLines } = stripToHeaderLine(text, fileName);
  const firstNonEmptyLine =
    stripped
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  const delimiter = guessDelimiter(fileName, firstNonEmptyLine);

  const parsed = Papa.parse<Record<string, string>>(stripped, {
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

  const returnDateHeader = pickHeaderKey(headers, [
    "return-date",
    "return date",
    "returndate",
    "return-request-date",
    "return request date",
    "returnauthorizationdate",
    "return authorization date",
    "authorization date",
    "authorization-date",
    "返品日",
    "返品受付日",
    "返品受付日時",
    "返品日時",
  ]);

  const rowErrors: string[] = [];
  const rows: AmazonReturnImportRow[] = [];

  if (!orderIdHeader) {
    throw new Error(
      "必須ヘッダーが見つかりません（amazon-order-id / order-id などの注文ID列）。"
    );
  }
  if (skippedPrefixLines > 0) {
    rowErrors.push(`先頭の説明行を ${skippedPrefixLines} 行スキップしました。`);
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || typeof r !== "object") continue;

    const amazon_order_id = toTrimmedString(r[orderIdHeader]);
    const disposition = dispositionHeader ? toTrimmedString(r[dispositionHeader]) : "";
    const return_date_raw = returnDateHeader ? toTrimmedString(r[returnDateHeader]) : "";

    if (!amazon_order_id) {
      rowErrors.push(`行 ${i + 2}: 注文IDが空です。`);
      continue;
    }

    rows.push({
      amazon_order_id,
      disposition,
      return_date_raw,
    });
  }

  return { rows, rowErrors };
}
