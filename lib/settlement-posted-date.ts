/**
 * 本消込で inbound_items.settled_at に載せる日時（sales_transactions.posted_date 由来）
 */

export function earliestPostedDateIso(rows: Iterable<{ posted_date?: string | null }>): string | null {
  let best: number | null = null;
  for (const r of rows) {
    const p = r.posted_date;
    if (p == null) continue;
    const s = String(p).trim();
    if (!s) continue;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) continue;
    if (best === null || t < best) best = t;
  }
  if (best === null) return null;
  return new Date(best).toISOString();
}

/** 他販路 CSV 等: postedDate / orderDate（yyyy-MM-dd や ISO）を settlement 用 ISO に */
export function parseFlexiblePostedDateToIso(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const ms = Date.parse(`${t}T00:00:00+09:00`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const normalized = t.replace(/\//g, "-");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
