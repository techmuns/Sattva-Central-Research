import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {BreakoutStore, mergePrimary} from '../worker/breakout-store.mjs';
import {BreakoutPrimary, minuteQuotes, primaryInstruments, primaryInventory, cashInstruments} from '../worker/breakout-primary.mjs';
import {handleBreakouts} from '../worker/breakouts.mjs';
import {liveCoverage} from '../public/js/data/breakout-live-shared.js';
const AT=Date.parse('2026-09-15T06:30:00Z');
const iso=at=>new Date(at).toISOString();
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'};
const row=(ticker='TEST',at=AT,extra={})=>({ticker,name:ticker,price:108,volume:2300,prevClose:100,quoteAt:iso(at),checkedAt:iso(at),sessionDate:'2026-09-15',provider:'Upstox',exchange:'NSE',kind:'quote',base,...extra});
const fallback=(rows=[row('TEST',AT,{provider:'Yahoo Finance',price:101})])=>({version:1,runId:'1:1',state:'complete',targets:rows.map(r=>r.ticker),rows,failures:[],discoveryFailed:false,completedAt:iso(AT)});
const primary=(rows=[row()],extra={})=>({at:AT,completedAt:AT,targets:rows.map(r=>r.ticker),rows,failures:[],discoveryFailed:false,...extra});
function storage(){
 const db=new DatabaseSync(':memory:'),kv=new Map();let alarm=null;
 const value={sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args);return{toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},
  transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},
  get:async k=>structuredClone(kv.get(k)),put:async(k,v)=>kv.set(k,structuredClone(v)),getAlarm:async()=>alarm,setAlarm:async v=>{alarm=v;}};
 value.transaction=async fn=>fn(value);return value;
}
const instruments=[{segment:'NSE_EQ',instrument_key:'NSE_EQ|INE000000001',trading_symbol:'TEST'}];
test('Upstox is preferred; failed/overdue primary uses fresh fallback and never removes saved prices',()=>{
 const f=fallback(),p=primary();
 assert.equal(mergePrimary(f,p,AT).rows[0].price,108);
 p.failures=[{ticker:'TEST',reason:'authentication'}];
 assert.equal(mergePrimary(f,p,AT).rows[0].price,101);
 p.failures=[];
 assert.equal(mergePrimary(f,p,AT+121000).rows[0].price,101);
 f.failures=[{ticker:'TEST',reason:'unavailable'}];
 const stale=mergePrimary(f,p,AT+21*60000);assert.equal(stale.rows.length,1);assert.equal(stale.failures.length,1);
 const success=mergePrimary(f,p,AT);assert.equal(success.failures.length,0);assert.equal(success.primary.primaryUsed,1);
 const noBase=primary([row('TEST',AT,{base:null})]);
 assert.deepEqual(mergePrimary(fallback(),noBase,AT).rows[0].base,base);
 const oldDay=fallback([row('TEST',AT-86400000,{sessionDate:'2026-09-14'})]);
 assert.equal(mergePrimary(oldDay,noBase,AT).rows[0].base,null);
});
test('minute snapshots preserve all history across failure, fallback overlap, restart and paging',()=>{
 const data=storage();let now=AT;let store=new BreakoutStore(data,{now:()=>now});
 store.begin('1:1',['TEST']);store.checkpoint('1:1',[row('TEST',AT,{provider:'Yahoo Finance',price:101})]);store.finish('1:1');
 for(let i=0;i<110;i++){now=AT+i*60000;store.primarySave(primary([row('TEST',now,{price:108+i})],{at:now,completedAt:now}));}
 store=new BreakoutStore(data,{now:()=>now});assert.equal(store.read().rows[0].price,217);
 assert.equal(store.readFallback().rows[0].price,101);
 const page=store.history('TEST'),rest=store.history('TEST',page.nextCursor);
 assert.equal(page.rows.length,100);assert.equal(rest.rows.length,11);assert.equal(page.rows[0].price,217);assert.equal(store.history('UNKNOWN').rows.length,0);
 now+=60000;store.primarySave(primary([],{at:now,completedAt:now,targets:['TEST'],failures:[{ticker:'TEST',reason:'unavailable'}]}));
 assert.equal(store.read().rows[0].price,217);assert.equal(store.read().failures.length,1);
 assert.equal(store.history('TEST').rows.length,100);
 assert.throws(()=>store.primarySave(primary([],{at:now+1,completedAt:now+1,targets:['MISSING']})),/Incomplete/);
 // A delayed fallback checkpoint must not overwrite the primary snapshot/history.
 store.begin('2:1',['TEST']);store.checkpoint('2:1',[row('TEST',now,{provider:'Yahoo Finance',price:103})]);store.finish('2:1');
 assert.equal(store.read().rows[0].price,103);assert.equal(store.read().primary.fallbackUsed,1);
});
test('one-minute timer persists before I/O, coalesces duplicate wakes and keeps fallback alarm separate',async()=>{
 const data=storage();let now=AT,fetches=0;const published=[];
 const make=()=>new BreakoutPrimary(data,{UPSTOX_ACCESS_TOKEN:'fixture'},{now:()=>now,
  instruments:async()=>instruments,quotes:async(mapped,bases)=>{fetches++;assert.equal(mapped[0].ticker,'TEST');assert.deepEqual(bases.get('TEST'),base);assert.equal(await data.getAlarm(),now+60000);return {rows:[row('TEST',now)]};},
  store:()=>({breakoutReadFallback:async()=>fallback(),breakoutPrimarySave:async p=>published.push(p)})});
 await make().inventory([{ticker:'TEST'}]);
 for(let i=0;i<4;i++){now=await data.getAlarm();await make().wake();await make().wake();}
 assert.equal(fetches,4);assert.equal(published.length,4);assert.equal(published[3].at-published[0].at,180000);
 assert.equal((await make().status()).reason,'ok');
});
test('missing token, closed market, failed quote and an interrupted save all retain a future alarm',async()=>{
 for(const mode of ['missing','closed','failure','save']){
  const data=storage();let now=mode==='closed'?Date.parse('2026-09-20T06:30Z'):AT,called=0;
  const schedule=new BreakoutPrimary(data,mode==='missing'?{}:{UPSTOX_ACCESS_TOKEN:'fixture'},{now:()=>now,
   instruments:async()=>instruments,quotes:async()=>{called++;if(mode==='failure')throw Error('network');return{rows:[row('TEST',now)]};},
   store:()=>({breakoutReadFallback:async()=>fallback(),breakoutPrimarySave:async()=>{throw Error('storage');}})});
  await schedule.inventory([{ticker:'TEST'}]);now=await data.getAlarm();await schedule.wake();
  assert.equal(await data.getAlarm(),now+60000);assert.equal(called,['missing','closed'].includes(mode)?0:1);
  assert.equal((await schedule.status()).reason,mode==='missing'?'not-configured':mode==='closed'?'closed':'unavailable');
 }
});
test('daily instrument cache supports verified renames and retries list failures without guessing identities',async()=>{
 const data=storage();let now=AT,calls=0,fail=false;
 const schedule=new BreakoutPrimary(data,{}, {now:()=>now,instruments:async()=>{calls++;if(fail)throw Error('unavailable');return instruments;}});
 const targets=[{ticker:'OLD',isin:'INE000000001'}];
 assert.equal((await schedule.mappings(targets)).mapped[0].upstoxSymbol,'TEST');
 await schedule.mappings(targets);assert.equal(calls,1);
 now+=86400000;fail=true;const result=await schedule.mappings(targets);
 assert.equal(result.mapped.length,1);assert.deepEqual(result.failed,['NSE']);
 now+=15*60000;await schedule.mappings(targets);assert.equal(calls,3);
 assert.throws(()=>primaryInventory([{ticker:'TEST',isin:'bad'}]));
 assert.throws(()=>primaryInventory([{ticker:'TEST',yahooTicker:'https://attacker/'}]));
});
test('500 instrument batches preserve earlier quotes when auth fails, and credentials never follow redirects',async()=>{
 const targets=Array.from({length:501},(_,i)=>({ticker:`T${i}`,instrumentKey:`NSE_EQ|${i}`,upstoxSymbol:`T${i}`}));let calls=0;
 const result=await minuteQuotes(targets,new Map(),'secret-fixture',{now:()=>AT,fetcher:async(url,opts)=>{
  calls++;assert.equal(new URL(url).hostname,'api.upstox.com');assert.equal(opts.redirect,'manual');assert.equal(opts.headers.authorization,'Bearer secret-fixture');
  if(calls===2)return new Response(null,{status:401});
  return Response.json({status:'success',data:Object.fromEntries(targets.slice(0,500).map(t=>[t.ticker,{instrument_token:t.instrumentKey,symbol:t.upstoxSymbol,last_price:108,volume:2300,net_change:8,last_trade_time:AT}]))});
 }});
 assert.equal(calls,2);assert.equal(result.rows.length,500);assert.equal(result.reason,'authentication');
 const redirected=await minuteQuotes(targets.slice(0,1),new Map(),'secret-fixture',{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://attacker/'}})});
 assert.equal(redirected.reason,'unavailable');assert.equal(redirected.rows.length,0);
 const decoded=await primaryInstruments('NSE',async()=>new Response(gzipSync(JSON.stringify(instruments))));
 assert.deepEqual(JSON.parse(JSON.stringify(decoded)),instruments);
});
test('public reads expose primary readiness but cannot activate collection or accept a token',async()=>{
 let writes=0;
 const env={CAPTURE_REGISTRY:{getByName:()=>({breakoutRead:async()=>fallback(),breakoutScheduleStatus:async()=>({started:true}),upstoxStatus:async()=>({started:true,configured:true}),upstoxArm:async()=>writes++,upstoxInventory:async()=>writes++})}};
 const response=await handleBreakouts(new Request('https://site/api/breakouts'),env,{now:()=>AT,edgeCache:null});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'public, max-age=5');assert.equal((await response.json()).primarySchedule.configured,true);
 assert.equal((await handleBreakouts(new Request('https://site/api/breakouts',{method:'POST',body:'token'}),env)).status,405);assert.equal(writes,0);
});
test('instrument streaming handles split escapes/nesting, excludes derivatives and rejects truncated arrays',async()=>{
 const raw=JSON.stringify([{...instruments[0],name:'A "quote" and \\ path',nested:[{a:1}]},{segment:'NSE_FO',trading_symbol:'OTHER'},...instruments]);
 const stream=text=>new ReadableStream({start(c){for(let i=0;i<text.length;i+=3)c.enqueue(new TextEncoder().encode(text.slice(i,i+3)));c.close();}});
 assert.equal((await cashInstruments(stream(raw),'NSE')).length,2);
 await assert.rejects(cashInstruments(stream(raw.slice(0,-1)),'NSE'),/Incomplete/);
 await assert.rejects(cashInstruments(stream('[{},]'),'NSE'),/Invalid/);
});
test('late source responses cannot replace newer saved primary prices; missed minutes remain counted',()=>{
 const data=storage();let now=AT;const store=new BreakoutStore(data,{now:()=>now});
 store.primarySave(primary());now+=5*60000;
 store.primarySave(primary([row('TEST',AT-60000,{price:99,checkedAt:iso(now)})],{at:now,completedAt:now}));
 const capture=store.read();assert.equal(capture.rows[0].price,108);assert.equal(capture.failures[0].reason,'stale');
 assert.equal(capture.primary.gaps[0].missedMinutes,4);assert.equal(store.history('TEST').rows.length,2);
});
test('usable fallback cannot hide primary authentication, list, timer or storage failures',async()=>{
 const ready={started:true,configured:true,reason:'ok',overdue:false};
 const good=mergePrimary(fallback(),primary(),AT);
 assert.equal(liveCoverage({...good,primarySchedule:ready},['TEST'],AT).partial,false);
 for(const mode of ['authentication','rate-limited','unavailable','instruments','overdue','missing-token','missing-capture','storage']) {
  let capture=good, schedule={...ready};
  if(['authentication','rate-limited','unavailable'].includes(mode)) capture=mergePrimary(fallback(),primary([],{targets:['TEST'],failures:[{ticker:'TEST',reason:mode}]}),AT);
  if(mode==='instruments') capture=mergePrimary(fallback(),primary(undefined,{instrumentFailures:['NSE']}),AT);
  if(mode==='overdue') schedule.overdue=true;
  if(mode==='missing-token') schedule={...schedule,configured:false,reason:'not-configured'};
  if(mode==='missing-capture') capture=fallback();
  const env={CAPTURE_REGISTRY:{getByName:()=>({breakoutRead:async()=>capture,breakoutScheduleStatus:async()=>({started:true,overdue:false}),upstoxStatus:async()=>{if(mode==='storage')throw Error('unavailable');return schedule;}})}};
  const read=await handleBreakouts(new Request('https://site/api/breakouts'),env,{now:()=>AT,edgeCache:null});
  assert.equal(read.status,200,mode);const payload=await read.json();
  assert.equal(payload.rows.length,1,mode);assert.equal(payload.health.primaryPartial,true,mode);
  const health=await handleBreakouts(new Request('https://site/api/breakouts/health'),env,{now:()=>AT,edgeCache:null});
  assert.equal(health.status,503,mode);
 }
 assert.equal(liveCoverage({...good,primarySchedule:ready},['TEST'],AT+121000).primaryPartial,true);
});
test('per-target failed minute intervals survive successful recovery and object restart',()=>{
 const data=storage();let now=AT;let store=new BreakoutStore(data,{now:()=>now});
 const save=(failures=[])=>store.primarySave(primary(['TEST','OTHER'].filter(t=>!failures.some(f=>f.ticker===t)).map(t=>row(t,now)),{at:now,completedAt:now,targets:['TEST','OTHER'],failures}));
 save();
 now+=60000;save([{ticker:'TEST',reason:'authentication'}]);
 now+=60000;save([{ticker:'TEST',reason:'authentication'}]);
 now+=60000;save([{ticker:'OTHER',reason:'unmapped'}]);
 now+=60000;save();
 now+=60000;save([{ticker:'OTHER',reason:'unmapped'}]);
 now+=60000;save();
 store=new BreakoutStore(data,{now:()=>now});
 const capture=store.read(),gap=capture.primary.gaps.find(g=>g.kind==='missing-quotes');
 assert.equal(capture.failures.length,0);assert.equal(capture.primary.failures.length,0);
 assert.equal(gap.intervals,3);assert.equal(gap.missingMinuteQuotes,4);
 const intervals=data.sql.exec('SELECT * FROM breakout_primary_quote_gaps ORDER BY since').toArray();
 assert.equal(intervals[0].since,AT+60000);assert.equal(intervals[0].until,AT+3*60000);assert.equal(intervals[0].missing,2);
 assert.deepEqual(JSON.parse(intervals[0].failures),[{ticker:'TEST',reason:'authentication'}]);
 assert.equal(intervals[2].since,AT+5*60000);assert.equal(store.history('TEST').rows.length,5);
});
test('minute archive start stays distinct from earlier fallback history after restart',()=>{
 const data=storage();let now=AT;let store=new BreakoutStore(data,{now:()=>now});
 store.begin('1:1',['TEST']);store.checkpoint('1:1',[row('TEST')]);store.finish('1:1');
 now+=10*60000;store.primarySave(primary([row('TEST',now)],{at:now,completedAt:now}));
 now+=60000;store.primarySave(primary([row('TEST',now)],{at:now,completedAt:now}));
 store=new BreakoutStore(data,{now:()=>now});
 assert.equal(store.read().captureStartedAt,iso(AT));
 assert.equal(store.read().primary.captureStartedAt,iso(AT+10*60000));
});
