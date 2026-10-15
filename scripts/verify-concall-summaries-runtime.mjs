// Real local workerd SQL/RPC, alarm and restart persistence. No remote bindings or source calls.
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
mkdirSync('.cache',{recursive:true});const scratch=mkdtempSync(resolve('.cache/sattva-summary-runtime-'));
const finder=createServer();await new Promise(done=>finder.listen(0,'127.0.0.1',done));
const port=finder.address().port;await new Promise(done=>finder.close(done));
const origin=`http://127.0.0.1:${port}`,config=join(scratch,'wrangler.json');
const entry=`import { CaptureRegistry as ActualRegistry } from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
export class SummaryTest extends ActualRegistry {
 constructor(ctx,env) { super(ctx,env); this.summaries.now=()=>Date.parse('2026-09-10T06:00:00Z'); }
 async retire() {await this.ctx.storage.put('summary-timer',{started:true});await this.ctx.storage.setAlarm(Date.now()+86400000);await this.alarm();return {alarmAt:await this.ctx.storage.getAlarm()};}
 seed(inventory,body) {this.summaries.sync(inventory);const claim=this.summaries.reserve('1:1',crypto.randomUUID());this.summaries.complete('1:1',{...claim,outcome:'ready',body});return this.summaries.status();}
 async readonlyExport(input) {const before=this.ctx.storage.sql.exec('SELECT total_changes() n').one().n;const result=await this.summaryExport(input);return {...result,writes:this.ctx.storage.sql.exec('SELECT total_changes() n').one().n-before};}
}
export default {async fetch(request,env) { const input=await request.json(),store=env.SUMMARIES.getByName('local-private-account');
if(input.action==='seed')return Response.json(await store.seed(input.inventory,input.body));
if(input.action==='retire')return Response.json(await store.retire());
if(input.action==='export')return Response.json(await store.readonlyExport(input));
if(input.action==='write') {try{await store.summaryReserve('1:1',crypto.randomUUID());return Response.json({blocked:false});}catch{return Response.json({blocked:true});}}
if(input.action==='read')return Response.json(await store.summaryRead(input.ids));
return Response.json(await store.summaryStatus()); }};`;
writeFileSync(join(scratch,'entry.mjs'),entry);
writeFileSync(config,JSON.stringify({name:'summary-local-test',main:join(scratch,'entry.mjs'),compatibility_date:'2026-05-23',
  vars:{SCREENER_SUMMARIES_ENABLED:'true',GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main',GH_DISPATCH_TOKEN:'fixture'},durable_objects:{bindings:[{name:'SUMMARIES',class_name:'SummaryTest'}]},migrations:[{tag:'v1',new_sqlite_classes:['SummaryTest']}]}));
let child,logs='';
async function call(input={}) {const response=await fetch(origin,{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});assert(response.ok,await response.clone().text());return response.json();}
async function start() {
  child=spawn(process.env.WRANGLER_BIN||'npx',[...(process.env.WRANGLER_BIN?[]:['--yes','wrangler@4']),'dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(scratch,'state')],
    {cwd:scratch,detached:true,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{logs=(logs+chunk).slice(-12000);});
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {if(child.exitCode!==null) throw Error(logs);try {await call();return;}catch{}await new Promise(done=>setTimeout(done,500));}
  throw Error(`Local Worker did not start: ${logs}`);
}
async function stop() {
  if(!child||child.exitCode!==null)return;const done=once(child,'exit');
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);
  try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}
}
const at='2026-09-10T06:00:00Z';
const target={id:'123',isin:'INE000000001',companyKey:'TEST',companyUrl:'https://www.screener.in/company/TEST/',name:'Test company',sourceName:'Test company',ticker:'TEST',
  url:'https://www.screener.in/concalls/summary/123/',sourceDocumentUrl:'https://example.test/transcript.pdf',kind:'Transcript',rank:0,publishedDate:'2026-09-09'};
const inventory={version:1,portfolioRevision:'a'.repeat(64),portfolioCheckedAt:at,portfolioAsOf:'2026-09-09',portfolioWorkbookUploadedAt:at,sourceCheckedAt:at,holdings:[{isin:target.isin,name:target.name,discovery:'matched'}],targets:[target]};
const body={title:'Concall Summary - Test company',blocks:[{type:'paragraph',text:'Synthetic fixture notes discuss the operating performance of a test company and the current outlook for demand and costs. These words are only used in the local runtime test.'}]};
try {
  await start();await call({action:'seed',inventory,body});
  const before=await call();assert.equal(before.ready,1);assert.equal(before.automatedRequestsLast24h,1);
  assert.deepEqual(await call({action:'retire'}),{alarmAt:null},'An old summary alarm retires without dispatching or source requests');
  assert.deepEqual(await call({action:'write'}),{blocked:true},'Cloudflare RPC cannot reserve another paid request');
  const exported=await call({action:'export',table:'summary_attempts',cursor:0});assert.equal(exported.writes,0);assert.equal(exported.rows.length,1);assert.equal(exported.rows[0].outcome,'ready');
  const inventoryCopy=await call({action:'export'});assert.equal(inventoryCopy.writes,0);assert.equal(inventoryCopy.tables.length,4);
  await stop();await start();
  assert.deepEqual((await call({action:'read',ids:['123']}))[0].body,body);
  const after=await call();assert.equal(after.automatedRequestsLast24h,1);assert.equal(after.schedule.runtime,'github-actions');
  console.log('PASS local workerd: retained private bodies and paid claims survive restart; source export writes zero rows; old alarm retires; collector RPC writes remain blocked');
} finally {await stop();rmSync(scratch,{recursive:true,force:true});}
