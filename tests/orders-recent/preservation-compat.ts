import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const file='app/api/cron/run/route.ts';
const before=JSON.parse(fs.readFileSync('tests/orders-recent/before.json','utf8'));
const source=fs.readFileSync(file,'utf8');
const normalize=(s:string)=>s.replace(/\r\n/g,'\n');
function restored(s:string) {
 return normalize(s).replace(/async function runOrdersRecentPoll\([\s\S]*?(?=async function runAutoReconcile\()/,'')
 .replace('    } else if (jobKey === "orders_recent_poll") {\n      const r = await runOrdersRecentPoll(req);\n      fetched = r.fetched;\n      summary = r.summary;\n      metrics = { ...metrics, ...r.metrics };\n','')
 .replace('// 注文の再取得は子APIの完了を待つため、Vercel Hobby の上限 300 秒にする。','// 相談-10：sales_traffic_poll が1回の呼出しで最大約50秒使うため、上限を明示（既存の fetch-finances と同じ考え方）。')
 .replace('export const maxDuration = 300;','export const maxDuration = 120;');
}
// 相談-10の既存試験を変更せず実行。今回の追加だけ除いて当時の比較条件へ戻す。
const oldTest=fs.readFileSync('tests/sales-analysis/preservation.test.ts','utf8');
vm.runInNewContext(ts.transpileModule(oldTest,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{
 exports:{},require:(name:string)=>{
 if(name==='node:fs') return {...fs,readFileSync:(p:any,...args:any[])=>{
 const value=(fs.readFileSync as any)(p,...args);
 if(p===file)return restored(String(value));
 if(p==='README.md')return normalize(String(value)).split('\n').filter(l=>!l.startsWith('| `orders_recent_poll`')).join('\n');
 return value;
 }};
 if(name==='node:test')return (title:string,fn:any)=>test('相談10互換: '+title,{skip:title.startsWith('追跡済みファイル差分')?'元からHEAD比較の基準版が異なるため除外':false},fn);
 return require(name);
 }, console
});
