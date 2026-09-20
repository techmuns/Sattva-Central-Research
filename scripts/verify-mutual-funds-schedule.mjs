import assert from 'node:assert/strict';
import {MutualFundsSchedule,MF_TIMER} from '../worker/mutual-funds-schedule.mjs';
const epoch=Date.parse('2026-09-20T20:00:00Z');
function fixture({source=[],consumer=[],denySource=false,loseSourcePost=false}={}) {
  let clock=epoch,alarm=null;const data=new Map(),posts=[];
  const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;}};storage.transaction=async fn=>fn(storage);
  const fetcher=async(url,opt={})=>{
    const upstream=url.includes('/AmfiBeas/');
    assert.match(url,/^https:\/\/api.github.com\/repos\/techmuns\/(AmfiBeas|Sattva-Central-Research)\/actions\/workflows\//);
    assert.equal(opt.headers.authorization,upstream?'Bearer upstream-fixture':'Bearer consumer-fixture');
    if(upstream&&denySource)return new Response('',{status:403});
    if(opt.method==='POST'){
      assert(alarm>clock,'A fallback alarm must exist before any dispatch');
      posts.push({upstream,body:JSON.parse(opt.body)});
      if(upstream&&loseSourcePost)throw Error('Response lost');
      return new Response(null,{status:204});
    }
    const runs=upstream?source:consumer;
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
for(const source of [undefined,{lastAttemptAt:epoch,reason:'recent-failure'}]) {
  const env={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async()=>({meta:{health:{state:'current'}}}),mfScheduleStatus:async()=>({source})})}};
  assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds/health'),env)).status,503);
}

f=fixture({source:[{...run(9,50,'in_progress'),display_title:'AMC holdings · scheme-benchmarks'},run(8,20)],consumer:[run(2,2)]});
await f.make().wake();assert.equal((await f.make().status()).source.reason,'run-overdue');assert.equal((await f.make().status()).source.run.id,9);
assert.equal(f.posts.filter(p=>p.upstream).length,0,'An older blocking run remains overdue when found by the final dispatch guard');
