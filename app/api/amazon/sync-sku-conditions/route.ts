import { NextRequest, NextResponse } from "next/server";
import Papa from "papaparse";
import { supabase } from "@/lib/supabase";

const UPSERT_CHUNK = 500;

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

function conditionFromItemCondition(raw: string): "New" | "Used" {
  const n = Number(String(raw ?? "").trim());
  if (n === 11) return "New";
  return "Used";
}

function toTrimmedString(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function parseActiveListingsTsv(text: string): {
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
  const skuHeader = pickHeaderKey(headers, ["seller-sku", "sellersku", "sku"]);
  const asinHeader = pickHeaderKey(headers, ["asin1", "asin"]);
  const conditionHeader = pickHeaderKey(headers, ["item-condition", "itemcondition", "condition"]);

  if (!skuHeader || !asinHeader || !conditionHeader) {
    return {
      rows: [],
      parseErrors: [
        ...parseErrors,
        "必須列が見つかりません。seller-sku / asin1（または asin）/ item-condition が必要です。",
      ],
    };
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];
  const bySku = new Map<string, { sku: string; asin: string | null; condition_id: "New" | "Used" }>();

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r || typeof r !== "object") continue;
    const sku = toTrimmedString(r[skuHeader]);
    if (!sku) continue;
    const asinRaw = toTrimmedString(r[asinHeader]);
    const condRaw = toTrimmedString(r[conditionHeader]);
    bySku.set(sku, {
      sku,
      asin: asinRaw || null,
      condition_id: conditionFromItemCondition(condRaw),
    });
  }

  return { rows: [...bySku.values()], parseErrors };
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "file フィールドに TSV を添付してください。" }, { status: 400 });
    }

    const text = await file.text();
    const { rows, parseErrors } = parseActiveListingsTsv(text);

    if (parseErrors.length && rows.length === 0) {
      return NextResponse.json(
        { error: parseErrors[0] ?? "パースに失敗しました。", parseErrors },
        { status: 400 }
      );
    }

    if (!rows.length) {
      return NextResponse.json({
        ok: true,
        upserted: 0,
        deletedStale: 0,
        parseErrors: parseErrors.length ? parseErrors : undefined,
      });
    }

    const nowIso = new Date().toISOString();
    const payloads = rows.map((r) => ({
      sku: r.sku,
      condition_id: r.condition_id,
      asin: r.asin,
      last_updated: nowIso,
    }));

    let upserted = 0;
    for (let i = 0; i < payloads.length; i += UPSERT_CHUNK) {
      const chunk = payloads.slice(i, i + UPSERT_CHUNK);
      const { data, error } = await supabase
        .from("amazon_sku_conditions")
        .upsert(chunk, { onConflict: "sku" })
        .select("sku");

      if (error) {
        return NextResponse.json(
          { error: error.message, upserted, parseErrors: parseErrors.length ? parseErrors : undefined },
          { status: 500 }
        );
      }
      upserted += Array.isArray(data) ? data.length : 0;
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 2);
    const cutoffIso = cutoff.toISOString();

    const { error: delErr, count: deletedStale } = await supabase
      .from("amazon_sku_conditions")
      .delete({ count: "exact" })
      .lt("last_updated", cutoffIso);

    if (delErr) {
      return NextResponse.json(
        {
          error: `同期は完了しましたが、古い行の削除に失敗しました: ${delErr.message}`,
          upserted,
          deletedStale: 0,
          parseErrors: parseErrors.length ? parseErrors : undefined,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      upserted,
      deletedStale: deletedStale ?? 0,
      parseErrors: parseErrors.length ? parseErrors : undefined,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
