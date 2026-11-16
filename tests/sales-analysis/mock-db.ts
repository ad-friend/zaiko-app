import type { SupabaseClient } from "@supabase/supabase-js";
type Row = Record<string, unknown>;
export class MockDatabase {
  tables = new Map<string, Row[]>();
  calls: { table: string; action: string; count: number }[] = [];
  failTable: string | null = null;
  client = { from: (table: string) => this.query(table) } as unknown as SupabaseClient;
  private query(table: string) {
    let action = "select", payload: Row[] = [], conflict = "", offset = 0, count = Infinity, single = false;
    const filters: ((r: Row) => boolean)[] = [], ordering: { key: string; ascending: boolean }[] = [];
    const execute = () => {
      this.calls.push({ table, action, count: payload.length });
      if (this.failTable === table) return { data: null, error: { code: "MOCK_FAILURE" } };
      let stored = this.tables.get(table) ?? [];
      let modified: Row[] | null = null;
      if (action === "insert") {
        if (stored.some(r => r.label === payload[0].label && r.start_date === payload[0].start_date)) return { data: null, error: { code: "23505" } };
        modified = [{ ...payload[0], id: stored.length + 1 }]; stored.push(...modified);
      } else if (action === "update") {
        modified = stored.filter(r => filters.every(f => f(r)));
        for (const row of modified) Object.assign(row, payload[0]);
      } else if (action === "upsert") {
        const keys = conflict.split(",");
        for (const row of payload) { const i = stored.findIndex(r => keys.every(k => r[k] === row[k])); if (i < 0) stored.push({ ...row }); else stored[i] = { ...stored[i], ...row }; }
      } else if (action === "delete") { modified = stored.filter(r => filters.every(f => f(r))); stored = stored.filter(r => !filters.every(f => f(r))); }
      this.tables.set(table, stored);
      let data = modified ?? stored.filter(r => filters.every(f => f(r)));
      for (const { key, ascending } of [...ordering].reverse()) data.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0) * (ascending ? 1 : -1));
      data = data.slice(offset, offset + count);
      return { data: single ? data[0] ?? null : data, error: null };
    };
    const q = {
      select: () => q,
      maybeSingle: () => { single = true; return q; },
      insert: (row: Row) => { action = "insert"; payload = [row]; return q; },
      update: (row: Row) => { action = "update"; payload = [row]; return q; },
      upsert: (rows: Row[], options: { onConflict: string }) => { action = "upsert"; payload = rows; conflict = options.onConflict; return q; },
      delete: () => { action = "delete"; return q; },
      eq: (k: string, v: unknown) => { filters.push(r => String(r[k]) === String(v)); return q; },
      neq: (k: string, v: unknown) => { filters.push(r => r[k] !== v); return q; },
      gte: (k: string, v: string) => { filters.push(r => String(r[k]) >= v); return q; },
      lte: (k: string, v: string) => { filters.push(r => String(r[k]) <= v); return q; },
      in: (k: string, values: string[]) => { filters.push(r => values.includes(String(r[k]))); return q; },
      not: (k: string, _operator: string, values: string) => { filters.push(r => !values.slice(1, -1).split(",").includes(String(r[k]))); return q; },
      or: (expression: string) => { const [low, high] = expression.split(",").map(v => v.split(".").slice(2).join(".")); filters.push(r => String(r.date) < low || String(r.date) > high); return q; },
      order: (key: string, options?: { ascending?: boolean }) => { ordering.push({ key, ascending: options?.ascending !== false }); return q; },
      range: (start: number, end: number) => { offset = start; count = end - start + 1; return q; },
      limit: (n: number) => { count = n; return q; },
      then: (resolve: (v: ReturnType<typeof execute>) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve().then(execute).then(resolve, reject),
    };
    return q;
  }
}
