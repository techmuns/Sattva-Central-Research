import test from 'node:test';
import assert from 'node:assert/strict';
import {completedSession,needsHistory,recoverTechnicals} from './lib/technical-recovery.mjs';
import {fetchBars} from './lib/yahoo.mjs';
import {scannerIndicators,evaluateFilter} from '../public/js/scoring/momentum-live.js';
import {rsi,sma} from './lib/indicators.mjs';
import {accumulateATRHistory,resetYahooStrikes} from './scrape-technicals.mjs';

const AT=Date.parse('2026-10-16T06:30:00Z'), DAY=86400000;
function series() {
  const bars=[];
  for(let at=Date.parse('2015-10-01');at<=Date.parse('2026-10-15');at+=DAY){
    if([0,6].includes(new Date(at).getUTCDay()))continue;
    const close=100+bars.length*.1+Math.sin(bars.length)*3;
    bars.push({date:new Date(at).toISOString().slice(0,10),open:close,high:close+2,low:close-2,close,adjustedClose:close,volume:1000+bars.length});
  }
  bars.meta={symbol:'TEST.NS'};return bars;
}
const old=()=>({ticker:'TEST',name:'Test company',cmp:90,bar_date:'2026-10-14',price_date:'2026-10-14',
  closeHistory:{sourceSymbol:'TEST.NS',rows:[['2026-10-14',90]]},delivery_avg_recent:35,privateField:'preserve',move_check:'confirmed',move_source:'old check'});
const input=rows=>({generated_at:'2026-10-16T01:30:00Z',price_date:'2026-10-14',companies:rows});
function clock(){let at=AT;return {now:()=>at,sleep:async ms=>{at+=ms;}};}
const source=async symbol=>{const data=series();data.meta.symbol=symbol;return data;};

