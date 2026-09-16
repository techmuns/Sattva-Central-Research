import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { BreakoutStore } from '../worker/breakout-store.mjs';
import { BreakoutSchedule } from '../worker/breakout-schedule.mjs';
import { breakoutCollectorIdentity } from '../worker/breakout-auth.mjs';
import { handleBreakouts, handleTechnicals } from '../worker/breakouts.mjs';
import { BREAKOUT_ENDPOINT, marketWindow, expectedSession, quoteFresh, preferQuote, liveBreakout, liveCoverage, validateQuote, recoverySlots } from '../public/js/data/breakout-live-shared.js';
import { collectBreakouts, breakoutClient, captureTarget, bootstrapBreakouts, closingSeedComplete } from './collect-breakouts.mjs';
import { baseFromBars, yahooSymbol, parseYahooQuote, mapUpstoxTargets, upstoxQuotes, recoveryCandles } from './lib/breakout-providers.mjs';
const AT = Date.parse('2026-09-15T06:30:00Z'), iso = at => new Date(at).toISOString();
const historyDates = count => {const dates=[];for(let at=AT-86400000;dates.length<count;at-=86400000)if(marketWindow(at).collect)dates.unshift(iso(at).slice(0,10));return dates;};
const base = {high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'};
const quote = (ticker='TEST', at=AT, extra={}) => validateQuote({ticker,price:105,volume:2000,prevClose:98,quoteAt:iso(at),checkedAt:iso(at),sessionDate:'2026-09-15',provider:'Yahoo Finance',base,...extra},at);
function storage() {
 const db=new DatabaseSync(':memory:'),kv=new Map();let alarm=null;
 const out={sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args);return {toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},
 transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
 get:async key=>kv.get(key),put:async(key,value)=>kv.set(key,structuredClone(value)),getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;}};
 out.transaction=async fn=>fn(out);return out;
}
function harness(now=()=>AT) { const data=storage(),store=new BreakoutStore(data,{now});return {data,store,client:async({action,...body})=>action==='begin'?store.begin('1:1',body.targets,body.discoveryFailed):action==='checkpoint'?store.checkpoint('1:1',body.rows,body.failures):action==='recovery'?store.recovery('1:1',body.ticker,body.from,body.to,body.rows):store.finish('1:1')}; }
test('freshness uses source session/time, holidays, closing observations and missing bases',()=>{
 assert.equal(marketWindow(Date.parse('2026-09-14T06:30Z')).collect,false);
 assert.equal(expectedSession(Date.parse('2026-09-15T03:30Z')),'2026-09-11');
 assert(quoteFresh(quote(),AT));assert(!quoteFresh(quote(),AT+21*60000));
 assert(!quoteFresh(quote(),Date.parse('2026-09-15T12:00Z')));
 assert(quoteFresh(quote('TEST',Date.parse('2026-09-15T10:00Z')),Date.parse('2026-09-16T03:00Z')));
 assert.equal(expectedSession(Date.parse('2026-11-08T13:00Z')),'2026-11-08');
 assert.equal(marketWindow(Date.parse('2027-01-01T06:30Z')).calendarKnown,false);
 assert.equal(liveBreakout(quote()).quality,'strong');assert.equal(liveBreakout(quote('TEST',AT,{price:99})).quality,'no_breakout');
 const capture={state:'complete',rows:[quote()],failures:[]};
 assert.equal(liveCoverage(capture,['TEST','FUTURE'],AT).partial,true);
 assert.equal(liveCoverage({...capture,rows:[quote('TEST',AT,{base:null})]},['TEST'],AT).partial,true);
 assert.equal(liveCoverage({...capture,failures:[{ticker:'TEST'}]},['TEST'],AT).partial,true);
});
test('failed and interrupted batches preserve history; complete requires every target; scope additions remain visible',()=>{
 const {store}=harness();store.begin('1:1',['TEST','NEW']);store.checkpoint('1:1',[quote()]);
 assert.throws(()=>store.finish('1:1'),/incomplete/);assert.equal(store.read().state,'collecting');
 store.checkpoint('1:1',[],[{ticker:'NEW',reason:'unavailable'}]);store.finish('1:1');
 store.checkpoint('1:1',[quote()]);assert.throws(()=>store.checkpoint('1:1',[quote('TEST',AT,{price:106})]),/Conflicting/);
 store.begin('2:1',['TEST','NEW','FUTURE'],true);store.checkpoint('2:1',[],[{ticker:'TEST',reason:'unavailable'}]);
 assert.equal(store.read().rows[0].price,105);assert.equal(store.read().discoveryFailed,true);
 assert.deepEqual(store.read().failures.map(x=>x.ticker).sort(),['FUTURE','NEW','TEST']);
 assert.equal(store.history('TEST').rows.length,1);
});
test('history keyset paging keeps equal-time observations and recovers candles without changing latest price',()=>{
 const {store}=harness();for(let i=1;i<=110;i++){const run=`${i}:1`;store.begin(run,['TEST']);store.checkpoint(run,[quote()]);store.finish(run);}
 const first=store.history('TEST');assert.equal(first.rows.length,100);assert(first.nextCursor);assert.equal(store.history('TEST',first.nextCursor).rows.length,10);
 const from=AT-60*60000,to=AT;store.recovery('110:1','TEST',from,to,[]);
 assert.equal(store.read().recoveryPending.length,1);
 const rows=recoverySlots(from,to).map(at=>quote('TEST',at,{price:101,kind:'recovered-candle'}));
 assert.equal(store.recovery('110:1','TEST',from,to,rows).remaining,0);
 assert.equal(store.read().recoveryPending.length,0);assert.equal(store.read().rows[0].price,105);
 const page=store.history('TEST'); const rest=store.history('TEST',page.nextCursor); assert(rest.rows.some(row=>row.kind==='recovered-candle')); assert.equal(page.rows.length+rest.rows.length,114);
});
test('collector covers more than 60 stocks, stops on rate limits and saves successes before a failure',async()=>{
 const {store,client}=harness(),targets=Array.from({length:81},(_,i)=>({ticker:`T${i}`}));let requests=0;
 const summary=await collectBreakouts({targets,client,now:()=>AT,sleep:async()=>{},primary:async target=>{requests++;if(target.ticker==='T70')throw Error('rate-limited');return quote(target.ticker);}});
 assert(requests>=70&&requests<81);assert(summary.failures>0);assert.equal(store.read().targets.length,81);assert.equal(store.read().state,'complete');
 const interrupted=harness();let writes=0;
 await assert.rejects(collectBreakouts({targets,now:()=>AT,sleep:async()=>{},primary:async t=>quote(t.ticker),client:async body=>{if(body.action==='checkpoint'&&++writes===2)throw Error('lost connection');return interrupted.client(body);}}));
 assert.equal(interrupted.store.read().rows.length,8);assert.equal(interrupted.store.read().state,'collecting');
});
test('backup fills missing quotes, reports absent base and never calls Muns',async()=>{
 const {store,client}=harness();let used=false;
 const summary=await collectBreakouts({targets:[{ticker:'TEST'}],client,now:()=>AT,sleep:async()=>{},token:'fixture',primary:async()=>{throw Error('unavailable');},backup:async targets=>{used=true;return {rows:targets.map(t=>quote(t.ticker,AT,{provider:'Upstox',base:null})),reason:'instrument-list-unavailable',instrumentFailures:[{exchange:'BSE',reason:'unavailable'}]};}});
 assert.equal(summary.upstox,'instrument-list-unavailable');assert.deepEqual(summary.upstoxInstrumentFailures,[{exchange:'BSE',reason:'unavailable'}]);
 assert(used);assert.equal(summary.saved,1);assert.equal(summary.noBase,1);assert.equal(store.read().rows[0].provider,'Upstox');
 const result=await upstoxQuotes([{ticker:'TEST'}],new Map([['TEST',base]]),{token:'fixture',now:()=>AT,instruments:[{segment:'NSE_EQ',instrument_type:'EQ',instrument_key:'NSE_EQ|INE000000001',trading_symbol:'TEST'}],fetcher:async(url,opts)=>{
 assert.equal(new URL(url).origin,'https://api.upstox.com');assert.equal(opts.headers.authorization,'Bearer fixture');
 return Response.json({status:'success',data:{test:{instrument_token:'NSE_EQ|INE000000001',symbol:'TEST',last_price:105,net_change:7,volume:2500,last_trade_time:String(AT),ohlc:{close:98}}}});}});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].volume,2500);assert.equal(result.rows[0].prevClose,98);
});
test('daily history excludes today; completed recovery candles require a continuous session',()=>{
 const bars=historyDates(31).map(date=>({date,high:100,low:95,close:97,volume:1000}));
 assert.equal(baseFromBars(bars,'2026-09-15').count,30);
 const start=Date.parse('2026-09-15T03:45Z');
 const payload={chart:{result:[{meta:{symbol:'TEST.NS'},timestamp:[start/1000,(start+15*60000)/1000],indicators:{quote:[{close:[104,105],volume:[1000,1100]}]}}]}};
 const rows=recoveryCandles(payload,{ticker:'TEST'},quote(),start,AT);
 assert.equal(rows.length,2);assert.equal(rows[1].volume,2100);assert.equal(rows[0].kind,'recovered-candle');
 payload.chart.result[0].timestamp[0]+=900;assert.equal(recoveryCandles(payload,{ticker:'TEST'},quote(),start,AT).length,0);
 const history={chart:{result:[{meta:{symbol:'TEST.NS',regularMarketTime:AT/1000,regularMarketPrice:105,regularMarketVolume:2000},timestamp:[...bars.map(b=>Date.parse(b.date)/1000),AT/1000],indicators:{quote:[{close:[...bars.map(b=>b.close),105],high:[...bars.map(b=>b.high),106],low:[...bars.map(b=>b.low),96],volume:[...bars.map(b=>b.volume),2000]}]}}]}};
 assert.equal(parseYahooQuote(history,{ticker:'TEST'},AT).base.high,100);
});
test('missed capture recovery is checkpointed, then historical candles are saved separately',async()=>{
 const {store,client}=harness();const prior=quote('TEST',AT-60*60000);
 const summary=await collectBreakouts({targets:[{ticker:'TEST'}],previous:{rows:[prior]},client,now:()=>AT,primary:async()=>quote(),sleep:async()=>{},recovery:async(t,current,from)=>recoverySlots(from,AT).map(at=>quote('TEST',at,{kind:'recovered-candle'}))});
 assert.equal(summary.recovered,4);assert.equal(store.read().gaps[0].reason,'candles-recovered');assert.equal(store.read().rows[0].kind,'quote');
});
test('durable timer arms explicitly, avoids duplicate/inflight jobs and dispatches missed runs',async()=>{
 const data=storage();let at=AT,posts=0,runs=[];
 const schedule=new BreakoutSchedule(data,{GH_DISPATCH_TOKEN:'fixture',GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main'}, {now:()=>at,fetcher:async(url,opts={})=>{
 assert(new URL(url).pathname.includes('breakouts-refresh.yml'));if(opts.method==='POST'){posts++;return new Response(null,{status:204});}return Response.json({workflow_runs:runs});}});
 assert.equal((await schedule.status()).alarmAt,null);await schedule.arm();assert((await schedule.status()).alarmAt>AT);
 await schedule.wake();assert.equal(posts,1);await schedule.wake();assert.equal(posts,1);
 at+=15*60000;runs=[{id:1,status:'in_progress',event:'schedule',created_at:iso(at-60000)}];await schedule.wake();assert.equal(posts,1);assert.equal((await schedule.status()).reason,'running');
 at+=15*60000;runs=[{id:2,status:'completed',conclusion:'success',event:'push',created_at:iso(at-60000)},{id:1,status:'completed',conclusion:'success',event:'schedule',created_at:iso(at-30*60000)}];
 await schedule.wake();assert.equal(posts,2);assert.equal((await schedule.status()).reason,'dispatched');
});
test('daily closing price wins over a stale same-session observation',()=>{
 const daily={cmp:107,price_date:'2026-09-15'},evening=Date.parse('2026-09-15T14:00Z');
 assert.equal(preferQuote(quote(),daily,AT),true);
 assert.equal(preferQuote(quote(),daily,evening),false);
 assert.equal(preferQuote(quote(),{...daily,price_date:'2026-09-11'},evening),true);
 assert.equal(preferQuote(quote(),{cmp:null},evening),true);
 assert.equal(preferQuote(quote('TEST',Date.parse('2026-09-15T10:00Z')),daily,evening),true);
 const friday=Date.parse('2026-09-11T08:30Z'),weekend=Date.parse('2026-09-13T06:30Z');
 const old=quote('TEST',friday,{sessionDate:'2026-09-11',base:null});
 assert.equal(preferQuote(old,{cmp:107,price_date:'2026-09-11'},weekend),false);
});
test('timer restart and GitHub creation delay do not turn 15-minute captures into 30-minute captures',async()=>{
 const data=storage(),dispatches=[];let at=AT,runs=[];
 const makeSchedule=()=>new BreakoutSchedule(data,{GH_DISPATCH_TOKEN:'fixture',GH_REPO:'techmuns/Sattva-Central-Research'}, {now:()=>at,fetcher:async(url,options={})=>{
  if(options.method==='POST'){
   dispatches.push(at);
   runs=[{id:dispatches.length,status:'completed',conclusion:dispatches.length%2?'failure':'success',event:'workflow_dispatch',display_title:'Breakout capture · durable-timer',created_at:iso(at+(dispatches.length%2?4000:2*60000))}];
   return new Response(null,{status:204});
  }
  return Response.json({workflow_runs:runs});
 }});
 await makeSchedule().arm();
 for(let wakes=0;dispatches.length<8 && wakes<20;wakes++){
  at=await data.getAlarm();await makeSchedule().wake();
  const count=dispatches.length;await makeSchedule().wake();assert.equal(dispatches.length,count,'duplicate alarm must not dispatch');
  assert.equal((await makeSchedule().status()).nextAt,await data.getAlarm());
 }
 assert.equal(dispatches.length,8);
 for(let i=1;i<dispatches.length;i++)assert.equal(dispatches[i]-dispatches[i-1],15*60000);
 // An independent scheduled capture should defer only until it is 15 minutes old.
 at=await data.getAlarm();runs=[{id:99,status:'completed',conclusion:'success',event:'schedule',created_at:iso(at-5*60000)}];
 await makeSchedule().wake();assert.equal(dispatches.length,8);assert.equal(await data.getAlarm(),at+10*60000);
 at=await data.getAlarm();await makeSchedule().wake();assert.equal(dispatches.length,9);
 at=await data.getAlarm();runs=[{id:100,status:'completed',conclusion:'success',event:'workflow_dispatch',display_title:'Breakout capture · manual',created_at:iso(at-5*60000)}];
 await makeSchedule().wake();assert.equal(dispatches.length,9);assert.equal(await data.getAlarm(),at+10*60000);
 at=await data.getAlarm();await makeSchedule().wake();assert.equal(dispatches.length,10);
});
test('in-flight captures recheck in one minute without starting duplicates, including a dispatch race',async()=>{
 const data=storage();let at=AT,runs=[],posts=0,race=false,reads=0;
 const schedule=new BreakoutSchedule(data,{GH_DISPATCH_TOKEN:'fixture',GH_REPO:'techmuns/Sattva-Central-Research'}, {now:()=>at,fetcher:async(url,options={})=>{
  if(options.method==='POST'){posts++;runs=[{id:posts,event:'workflow_dispatch',display_title:'Breakout capture · durable-timer',status:'in_progress',created_at:iso(at+4*60000)}];return new Response(null,{status:204});}
  reads++;return Response.json({workflow_runs:race && reads>1 ? [{id:99,event:'schedule',status:'in_progress',created_at:iso(at-60000)}] : runs});
 }});
 await schedule.arm();at=await data.getAlarm();await schedule.wake();const first=at;
 at=await data.getAlarm();await schedule.wake();assert.equal(posts,1);assert.equal(await data.getAlarm(),first+16*60000);
 runs[0].status='completed';runs[0].conclusion='success';at=await data.getAlarm();await schedule.wake();assert.equal(posts,2);assert.equal(at-first,16*60000);
 await schedule.wake();assert.equal(posts,2);
 at=await data.getAlarm();runs[0].status='completed';runs[0].conclusion='success';race=true;reads=0;
 await schedule.wake();assert.equal(posts,2);assert.equal(await data.getAlarm(),at+60000);assert.equal((await schedule.status()).reason,'running');
});
test('closing retries can recover missing history without an Upstox token and retain quotes on failure',async()=>{
 const evening=Date.parse('2026-09-15T14:00Z'),closeAt=Date.parse('2026-09-15T10:00Z');
 for(const failure of [null,'unavailable','rate-limited']){
  const prior=quote('TEST',closeAt,{base:null}),good=quote('GOOD',closeAt),previous={state:'complete',targets:['TEST','GOOD'],rows:[prior,good],failures:[]};
  const {store,client}=harness(()=>evening);let calls=0;
  const summary=await collectBreakouts({targets:[{ticker:'TEST'},{ticker:'GOOD'}],previous,client,now:()=>evening,sleep:async()=>{},
   primary:async target=>{calls++;assert.equal(target.ticker,'TEST');if(failure)throw Error(failure);return quote('TEST',closeAt,{price:110});},
   backup:async()=>assert.fail('no backup token'),
  });
  assert.equal(calls,1);assert.equal(summary.saved,2);assert.equal(summary.failures,0);assert.equal(summary.noBase,failure?1:0);
  const saved=store.read().rows.find(row=>row.ticker==='TEST');assert.equal(saved.price,prior.price);assert.equal(saved.checkedAt,prior.checkedAt);
  assert.equal(closingSeedComplete(store.read(),evening),!failure);
 }
});
test('closing retries fill missing history without refetching saved prices or changing source times',async()=>{
 const evening=Date.parse('2026-09-15T14:00Z'),closeAt=Date.parse('2026-09-15T10:00Z');
 for(const failed of [false,true]){
  const prior=quote('TEST',closeAt,{base:null}),previous={state:'complete',targets:['TEST'],rows:[prior],failures:[]};
  assert.equal(closingSeedComplete(previous,evening),false);
  const {store,client}=harness(()=>evening);let used=0;
  const summary=await collectBreakouts({targets:[{ticker:'TEST'}],previous,client,now:()=>evening,sleep:async()=>{},token:'fixture',
   primary:async()=>{assert.fail('already have the closing price');},backup:async targets=>{
    used++;assert.deepEqual(targets,[{ticker:'TEST'}]);if(failed)throw Error('unavailable');return {rows:[quote('TEST',closeAt,{price:110,provider:'Upstox'})]};
   }});
  assert.equal(used,1);assert.equal(summary.saved,1);assert.equal(summary.noBase,failed?1:0);
  const saved=store.read().rows[0];assert.equal(saved.price,prior.price);assert.equal(saved.volume,prior.volume);assert.equal(saved.checkedAt,prior.checkedAt);assert.equal(saved.quoteAt,prior.quoteAt);
  assert.equal(closingSeedComplete(store.read(),evening),!failed);
 }
});
test('Upstox resolves SME, trusts and BSE codes without mixing exchanges or guessing names',async()=>{
 const instrument=(segment,type,symbol,isin,code)=>({segment,instrument_type:type,trading_symbol:symbol,instrument_key:`${segment}|${isin}`,exchange_token:code});
 const instruments=[
  instrument('NSE_EQ','SM','ALPEXSOLAR','INE0R4701017','22688'),
  instrument('NSE_EQ','RR','BIRET','INE0FDU25010','2203'),
  instrument('NSE_EQ','IV','CUBEINVIT','INE0NR623014','15078'),
  instrument('BSE_EQ','A','NSDL','INE301O01023','544467'),
  instrument('BSE_EQ','IF','BIRET','INE0FDU25010','543261'),
  instrument('NSE_EQ','EQ','DUPLICATE','INE000000001'),
  instrument('NSE_EQ','BE','DUPLICATE','INE000000002'),
  instrument('NSE_FO','FUT','WRONG','INE000000003'),
 ];
 const targets=['ALPEXSOLAR-SM','BIRET','CUBEINVIT','544467','DUPLICATE','WRONG','NSDL','UNKNOWN'].map(ticker=>({ticker}));
 const mapped=mapUpstoxTargets(targets,instruments);
 assert.deepEqual(mapped.map(t=>t.ticker),targets.slice(0,4).map(t=>t.ticker));
 assert.equal(mapped[1].instrumentKey,'NSE_EQ|INE0FDU25010');assert.equal(mapped[3].exchange,'BSE');
 const result=await upstoxQuotes(targets,new Map(mapped.map(t=>[t.ticker,base])),{instruments,token:'fixture',now:()=>AT,fetcher:async url=>{
  const keys=new URL(url).searchParams.get('instrument_key').split(',');assert.deepEqual(keys,mapped.map(t=>t.instrumentKey));
  return Response.json({status:'success',data:Object.fromEntries(mapped.map(t=>[t.instrumentKey,{instrument_token:t.instrumentKey,symbol:t.upstoxSymbol,last_price:105,net_change:7,volume:2000,last_trade_time:String(AT)}]))});
 }});
 assert.equal(result.reason,'unmapped');assert.equal(result.rows.length,4);assert.equal(result.rows[3].exchange,'BSE');assert.equal(result.rows[0].ticker,'ALPEXSOLAR-SM');
 const mismatch=await upstoxQuotes(targets.slice(0,1),new Map(),{instruments,token:'fixture',now:()=>AT,fetcher:async()=>Response.json({status:'success',data:{wrong:{instrument_token:mapped[0].instrumentKey,symbol:'OTHER',last_price:105,volume:2000,last_trade_time:String(AT)}}})});
 assert.equal(mismatch.rows.length,0);
});
test('Upstox isolates exchange-list outages and stops on rejected credentials',async()=>{
 for(const unauthorized of [false,true]){
  const calls=[],instrument={segment:'BSE_EQ',instrument_type:'A',trading_symbol:'NSDL',instrument_key:'BSE_EQ|INE301O01023',exchange_token:'544467'};
  const result=await upstoxQuotes([{ticker:'TEST'},{ticker:'544467'}],new Map([['544467',base]]),{token:'fixture',now:()=>AT,fetcher:async(url,options)=>{
   calls.push(url);
   if(new URL(url).hostname==='assets.upstox.com'){
    assert.equal(options.headers?.authorization,undefined);
    if(url.endsWith('/NSE.json.gz'))return new Response(null,{status:503});
    assert(url.endsWith('/BSE.json.gz'));return new Response(gzipSync(JSON.stringify([instrument])));
   }
   assert.equal(new URL(url).pathname,'/v2/market-quote/quotes');assert.equal(options.headers.authorization,'Bearer fixture');
   if(unauthorized)return new Response(null,{status:401});
   return Response.json({status:'success',data:{nsdl:{instrument_token:instrument.instrument_key,symbol:'NSDL',last_price:105,net_change:7,volume:2000,last_trade_time:String(AT)}}});
  }});
  assert.equal(calls.length,3);assert.equal(result.reason,unauthorized?'authentication':'instrument-list-unavailable');assert.equal(result.rows.length,unauthorized?0:1);
  assert.deepEqual(result.instrumentFailures,[{exchange:'NSE',reason:'unavailable'}]);
 }
});
test('verified portfolio ISINs follow renamed symbols and retain each canonical target',async()=>{
 const isin='INE094B01013',instrumentKey=`NSE_EQ|${isin}`;
 const targets=[captureTarget({ticker:'ASHIKA',isin}),captureTarget({ticker:'ASHIKAG',isin}),captureTarget({ticker:'ASHIKAG',isin:'INE000000001'})];
 const instruments=[{segment:'NSE_EQ',instrument_type:'BE',instrument_key:instrumentKey,trading_symbol:'ASHIKAG'}];
 const result=await upstoxQuotes(targets,new Map([['ASHIKA',base],['ASHIKAG',base]]),{token:'fixture',instruments,now:()=>AT,fetcher:async url=>{
  assert.equal(new URL(url).searchParams.get('instrument_key'),instrumentKey);
  return Response.json({status:'success',data:{ashika:{instrument_token:instrumentKey,symbol:'ASHIKAG',last_price:105,volume:2000,last_trade_time:String(AT)}}});
 }});
 assert.equal(result.reason,'unmapped');assert.deepEqual(result.rows.map(row=>row.ticker),['ASHIKA','ASHIKAG']);
 assert.equal(captureTarget({ticker:'TEST',isin:'invalid'}).isin,undefined);
});
test('a later Upstox quote-batch timeout preserves earlier successful quotes',async()=>{
 const targets=Array.from({length:501},(_,i)=>({ticker:`T${i}`}));
 const instruments=targets.map((t,i)=>({segment:'NSE_EQ',instrument_type:'EQ',instrument_key:`NSE_EQ|INE${String(i).padStart(9,'0')}`,trading_symbol:t.ticker}));
 let calls=0;
 const result=await upstoxQuotes(targets,new Map(targets.map(t=>[t.ticker,base])),{instruments,token:'fixture',now:()=>AT,fetcher:async url=>{
  if(++calls===2)throw Error('timeout');
  const keys=new URL(url).searchParams.get('instrument_key').split(',');assert.equal(keys.length,500);
  return Response.json({status:'success',data:Object.fromEntries(keys.map((key,i)=>[key,{instrument_token:key,symbol:`T${i}`,last_price:105,volume:2000,last_trade_time:String(AT)}]))});
 }});
 assert.equal(calls,2);assert.equal(result.rows.length,500);assert.equal(result.reason,'unavailable');
});
test('partial closing seeds retry missing stocks without refetching successful closing observations',async()=>{
 const evening=Date.parse('2026-09-15T14:00Z'),closeAt=Date.parse('2026-09-15T10:00Z');
 const saved=quote('TEST',closeAt),previous={version:1,state:'collecting',targets:['TEST','NEW'],rows:[saved],failures:[{ticker:'NEW',reason:'unchecked'}]};
 assert.equal(closingSeedComplete(previous,evening),false);
 assert.equal(closingSeedComplete({...previous,state:'complete'},evening),false);
 const data=storage(),store=new BreakoutStore(data,{now:()=>evening});let requests=[];
 const client=async({action,...body})=>action==='begin'?store.begin('1:1',body.targets,body.discoveryFailed):action==='checkpoint'?store.checkpoint('1:1',body.rows,body.failures):action==='finish'?store.finish('1:1'):store.recovery('1:1',body.ticker,body.from,body.to,body.rows);
 await collectBreakouts({targets:[{ticker:'TEST'},{ticker:'NEW'}],previous,client,now:()=>evening,sleep:async()=>{},primary:async target=>{requests.push(target.ticker);return quote(target.ticker,closeAt);}});
 assert.deepEqual(requests,['NEW']);assert(closingSeedComplete(store.read(),evening));
 assert.deepEqual(store.read().rows.find(row=>row.ticker==='TEST'),saved);
 assert.equal(closingSeedComplete({...store.read(),discoveryFailed:true},evening),false);
 assert.equal(closingSeedComplete({...store.read(),rows:[saved]},evening),false);
 assert.equal(closingSeedComplete({...store.read(),rows:[quote(),quote('NEW')]},evening),false);
});
test('aggregate recovery clears all filled ranges and retains partially covered ranges',()=>{
 const {store}=harness(),from=AT-90*60000;
 for (const [i,at] of [from,from+45*60000,AT].entries()) {const run=`${i+1}:1`;store.begin(run,['TEST']);store.checkpoint(run,[quote('TEST',at)]);store.finish(run);}
 assert.equal(store.read().gaps.find(gap=>gap.reason==='unrecovered').count,2);
 const candles=recoverySlots(from,AT).map(at=>quote('TEST',at,{kind:'recovered-candle'}));
 store.recovery('3:1','TEST',from,AT,candles.slice(0,2));
 assert.equal(store.read().recoveryPending.length,1);
 // A smaller replay may fill its slots, but cannot shrink the larger pending range.
 store.recovery('3:1','TEST',from,from+30*60000,[]);
 assert.equal(store.read().recoveryPending[0].until,AT);
 store.recovery('3:1','TEST',from,AT,candles.slice(2));
 assert.equal(store.read().recoveryPending.length,0);
 assert.equal(store.read().gaps.find(gap=>gap.reason==='candles-recovered').count,2);
 assert.equal(store.read().rows[0].kind,'quote');assert.equal(store.read().rows[0].quoteAt,iso(AT));
});
test('read routes never arm capture and daily delivery preserves a dated fallback',async()=>{
 let armed=0;const env={CAPTURE_REGISTRY:{getByName:()=>({breakoutRead:async()=>({version:1,state:'not-started',rows:[],targets:[],failures:[]}),breakoutScheduleStatus:async()=>({started:false}),breakoutBegin:async()=>{armed++;}})}};
 const r=await handleBreakouts(new Request('https://test/api/breakouts'),env,{now:()=>AT});assert.equal(r.status,200);assert.equal(armed,0);
 const denied=await handleBreakouts(new Request(BREAKOUT_ENDPOINT,{method:'POST',body:'{}'}),env,{identity:async()=>{throw Error();}});assert.equal(denied.status,403);
 const fallback=await handleTechnicals(new Request('https://test/api/technicals'),{ASSETS:{fetch:async()=>Response.json({companies:[{ticker:'TEST'}],generated_at:iso(AT-86400000)})}},{fetcher:async()=>{throw Error('offline');}});
 assert.equal(fallback.headers.get('x-sattva-delivery'),'deployed-fallback');assert.equal((await fallback.json()).generated_at,iso(AT-86400000));
});
test('only a signed fixed-workflow main-branch GitHub identity may write',async()=>{
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'fixture',use:'sig',alg:'RS256'};
 const claims={iss:'https://token.actions.githubusercontent.com',aud:BREAKOUT_ENDPOINT,repository:'techmuns/Sattva-Central-Research',repository_id:'1329567087',repository_owner_id:'278697674',ref:'refs/heads/main',workflow_ref:'techmuns/Sattva-Central-Research/.github/workflows/breakouts-refresh.yml@refs/heads/main',event_name:'schedule',exp:AT/1000+300,iat:AT/1000,nbf:AT/1000,run_id:'1',run_attempt:'1'};
 async function request(patch={}){const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const body=encode({alg:'RS256',kid:'fixture'})+'.'+encode({...claims,...patch});const sig=Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(body))).toString('base64url');return new Request(BREAKOUT_ENDPOINT,{headers:{authorization:`Bearer ${body}.${sig}`}});}
 const options={now:AT,fetcher:async url=>{assert.equal(url,'https://token.actions.githubusercontent.com/.well-known/jwks');return Response.json({keys:[jwk]});}};
 assert.equal(await breakoutCollectorIdentity(await request(),options),'1:1');
 assert.equal(await breakoutCollectorIdentity(await request({event_name:'push'}),options),'1:1');
 for(const patch of [{ref:'refs/heads/feature'},{event_name:'pull_request'},{repository_id:'2'},{workflow_ref:claims.workflow_ref.replace('breakouts','other')},{exp:AT/1000-1}])await assert.rejects(breakoutCollectorIdentity(await request(patch),options));
 await assert.rejects(breakoutClient({env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://evil.test'},fetcher:async()=>{throw Error('must not fetch');}})({action:'begin'}));
});

test('Upstox supplies a missing breakout base during a primary outage',async()=>{
 const candles=historyDates(35).map(date=>[date+'T00:00:00+05:30',97,100,95,97,1000]);let historyCalls=0;
 const result=await upstoxQuotes([{ticker:'TEST'}],new Map(),{token:'fixture',now:()=>AT,instruments:[{segment:'NSE_EQ',instrument_type:'EQ',instrument_key:'NSE_EQ|INE000000001',trading_symbol:'TEST'}],fetcher:async(url,opts)=>{
 assert.equal(new URL(url).origin,'https://api.upstox.com');assert.equal(opts.headers.authorization,'Bearer fixture');
 if(new URL(url).pathname.includes('/historical-candle/')){historyCalls++;return Response.json({status:'success',data:{candles}});}
 return Response.json({status:'success',data:{test:{instrument_token:'NSE_EQ|INE000000001',symbol:'TEST',last_price:105,net_change:7,volume:2500,last_trade_time:String(AT)}}});}});
 assert.equal(historyCalls,1);assert.equal(result.rows[0].base.high,100);assert.equal(liveBreakout(result.rows[0]).quality,'strong');
});

test('gap journalling is atomic with the new quote even if recovery never starts',()=>{
 const {store}=harness();store.begin('1:1',['TEST']);store.checkpoint('1:1',[quote('TEST',AT-60*60000)]);store.finish('1:1');
 store.begin('2:1',['TEST']);store.checkpoint('2:1',[quote()]);
 assert.equal(store.read().recoveryPending.length,1);assert.equal(store.read().recoveryPending[0].since,AT-60*60000);
});

test('future universe rows resolve their Screener symbols before daily scoring catches up',()=>{
 assert.equal(captureTarget({'Company':'Future company','Screener URL':'https://www.screener.in/company/FUTURE/consolidated/'}).ticker,'FUTURE');
 assert.equal(captureTarget({name:'Unresolved',ticker:null}),null);
 assert.equal(yahooSymbol({ticker:'ALPEXSOLAR-SM'}),'ALPEXSOLAR.NS');assert.equal(yahooSymbol({ticker:'504346'}),'504346.BO');
});

test('public capture reads share a short cache; conditional requests retain source timestamps',async()=>{
 let reads=0,cached=null;
 const env={CAPTURE_REGISTRY:{getByName:()=>({breakoutRead:async()=>{reads++;return {version:1,state:'complete',targets:['TEST'],rows:[quote()],failures:[],completedAt:iso(AT)};},breakoutScheduleStatus:async()=>({started:true})})}};
 const options={now:()=>AT,edgeCache:{match:async()=>cached?.clone(),put:async(key,response)=>{cached=response;}}};
 const first=await handleBreakouts(new Request('https://test/api/breakouts'),env,options);
 const second=await handleBreakouts(new Request('https://test/api/breakouts',{headers:{'if-none-match':first.headers.get('etag')}}),env,options);
 assert.equal(second.status,304);assert.equal(reads,1);assert.equal((await first.json()).rows[0].quoteAt,iso(AT));
 await handleBreakouts(new Request('https://test/api/breakouts/health'),env,options);assert.equal(reads,2);
});

test('later historical corrections retain both observations without duplicating unchanged candles',()=>{
 const {store}=harness(),from=AT-15*60000;
 for (const run of ['1:1','2:1','3:1']) store.begin(run,['TEST']);
 store.recovery('1:1','TEST',from,AT,[quote('TEST',AT,{kind:'recovered-candle',price:101})]);
 store.recovery('2:1','TEST',from,AT,[quote('TEST',AT,{kind:'recovered-candle',price:101})]);
 store.recovery('3:1','TEST',from,AT,[quote('TEST',AT,{kind:'recovered-candle',price:102})]);
 assert.deepEqual(store.history('TEST').rows.map(row=>row.price).sort(),[101,102]);
});

test('daily delivery streams the fixed source and reuses its ETag without reparsing it in the Worker',async()=>{
 const payload={companies:[{ticker:'TEST'}],generated_at:iso(AT)};
 const sha='a'.repeat(40),fetcher=raw=>async url=>{if(url.startsWith('https://api.github.com/'))return Response.json([{sha}]);assert(url.endsWith(`/${sha}/public/data/technicals.json`));return raw();};
 const response=await handleTechnicals(new Request('https://test/api/technicals'),{}, {fetcher:fetcher(()=>Response.json(payload,{headers:{etag:'"daily-1"'}}))});
 assert.equal(response.headers.get('etag'),'"daily-1"');assert.equal(response.headers.get('x-sattva-delivery'),'repository');assert.deepEqual(await response.json(),payload);
 const notModified=await handleTechnicals(new Request('https://test/api/technicals',{headers:{'if-none-match':'"daily-1"'}}),{}, {fetcher:fetcher(()=>Response.json(payload,{headers:{etag:'"daily-1"'}}))});
 assert.equal(notModified.status,304);
 const brokenCache={match:async()=>{throw Error('cache unavailable');},put:async()=>{throw Error('cache unavailable');}};
 const uncached=await handleTechnicals(new Request('https://test/api/technicals'),{}, {edgeCache:brokenCache,fetcher:fetcher(()=>Response.json(payload))});
 assert.deepEqual(await uncached.json(),payload);
 const oversized=await handleTechnicals(new Request('https://test/api/technicals'),{}, {fetcher:fetcher(()=>new Response(new Uint8Array(17*1024*1024)))});
 await assert.rejects(oversized.arrayBuffer(),/too large/);
});

test('fresh primary quotes without a base use backup history and survive a backup failure',async()=>{
 for(const failed of [false,true]){
  const {store,client}=harness();let used=0;
  const summary=await collectBreakouts({targets:[{ticker:'TEST'}],client,now:()=>AT,sleep:async()=>{},token:'fixture',primary:async()=>quote('TEST',AT,{base:null}),backup:async targets=>{
   used++;assert.equal(targets[0].ticker,'TEST');if(failed)throw Error('offline');return {rows:[quote('TEST',AT,{price:110,provider:'Upstox'})]};
  }});
  assert.equal(used,1);assert.equal(summary.noBase,failed?1:0);assert.equal(summary.failures,0);
  assert.equal(store.read().rows[0].price,105);assert.equal(store.read().rows[0].provider,'Yahoo Finance');assert.equal(store.history('TEST').rows.length,1);
 }
});

test('daily companion files use the exact daily revision and never silently use deployed inputs',async()=>{
 const sha='b'.repeat(40),expected={TEST:[{date:'2026-09-11',atr_pct:1.2}]};
 const request=new Request(`https://test/api/technicals/atr-history?revision=${sha}`);
 const response=await handleTechnicals(request,{}, {fetcher:async url=>{assert.equal(url,`https://raw.githubusercontent.com/techmuns/Sattva-Central-Research/${sha}/public/data/atr-history.json`);return Response.json(expected);}});
 assert.equal(response.headers.get('x-sattva-revision'),sha);assert.deepEqual(await response.json(),expected);
 const failed=await handleTechnicals(request,{ASSETS:{fetch:()=>{throw Error('must not mix revisions');}}},{fetcher:async()=>{throw Error('offline');}});assert.equal(failed.status,503);
 const refused=await handleTechnicals(new Request('https://test/api/technicals/atr-history?revision=main'),{},{fetcher:()=>{throw Error('must not fetch');}});assert.equal(refused.status,400);
});

test('long captures acquire a fresh identity for every checkpoint',async()=>{
 let identities=0;const seen=[];
 const client=breakoutClient({env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://test.actions.githubusercontent.com/id',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture'},fetcher:async(url,options)=>{
  if(new URL(url).pathname==='/id')return Response.json({value:`token-${++identities}`});
  seen.push(options.headers.authorization);return Response.json({ok:true});
 }});
 await client({action:'begin'});await client({action:'checkpoint'});await client({action:'finish'});
 assert.deepEqual(seen,['Bearer token-1','Bearer token-2','Bearer token-3']);
});

test('merge bootstrap survives delayed publishing and arms without a quote or scheduled run',async()=>{
 let at=AT,calls=0,armed=0;
 const env={CAPTURE_REGISTRY:{getByName:()=>({breakoutArm:async()=>{armed++;return {started:true,alarmAt:at+900000};}})}};
 const result=await bootstrapBreakouts({now:()=>at,sleep:async ms=>{at+=ms;},client:async input=>{
  assert.equal(input.action,'arm');if(++calls<3)throw Error('not deployed');
  const response=await handleBreakouts(new Request(BREAKOUT_ENDPOINT,{method:'POST',body:JSON.stringify(input)}),env,{identity:async()=>'1:1'});
  return response.json();
 }});
 assert(result.schedule.started);assert.equal(armed,1);assert.equal(calls,3);
 await assert.rejects(bootstrapBreakouts({now:()=>at,sleep:async ms=>{at+=ms;},client:async()=>{throw Error('unpublished');}}),/publishing/);
});
