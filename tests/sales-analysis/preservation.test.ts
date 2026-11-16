import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const before = JSON.parse(readFileSync("tests/sales-analysis/before.json", "utf8")) as Record<string, string>;
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
function sections(text: string) {
  const source = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), result: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "section") result.push(node.getText(source)); ts.forEachChild(node, visit); };
  visit(source); return result;
}
test("既存全sectionのJSX・計算式カード・お知らせ・在庫調整が移動以外同一", () => {
  const old = before["app/dashboard/page.tsx"], current = read("app/dashboard/page.tsx");
  const start = old.indexOf('                <div className={`${cardBase} flex flex-col justify-center bg-slate-50/80`}>');
  const end = old.indexOf("\n                </div>", start) + "\n                </div>".length;
  const formula = old.slice(start, end); assert.ok(current.includes(formula));
  const normalize = (s: string) => s.replace(/\n[ \t]*\n/g, "\n");
  assert.deepEqual(sections(old.replace(formula, "")).map(normalize), sections(current).map(normalize));
  // 2026-11-16 社長の指示でお知らせは画面に出さない（Telegram に集約）。表示していないことを確かめる。
  assert.ok(!current.includes("<DashboardNotices"));
  assert.equal(current.split("<QuickInventoryAdjustment />").length, 2);
  const component = "export default function DashboardPage()";
  const bodyEnd = (s: string) => s.lastIndexOf("\n  return (");
  assert.equal(current.slice(current.indexOf(component), bodyEnd(current)), old.slice(old.indexOf(component), bodyEnd(old)));
  assert.ok(current.indexOf("<SalesAnalysisChart") < current.indexOf("③ 当月の数字"));
});
test("cronはimport・maxDuration・新jobKey分岐の追加だけ・既存5本とquiet集合は完全一致", () => {
  const current = read("app/api/cron/run/route.ts");
  const restored = current.replace("\n// 相談-10：sales_traffic_poll が1回の呼出しで最大約50秒使うため、上限を明示（既存の fetch-finances と同じ考え方）。\nexport const maxDuration = 120;\n", "").replace('import { runSalesTrafficPoll } from "@/lib/sales-traffic-sync";\n', "").replace('    } else if (jobKey === "sales_traffic_poll") {\n      const r = await runSalesTrafficPoll();\n      fetched = r.fetched;\n      summary = r.summary;\n      metrics = { ...metrics, ...r.metrics };\n', "");
  assert.equal(restored, before["app/api/cron/run/route.ts"]);
});
test("既存schemaは完全なprefix・READMEは新ジョブ1行だけ", () => {
  assert.ok(read("supabase-schema.sql").startsWith(before["supabase-schema.sql"]));
  assert.equal(read("README.md").split("\n").filter(line => !line.startsWith("| `sales_traffic_poll`")).join("\n"), before["README.md"]);
});
test("追跡済みファイル差分は許可された4本だけ・控えはHEADと一致", () => {
  const diff = spawnSync("git", ["diff", "--name-only"], { encoding: "utf8" }); assert.equal(diff.status, 0);
  assert.deepEqual(diff.stdout.trim().split(/\r?\n/).sort(), Object.keys(before).sort());
  for (const [file, content] of Object.entries(before)) { const head = spawnSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }); assert.equal(head.status, 0); assert.equal(content, head.stdout.replace(/\r\n/g, "\n")); }
});
test("新4表はanon SELECTのみ・サービスキーはサーバー専用の参照だけ", () => {
  for (const file of ["migration_sales_traffic_daily.sql", "migration_sales_traffic_asin_totals.sql", "migration_google_trends_daily.sql", "migration_sale_events.sql"]) {
    const sql = read(`docs/${file}`); assert.match(sql, /ENABLE ROW LEVEL SECURITY/); assert.match(sql, /FOR SELECT TO anon USING \(true\)/); assert.doesNotMatch(sql, /FOR (?:ALL|INSERT|UPDATE|DELETE)\b/);
  }
  for (const file of ["components/WeeklyHighlights.tsx", "components/SalesAnalysisChart.tsx"]) { const text = read(file); assert.doesNotMatch(text, /supabase-server|sales-traffic-sync|SUPABASE_SERVICE_ROLE_KEY/); }
});
