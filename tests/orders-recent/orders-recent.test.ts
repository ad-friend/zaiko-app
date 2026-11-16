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
test('既存全分岐・quiet集合・日次集計を含め、許可した追加以外は完全一致',()=>{
 assert.equal(restored(source),normalize(before[file]));
 assert.equal(normalize(fs.readFileSync('app/api/amazon/fetch-orders/route.ts','utf8')).replace('export const maxDuration = 300;\n',''), normalize(before['app/api/amazon/fetch-orders/route.ts']));
 assert.equal(normalize(fs.readFileSync('README.md','utf8')).split('\n').filter(l=>!l.startsWith('| `orders_recent_poll`')).join('\n'),normalize(before['README.md']));
});
function harness(iso:string, response:any={ok:true,body:{rowsUpserted:7,ordersFetched:3,message:'done'}}) {
 const calls:any[]=[]; const db:any[]=[]; let sales=0;
 const supabase={from(table:string){ const chain:any={}; for(const op of ['insert','update','delete','select','limit','eq','lt','gte']) chain[op]=(...args:any[])=>{db.push({table,op,args}); return chain;}; chain.then=(resolve:any)=>resolve({data:table==='cron_jobs'?[{id:'offline-id'}]:[],error:null});return chain;}};
 class FixedDate extends Date { constructor(value?:any){super(value??iso);} static now(){return Date.parse(iso);} }
 const exports:any={};
 const context={exports, Date:FixedDate, console, process:{env:{CRON_SECRET:'offline-test-only'}}, URL, Set, Buffer, setTimeout,
 fetch:async(url:any,options:any)=>{ calls.push({url,options});return {ok:response.ok,text:async()=>typeof response.body==='string'?response.body:JSON.stringify(response.body)};},
 require:(name:string)=>{
 if(name==='next/server')return {NextResponse:{json:(body:any,options:any={})=>({body,status:options.status??200})}};
 if(name==='@/lib/supabase')return {supabase};
 if(name==='@/lib/sales-traffic-sync')return {runSalesTrafficPoll:async()=>{sales++;return {fetched:4,summary:'sales',metrics:{step:'sales'}};}};
 if(name==='zlib')return require('node:zlib');
 if(name==='@/lib/amazon-financial-events'||name==='@/lib/cron-continuation-state')return {};
 throw new Error('Unexpected import: '+name);
 }};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const run=(key:string,auth='Bearer offline-test-only')=>exports.GET({url:'https://offline.invalid/api/cron/run?jobKey='+key+'&reconcile=1',headers:new Headers({authorization:auth,host:'offline.invalid'})});
 return {run,calls,db,sales:()=>sales};
}
for(const [iso,day] of [['2026-11-16T00:01:00Z','2026-11-14'],['2026-11-16T23:59:00Z','2026-11-14'],['2026-03-01T00:00:00Z','2026-02-27'],['2028-03-01T00:00:00Z','2028-02-28'],['2026-01-01T00:00:00Z','2025-12-30']]) {
 test('新分岐はUTC日付2日前のstartDateのみ: '+iso,async()=>{
 const h=harness(iso); const result=await h.run('orders_recent_poll'); assert.equal(result.status,200);
 assert.equal(h.calls.length,1); assert.equal(h.calls[0].url,'https://offline.invalid/api/amazon/fetch-orders?startDate='+day); assert.equal(h.calls[0].options.method,'GET');
 const finish=h.db.find(x=>x.table==='cron_jobs'&&x.op==='update').args[0]; assert.equal(finish.status,'success'); assert.equal(finish.metrics.startDate,day); assert.equal(finish.metrics.rowsUpserted,7); assert.equal(finish.metrics.ordersFetched,3); assert.equal(finish.metrics.message,'done');
 assert.equal(h.db.filter(x=>x.table==='dashboard_notices'&&x.op==='insert').length,1);
 });
}
test('従来orders_pollはminutes=10、sales_traffic_pollは従来の実行関数',async()=>{ const h=harness('2026-11-16T00:00:00Z');await h.run('orders_poll');assert.equal(h.calls[0].url,'https://offline.invalid/api/amazon/fetch-orders?minutes=10');await h.run('sales_traffic_poll');assert.equal(h.sales(),1);assert.equal(h.calls.length,1); });
test('失敗をcron_jobsと通知へ記録し、成功にしない',async()=>{const h=harness('2026-11-16T00:00:00Z',{ok:false,body:{error:'offline failure'}});const r=await h.run('orders_recent_poll');assert.equal(r.status,500);const p=h.db.find(x=>x.op==='update').args[0];assert.equal(p.status,'error');assert.equal(p.error_message,'offline failure');});
test('認証失敗時はAPI・DBへ進まない',async()=>{const h=harness('2026-11-16T00:00:00Z');assert.equal((await h.run('orders_recent_poll','bad')).status,401);assert.equal(h.calls.length,0);assert.equal(h.db.length,0);});
