// Real local workerd SQL/RPC, alarm and restart persistence. No remote bindings or source calls.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const scratch=mkdtempSync(join(tmpdir(),'sattva-summary-runtime-'));
const finder=createServer();await new Promise(done=>finder.listen(0,'127.0.0.1',done));
const port=finder.address().port;await new Promise(done=>finder.close(done));
const origin=`http://127.0.0.1:${port}`,config=join(scratch,'wrangler.json');
const entry=`import { CaptureRegistry as ActualRegistry } from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
export class SummaryTest extends ActualRegistry {
 constructor(ctx,env) { super(ctx,env); this.summaries.now=()=>Date.parse('2026-09-10T06:00:00Z'); }
 async timerWake(at, catalogue) {
  const posts=[];
  this.summarySchedule.now=()=>at;
  this.summarySchedule.fetcher=async(url,options)=>{
   const parsed=new URL(url), workflow=parsed.pathname.split('/workflows/')[1]?.split('/')[0];
   if(parsed.origin!=='https://api.github.com'||!['screener-concalls-refresh.yml','screener-summaries-refresh.yml'].includes(workflow)) throw Error('Unexpected test endpoint');
   if(options.method==='POST') {posts.push(workflow);return new Response(null,{status:204});}
   return Response.json({workflow_runs:catalogue&&workflow==='screener-concalls-refresh.yml'&&!parsed.searchParams.has('status')?[catalogue]:[]});
  };
  await this.summarySchedule.wake();
  return {posts,status:await this.summarySchedule.status()};
 }
}
export default {async fetch(request,env) { const input=await request.json(),store=env.SUMMARIES.getByName('local-private-account');
if(input.action==='timer-wake') return Response.json(await store.timerWake(input.at,input.catalogue));
if(input.action==='sync') {
 const {targets,...manifest}=input.inventory,syncId=crypto.randomUUID();
 await store.summaryBeginInventory('1:1',syncId,{...manifest,targetCount:targets.length});
 for(let offset=0;offset<targets.length;offset+=250) await store.summaryInventoryBatch('1:1',syncId,offset,targets.slice(offset,offset+250));
 return Response.json(await store.summaryFinishInventory('1:1',syncId)); }
if(input.action==='sync-begin') return Response.json(await store.summaryBeginInventory('1:1',input.syncId,input.manifest));
if(input.action==='sync-batch') return Response.json(await store.summaryInventoryBatch('1:1',input.syncId,input.offset,input.targets));
if(input.action==='sync-finish') return Response.json(await store.summaryFinishInventory('1:1',input.syncId));
if(input.action==='reserve') return Response.json(await store.summaryReserve('1:1',input.requestId));
if(input.action==='complete') return Response.json(await store.summaryComplete('1:1',input));
if(input.action==='read') return Response.json(await store.summaryRead(input.ids));
return Response.json(await store.summaryStatus()); }};`;
writeFileSync(join(scratch,'entry.mjs'),entry);
writeFileSync(config,JSON.stringify({name:'summary-local-test',main:join(scratch,'entry.mjs'),compatibility_date:'2026-05-23',
  vars:{SCREENER_SUMMARIES_ENABLED:'true',GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main',GH_DISPATCH_TOKEN:'fixture'},durable_objects:{bindings:[{name:'SUMMARIES',class_name:'SummaryTest'}]},migrations:[{tag:'v1',new_sqlite_classes:['SummaryTest']}]}));
let child,logs='';
async function call(input={}) {const response=await fetch(origin,{method:'POST',body:JSON.stringify(input),signal:AbortSignal.timeout(5000)});assert(response.ok,await response.clone().text());return response.json();}
async function start() {
  child=spawn('npx',['--yes','wrangler@4','dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(scratch,'state')],
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
  await start();assert.equal((await call()).schedule.alarmAt,null,'a read cannot arm collection');
  await call({action:'sync',inventory});assert((await call()).schedule.alarmAt>Date.now(),'authorised discovery arms the independent timer');
  const [a,b]=await Promise.all([call({action:'reserve',requestId:crypto.randomUUID()}),call({action:'reserve',requestId:crypto.randomUUID()})]);
  const claim=[a,b].find(x=>x.reserved);assert(claim);assert.equal([a,b].filter(x=>x.reserved).length,1,'real concurrent RPCs grant one lease');
  await call({action:'complete',...claim,outcome:'ready',body});
  await stop();await start();
  const status=await call();assert.equal(status.ready,1);assert.equal(status.automatedRequestsLast24h,1);assert(status.schedule.alarmAt>Date.now());
  assert.deepEqual((await call({action:'read',ids:['123']}))[0].body,body);
  assert.equal((await call({action:'complete',...claim,outcome:'ready',body})).duplicate,true);
  const syncId=crypto.randomUUID(),{targets,...manifest}=inventory;
  await call({action:'sync-begin',syncId,manifest:{...manifest,targetCount:1}});
  await call({action:'sync-batch',syncId,offset:0,targets:[{...target,id:'124',url:'https://www.screener.in/concalls/summary/124/'}]});
  await stop();await start();
  assert.equal((await call()).discoveryStatus,'checking');
  assert.equal((await call({action:'read',ids:['123']}))[0].status,'ready');
  assert.equal((await call({action:'sync-finish',syncId})).pending,1);
  assert.equal((await call({action:'sync-finish',syncId})).pending,1);
  assert.equal((await call({action:'read',ids:['123']}))[0].status,'ready');
  const timerAt=Date.now()+3600000;
  const first=await call({action:'timer-wake',at:timerAt});
  assert.deepEqual(first.posts,['screener-concalls-refresh.yml']);
  assert.equal(first.status.alarmAt,timerAt+120000);
  await stop();await start();
  const retained=await call();
  assert.equal(retained.schedule.dependency,'catalogue');
  assert.equal(retained.schedule.alarmAt,timerAt+120000);
  const next=await call({action:'timer-wake',at:timerAt+120000,catalogue:{id:1,status:'completed',conclusion:'success',created_at:new Date(timerAt).toISOString()}});
  assert.deepEqual(next.posts,['screener-summaries-refresh.yml']);
  assert.equal((await call()).automatedRequestsLast24h,1,'timer dispatch cannot spend a source reservation');
  console.log('PASS local workerd: private summary SQL/RPC, concurrent lease, budget/body/alarm restart persistence, catalogue recovery after restart and idempotent completion');
} finally {await stop();rmSync(scratch,{recursive:true,force:true});}
