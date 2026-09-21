import assert from 'node:assert/strict';
import {MutualFundsSchedule,MF_TIMER} from '../worker/mutual-funds-schedule.mjs';
const epoch=Date.parse('2026-09-20T20:00:00Z');
function fixture({source=[],consumer=[],scanner=[run(9000,0)],denySource=false,denyScanner=false,loseSourcePost=false,loseConsumerPost=false,loseScannerPost=false}={}) {
  let clock=epoch,alarm=null;const data=new Map(),posts=[];
  const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;}};storage.transaction=async fn=>fn(storage);
  const fetcher=async(url,opt={})=>{
    const upstream=url.includes('/AmfiBeas/'),isScanner=url.includes('/mutual-funds-scanner.yml/');
    assert.match(url,/^https:\/\/api.github.com\/repos\/techmuns\/(AmfiBeas|Sattva-Central-Research)\/actions\/workflows\//);
    assert.equal(opt.headers.authorization,upstream?'Bearer upstream-fixture':'Bearer consumer-fixture');
    if(upstream&&denySource || isScanner&&denyScanner)return new Response('',{status:403});
    if(opt.method==='POST'){
      assert(alarm>clock,'A fallback alarm must exist before any dispatch');
      posts.push({upstream,scanner:isScanner,body:JSON.parse(opt.body)});
      if((upstream&&loseSourcePost)||(!upstream&&!isScanner&&loseConsumerPost)||(isScanner&&loseScannerPost))throw Error('Response lost');
      return new Response(null,{status:204});
    }
    const runs=isScanner?scanner:upstream?source:consumer;
    const active=new URL(url).searchParams.get('status');
    return Response.json({total_count:runs.length,workflow_runs:active?runs.filter(r=>r.status===active):runs});
  };
  const make=()=>new MutualFundsSchedule(storage,{GH_REPO:'techmuns/Sattva-Central-Research',GH_DISPATCH_TOKEN:'consumer-fixture',GH_AMFI_DISPATCH_TOKEN:'upstream-fixture'},{now:()=>clock,fetcher});
  return{make,posts,data,advance(ms){clock+=ms;},get alarm(){return alarm;}};
}
const run=(id,minutes,status='completed',conclusion='success')=>({id,event:'workflow_dispatch',display_title:'AMC holdings · monthly',status,conclusion,created_at:new Date(epoch-minutes*60000).toISOString(),html_url:'https://github.com/techmuns/AmfiBeas/actions/runs/'+id});
let f=fixture();await f.make().arm();f.advance(1000);await f.make().wake();assert.deepEqual(f.posts.map(p=>p.upstream),[true,false]);assert.deepEqual(f.posts[0].body.inputs,{mode:'monthly',commit:'true'});
await f.make().wake();assert.equal(f.posts.length,2,'Duplicate alarm delivery is claimed once');
f.advance(60000);await f.make().wake();assert.equal(f.posts.length,2,'Eviction and delayed run-list visibility cannot immediately repeat dispatch');
f=fixture({source:[run(1,1,'in_progress')],consumer:[run(2,2)]});await f.make().wake();assert.equal(f.posts.length,0);assert.equal((await f.make().status()).source.reason,'running');
f=fixture({source:[run(10,3)],consumer:[run(2,2)]});await f.make().wake();assert.deepEqual(f.posts.map(p=>p.upstream),[false],'New source completion imports immediately');assert.equal(f.data.get(MF_TIMER).importSourceRun,10);
f.advance(60000);await f.make().wake();assert.equal(f.posts.length,1);
f=fixture({source:[run(1,5)],consumer:[run(2,20)],denySource:true});await f.make().wake();assert.equal(f.posts.length,1,'Source permissions never stop retained-data import');assert.equal((await f.make().status()).source.reason,'access-unavailable');assert(f.alarm>epoch);
f=fixture({loseSourcePost:true});await f.make().wake();assert.equal(f.posts.filter(p=>p.upstream).length,1);f.advance(60000);await f.make().wake();assert.equal(f.posts.filter(p=>p.upstream).length,1,'Uncertain POST is not blindly retried');
f=fixture({source:[run(1,50,'in_progress')]});await f.make().wake();assert.equal((await f.make().status()).source.reason,'run-overdue');assert.equal(f.posts.filter(p=>p.upstream).length,0);
f=fixture({source:[{...run(9,1),display_title:'AMC holdings · scheme-benchmarks'},run(8,20)],consumer:[run(2,2)]});await f.make().wake();assert.equal(f.posts.filter(p=>p.upstream).length,1,'Benchmark refresh cannot establish holdings freshness');
console.log('PASS durable upstream cadence, independent importer, completion wake, credential isolation, uncertainty, overdue health and eviction');

// A retained complete snapshot cannot hide a failed or never-checked source timer.
const {handleMutualFunds}=await import('../worker/mutual-funds.mjs');
for(const conclusion of ['failure','cancelled','timed_out']) {
  f=fixture({source:[run(1,3,'completed',conclusion)],consumer:[run(2,2)]});await f.make().wake();
  assert.equal((await f.make().status()).source.reason,'recent-failure');
}
for(const source of [undefined,...['recent-failure','dispatched','running','awaiting-run','access-unavailable','dispatch-unavailable','run-overdue'].map(reason=>({lastAttemptAt:epoch,reason}))]) {
  const env={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async()=>({meta:{health:{state:'current'}}}),mfScannerStatus:async()=>({}),mfScheduleStatus:async()=>({reason:'recent-run',source})})}};
  assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds/health'),env)).status,503);
}

