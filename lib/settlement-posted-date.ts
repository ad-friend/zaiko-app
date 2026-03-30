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

  // 例: 2025/10/01 2:39:51 JST（Amazonレポートリポジトリ等）
  {
    const m = t.match(
      /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(JST)?\s*$/i
    );
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const hh = Number(m[4]);
      const mm = Number(m[5]);
      const ss = Number(m[6] ?? "0");
      if ([y, mo, d, hh, mm, ss].every((n) => Number.isFinite(n))) {
        const pad2 = (n: number) => String(n).padStart(2, "0");
        const isoLike = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}+09:00`;
        const ms = Date.parse(isoLike);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
      }
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const ms = Date.parse(`${t}T00:00:00+09:00`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const normalized = t.replace(/\//g, "-");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