test('completed-session target respects pre-open, market hours, close settling, holidays and weekends',()=>{
  for(const stamp of ['2026-10-16T01:30:00Z','2026-10-16T06:30:00Z','2026-10-16T10:15:00Z'])assert.equal(completedSession(Date.parse(stamp)),'2026-10-15');
  assert.equal(completedSession(Date.parse('2026-10-16T10:30:00Z')),'2026-10-16');
  assert.equal(completedSession(Date.parse('2026-10-17T07:00:00Z')),'2026-10-16');
  assert.equal(completedSession(Date.parse('2026-10-02T07:00:00Z')),'2026-10-01');
});
test('available Yahoo history repairs stale indicators using the existing precise maths',async()=>{
  const calls=[],checkpoints=[],time=clock();
  const result=await recoverTechnicals(input([old()]),{}, {...time,bars:async symbol=>{calls.push({symbol,at:time.now()});return source(symbol);},checkpoint:(payload,ledger)=>checkpoints.push(structuredClone({payload,ledger}))});
  const row=result.payload.companies[0],recent=series().filter(bar=>Date.parse(bar.date)>=time.now()-400*DAY),closes=recent.map(bar=>bar.close);
  assert.equal(row.bar_date,'2026-10-15');assert.equal(row.price_date,undefined);
  assert.equal(row.delivery_avg_recent,35);assert.equal(row.privateField,'preserve');assert.equal(row.move_check,undefined);
  assert.equal(row.sma200,Math.round(sma(closes,200).at(-1)));
  assert(Math.abs(row.rsi_multi.daily.value-rsi(closes,14).at(-1))<=.05);
  assert.equal(row.momentum_volume_10d.to,'2026-10-15');assert.equal(row.closeHistory.to,'2026-10-15');
  assert.equal(row.rsi_multi.monthly.asOf,'2026-09-30');
  assert.equal(result.summary.pending,0);assert.equal(result.summary.repaired,1);
  assert(calls[1].at-calls[0].at>=2000);assert(checkpoints.length>=1);
  assert.equal(needsHistory(row,'2026-10-15'),false);
  let requested=false;
  await recoverTechnicals(result.payload,result.ledger,{...time,bars:async()=>{requested=true;throw Error('no');}});
  assert.equal(requested,false,'repeated runners do not download already-current rows');
});
test('a failed or still-outdated source retains every saved value and sets a durable retry',async()=>{
  const before=old(),time=clock();
  const {payload,ledger,summary}=await recoverTechnicals(input([before]),{}, {...time,bars:async symbol=>{
    if(symbol==='^CRSLDX')throw Error('index outage');
    return series().filter(bar=>bar.date<='2026-10-14');
  }});
  const row=payload.companies[0];for(const key of Object.keys(before))assert.deepEqual(row[key],before[key]);
  assert.equal(summary.pending,1);assert.equal(row.history_check.state,'failed');
  assert(ledger.companies.TEST.retryAt>time.now());assert.equal(payload.generated_at,input([]).generated_at);
});
test('429 stops the walk, honors Retry-After and survives the next runner without provider calls',async()=>{
  const time=clock(),calls=[];
  const first=await recoverTechnicals(input([old(),{...old(),ticker:'NEXT'}]),{}, {...time,bars:async symbol=>{
    calls.push(symbol);if(symbol==='^CRSLDX')return source(symbol);
    const error=Error('rate limited');error.status=429;error.retryAt=AT+2*3600000;throw error;
  }});
  assert.deepEqual(calls,['^CRSLDX','TEST.NS']);assert.equal(first.ledger.holdUntil,AT+2*3600000);
  const second=await recoverTechnicals(first.payload,first.ledger,{...time,bars:async()=>{throw Error('must not query');}});
  assert.equal(second.summary.held,true);assert.equal(second.summary.requests,0);
});
test('request ceilings checkpoint progress and the next pass resumes remaining companies',async()=>{
  const time=clock(),rows=[old(),{...old(),ticker:'NEXT'}];
  const one=await recoverTechnicals(input(rows),{}, {...time,bars:source,maxRequests:2});
  assert.equal(one.summary.repaired,1);assert.equal(one.summary.pending,1);
  await time.sleep(16*60000);
  const calls=[];
  const two=await recoverTechnicals(one.payload,one.ledger,{...time,bars:async symbol=>{calls.push(symbol);return source(symbol);}});
  assert.deepEqual(calls,['^CRSLDX','NEXT.NS']);assert.equal(two.summary.pending,0);
});
test('insufficient listing history is a dated limitation and is retried on the next session',async()=>{
  const time=clock();
  const result=await recoverTechnicals(input([old()]),{}, {...time,bars:async symbol=>symbol==='^CRSLDX'?source(symbol):series().slice(-30)});
  assert.equal(result.ledger.companies.TEST.state,'insufficient-history');
  assert.equal(result.payload.companies[0].cmp,90);
  const next=await recoverTechnicals(result.payload,result.ledger,{now:()=>AT+DAY,bars:source,sleep:async()=>{}});
  // Saturday's target advances to Friday's settled close, independently of a 24h retry clock.
  assert(next.summary.requests>0);
});
test('an index outage does not block momentum recovery or erase existing index-relative readings',async()=>{
  const row={...old(),beta_1y:1.3,return_6m_index:.1,relative_strength_6m:.2};
  const result=await recoverTechnicals(input([row]),{}, {...clock(),bars:async symbol=>{if(symbol==='^CRSLDX')throw Error('offline');return source(symbol);}});
  assert.equal(result.summary.repaired,1);assert.equal(result.payload.companies[0].beta_1y,null);
  assert.equal(result.payload.companies[0].retained_index_reading.relative_strength_6m,.2);
  assert.equal(result.payload.companies[0].retained_index_reading.beta_1y,1.3);
  assert.equal(result.payload.companies[0].index_reading_date,'2026-10-14');
  assert.equal(needsHistory(result.payload.companies[0],'2026-10-15'),true);
  const asked=[];
  const pending=await recoverTechnicals(result.payload,result.ledger,{now:()=>AT+16*60000,sleep:async()=>{},bars:async symbol=>{
    asked.push(symbol);throw Error('index still unavailable');
  }});
  assert.deepEqual(asked,['^CRSLDX']);assert.equal(pending.summary.pending,1);
  const recovered=await recoverTechnicals(pending.payload,pending.ledger,{now:()=>AT+32*60000,sleep:async()=>{},bars:source});
  assert.equal(recovered.summary.pending,0);assert.equal(recovered.payload.companies[0].retained_index_reading,undefined);
  assert(Number.isFinite(recovered.payload.companies[0].relative_strength_6m));
});
test('fresh quotes remain visible while outdated or different-exchange history cannot certify a pass',()=>{
  const q={ticker:'TEST',price:125,prevClose:120,volume:1000,quoteAt:new Date(AT).toISOString(),checkedAt:new Date(AT).toISOString(),sessionDate:'2026-10-16',provider:'Upstox',exchange:'NSE'};
  for(const c of [old(),{...old(),bar_date:'2026-10-15',price_date:'2026-10-15',closeHistory:{sourceSymbol:'TEST.BO'}}]){
    const value=scannerIndicators(c,q,{now:AT});assert.equal(value.price,125);assert.equal(value.isLiveQuote,true);
    assert.equal(value.indicatorPrice,90);assert.equal(value.historyAligned,false);
    for(const filter of ['strong-momentum','volume-momentum','macd-crossover'])assert.equal(evaluateFilter(filter,value).pass,false);
  }
});
test('retained failures never fabricate ATR observations and successful rows use their bar date',()=>{
  const previous={TEST:[{date:'2026-10-14',atr_pct:2}]};
  for(const state of ['failed','not-checked','checking'])assert.deepEqual(accumulateATRHistory(previous,[{...old(),atr14_pct:5,history_check:{state}}]),previous);
  const updated=accumulateATRHistory(previous,[{...old(),bar_date:'2026-10-15',atr14_pct:3,history_check:{state:'current'}}]);
  assert.deepEqual(updated.TEST,[...previous.TEST,{date:'2026-10-15',atr_pct:3}]);assert.equal(previous.TEST.length,1);
});
test('a successful full walk resets prior refusal escalation while retaining company checkpoints',()=>{
  const previous={strikes:5,holdUntil:AT-1,reason:'source-cooldown',companies:{TEST:{retryAt:AT+DAY}}};
  assert.deepEqual(resetYahooStrikes(previous),{...previous,strikes:0,holdUntil:0,reason:null});
  assert.equal(previous.strikes,5);
});
test('an unknown future or special-session calendar stops recovery without querying every company',async()=>{
  const at=Date.parse('2027-01-26T11:00:00Z');
  assert.equal(completedSession(at),null);assert.equal(completedSession(Date.parse('2026-11-08T11:00:00Z')),null);
  const result=await recoverTechnicals(input([old()]),{}, {now:()=>at,bars:async()=>{throw Error('must not query');}});
  assert.equal(result.summary.requests,0);assert.equal(result.summary.pending,1);assert.equal(result.payload.history_recovery.calendarKnown,false);
  assert.deepEqual(result.payload.companies,[old()]);
});
test('Yahoo fetches have a timeout and never retry source refusals in the same walk',async()=>{
  let requests=0;
  await assert.rejects(()=>fetchBars('TEST.NS',new Date(AT-DAY),new Date(AT),{now:()=>new Date(AT),fetcher:async(_url,options)=>{
    requests++;assert(options.signal);return new Response(null,{status:429,headers:{'retry-after':'7200'}});
  }}),error=>error.status===429&&error.retryAt===AT+7200000);
  assert.equal(requests,1);
});