f=fixture({source:[{...run(9,50,'in_progress'),display_title:'AMC holdings · scheme-benchmarks'},run(8,20)],consumer:[run(2,2)]});
await f.make().wake();assert.equal((await f.make().status()).source.reason,'run-overdue');assert.equal((await f.make().status()).source.run.id,9);
assert.equal(f.posts.filter(p=>p.upstream).length,0,'An older blocking run remains overdue when found by the final dispatch guard');

const consumer=[];
f=fixture({source:[run(10,3)],consumer,loseConsumerPost:true});await f.make().wake();
assert.equal(f.data.get(MF_TIMER).importPendingSourceRun,10);
assert.equal(f.posts.length,1);
consumer.unshift(run(20,-0.5)); // accepted POST finishes during the uncertainty interval
f.advance(90000);await f.make().wake();
assert.equal(f.posts.length,1,'A completed accepted importer is reconciled after its POST response was lost');
assert.equal(f.data.get(MF_TIMER).importSourceRun,10);
assert.equal(f.data.get(MF_TIMER).importPendingSourceRun,null);

const prior=run(20,0);
f=fixture({source:[run(10,3)],consumer:[prior],loseConsumerPost:true});await f.make().wake();
f.advance(90000);await f.make().wake();
assert.equal(f.posts.length,2,'A run already known before dispatch cannot reconcile a lost POST');
const healthyEnv={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async()=>({meta:{health:{state:'current'}}}),mfScannerStatus:async()=>({}),mfScheduleStatus:async()=>({reason:'recent-run',source:{lastAttemptAt:epoch,reason:'recent-run'}})})}};
assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds/health'),healthyEnv)).status,200);
console.log('PASS unfinished source health, accepted importer reconciliation and pre-dispatch run exclusion');

const changingSource=[run(10,3)],changingConsumer=[];
f=fixture({source:changingSource,consumer:changingConsumer,loseConsumerPost:true});await f.make().wake();
changingConsumer.unshift(run(20,-0.5));changingSource.unshift(run(11,-1));
f.advance(90000);await f.make().wake();
assert.equal(f.posts.length,2,'A newly completed source still imports after the older claim reconciles');
assert.equal(f.data.get(MF_TIMER).importSourceRun,10);
assert.equal(f.data.get(MF_TIMER).importPendingSourceRun,11,'Reconciling the old claim cannot clear the newer uncertain claim');
changingConsumer.unshift(run(21,-2));f.advance(90000);await f.make().wake();
assert.equal(f.posts.length,2);
assert.equal(f.data.get(MF_TIMER).importSourceRun,11);


for(const reason of [undefined,'dispatched','running','awaiting-run','recent-failure','dispatch-unavailable','run-overdue']) {
  const env={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async()=>({meta:{health:{state:'current'}}}),mfScannerStatus:async()=>({}),mfScheduleStatus:async()=>({reason,source:{lastAttemptAt:epoch,reason:'recent-run'}})})}};
  assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds/health'),env)).status,503,'A fresh source cannot hide an unfinished or failed import');
}
const justCompleted=run(40,40);justCompleted.updated_at=new Date(epoch-60000).toISOString();
f=fixture({source:[justCompleted],consumer:[run(2,2)]});await f.make().wake();
assert.equal((await f.make().status()).source.reason,'recent-run');
assert.equal(f.posts.filter(p=>p.upstream).length,0,'A long source run is due fifteen minutes after completion');
assert.equal(f.alarm,epoch+60000,'A dispatched importer is polled promptly until completion');
f=fixture({source:[run(10,3)],consumer:[justCompleted]});f.data.set(MF_TIMER,{importSourceRun:10});await f.make().wake();
assert.equal((await f.make().status()).reason,'recent-run');
assert.equal(f.posts.length,0,'A long successful import is not immediately repeated');

const uncertainSource=[];
f=fixture({source:uncertainSource,consumer:[run(2,2)],loseSourcePost:true});await f.make().wake();
assert.equal(f.alarm,epoch+60000,'An uncertain source POST is reconciled in one minute');
uncertainSource.unshift(run(50,-0.5));f.advance(60000);await f.make().wake();
assert.deepEqual(f.posts.map(p=>p.upstream),[true,false],'A quickly completed source imports without waiting another collection interval');
console.log('PASS end-to-end health, completed-run cadence and prompt source/import reconciliation');

// Backup capture is independent of a running or failed primary importer.
f=fixture({source:[run(1,20,'in_progress')],consumer:[run(2,20,'in_progress')],scanner:[],loseScannerPost:true});await f.make().wake();
assert.equal(f.posts.filter(p=>p.scanner).length,1);assert.equal(f.posts.filter(p=>!p.scanner).length,0);
f.advance(60000);await f.make().wake();assert.equal(f.posts.filter(p=>p.scanner).length,1,'Lost backup dispatch acknowledgement is not blindly retried');
f=fixture({scanner:[],denyScanner:true});await f.make().wake();assert.equal((await f.make().status()).scanner.reason,'access-unavailable');assert.equal(f.posts.length,2,'Backup permissions cannot stop primary collection');
console.log('PASS independent MF Scanner workflow cadence, source/import isolation and persisted dispatch uncertainty');
