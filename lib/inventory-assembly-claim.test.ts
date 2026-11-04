import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assignOrderIdToRootsAndDescendants, InboundAlreadyClaimedError } from "./inventory-assembly";

type Row = { id: number; order_id: string | null; parent_item_id: number | null; effective_unit_price: number };

function fakeClient(rows: Row[]): SupabaseClient {
  function query() {
    let patch: Partial<Row> | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const builder = {
      select() {
        return builder;
      },
      update(p: Partial<Row>) {
        patch = p;
        return builder;
      },
      in(col: keyof Row, values: unknown[]) {
        filters.push((r) => values.includes(r[col]));
        return builder;
      },
      eq(col: keyof Row, value: unknown) {
        filters.push((r) => r[col] === value);
        return builder;
      },
      or(expr: string) {
        const oid = /order_id\.eq\."([^"]+)"/.exec(expr)?.[1];
        filters.push((r) => r.order_id == null || r.order_id === oid);
        return builder;
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (patch) for (const r of hit) Object.assign(r, patch);
        resolve({ data: hit.map((r) => ({ ...r })), error: null });
      },
    };
    return builder;
  }
  return { from: () => query() } as unknown as SupabaseClient;
}

async function main() {
  const rows: Row[] = [
    { id: 1, order_id: null, parent_item_id: null, effective_unit_price: 0 },
    { id: 2, order_id: null, parent_item_id: null, effective_unit_price: 0 },
    { id: 3, order_id: null, parent_item_id: 1, effective_unit_price: 0 },
  ];
  const client = fakeClient(rows);

  const linked = await assignOrderIdToRootsAndDescendants([1], "A", client);
  assert.deepEqual(linked.sort(), [1, 3]);
  assert.equal(rows[0].order_id, "A");
  assert.equal(rows[2].order_id, "A");

  await assert.rejects(assignOrderIdToRootsAndDescendants([1], "B", client), InboundAlreadyClaimedError);
  assert.equal(rows[0].order_id, "A");

  await assert.rejects(assignOrderIdToRootsAndDescendants([2, 1], "B", client), InboundAlreadyClaimedError);
  assert.equal(rows[1].order_id, null);
  assert.equal(rows[0].order_id, "A");

  await assignOrderIdToRootsAndDescendants([1], "A", client);
  assert.equal(rows[0].order_id, "A");

  console.log("inventory-assembly-claim tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
