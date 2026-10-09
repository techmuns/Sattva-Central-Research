import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerIndicators, evaluateFilter, advanceMacd } from '../public/js/scoring/momentum-live.js';
import { completedPeriods, volumeWindow10d } from '../public/js/scoring/momentum-history.js';
import { wilderRsiState } from './lib/momentum.mjs';
import { rsi } from './lib/indicators.mjs';
import { parseYahooQuote } from './lib/breakout-providers.mjs';
import { mergePrimary } from '../worker/breakout-store.mjs';
import { validateQuote } from '../public/js/data/breakout-live-shared.js';

const AT = Date.parse('2026-10-09T06:30:00Z');
const frame = (value, lastClose = 100) => ({value,avgGain:100/(100-value)-1,avgLoss:1,lastClose});
const company = extra => ({ticker:'TEST',cmp:100,bar_date:'2026-10-08',sma20:90,sma50:85,sma100:80,sma200:75,
  above_20dma:true,avg_volume_10d:1000,closeHistory:{sourceSymbol:'TEST.NS'},
  rsi_multi:{daily:frame(80),weekly:frame(80),monthly:frame(75)},macd:{ema12:110,ema26:100,line:10,signal:1},...extra});
const volumeBase = {average:1000,from:'2026-09-24',to:'2026-10-08',count:10,exchange:'NSE'};
const quote = extra => ({ticker:'TEST',price:102,prevClose:100,volume:2000,sessionDate:'2026-10-09',
  quoteAt:new Date(AT).toISOString(),checkedAt:new Date(AT).toISOString(),provider:'Upstox',exchange:'NSE',volumeBase,...extra});
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} differs from ${b}`);

test('Deepak Nitrite uses all ten preceding sessions, including yesterday; its false pass disappears', () => {
  // Source daily volumes behind the user's 9 October screenshot.
  const dates=['2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-05','2026-10-06','2026-10-07','2026-10-08'];
  const volumes=[109445,90646,69925,100481,187781,141444,157119,108056,279774,121384,631015];
  const bars=dates.map((date,i)=>({date,volume:volumes[i]}));
  const baseline=volumeWindow10d(bars,'2026-10-09','DEEPAKNTR.NS');
  assert.equal(baseline.to,'2026-10-08');
  near(baseline.average,188762.5);
  const v=scannerIndicators(company({avg_volume_10d:136606}),quote({volume:136606*1.73,volumeBase:baseline}),{now:AT});
  assert.ok(v.volRatio10d>1.25 && v.volRatio10d<1.26);
  assert.equal(evaluateFilter('volume-momentum',v).pass,false);
  assert.equal(evaluateFilter('volume-momentum',v).evaluable,true);
});

test('legacy EOD averages are never used as a substitute for an undated live baseline', () => {
  const v=scannerIndicators(company(),quote({volumeBase:null}),{now:AT});
  assert.equal(v.volRatio10d,null);
  assert.equal(evaluateFilter('volume-momentum',v).evaluable,false);
  assert.equal(evaluateFilter('strong-momentum',v).pass,true);
  const updated=scannerIndicators(company({momentum_volume_10d:volumeBase}),quote({volumeBase:null}),{now:AT});
  assert.equal(updated.volRatio10d,2);
});

test('current volume, daily history and the volume window must all match the session and exchange', () => {
  for (const q of [quote({volumeBase:{...volumeBase,to:'2026-10-07'}}),quote({volumeBase:{...volumeBase,exchange:'BSE'}})]) {
    assert.equal(scannerIndicators(company(),q,{now:AT}).volRatio10d,null);
  }
  assert.equal(evaluateFilter('volume-momentum',scannerIndicators(company({bar_date:'2026-10-07'}),quote(),{now:AT})).pass,false);
  assert.equal(evaluateFilter('strong-momentum',scannerIndicators(company({closeHistory:{sourceSymbol:'TEST.BO'}}),quote(),{now:AT})).pass,false);
  assert.throws(()=>validateQuote(quote({volumeBase:{...volumeBase,to:'2026-10-09'}}),AT),/volume base/);
  assert.throws(()=>validateQuote(quote({volumeBase:{...volumeBase,exchange:'BSE'}}),AT),/volume base/);
});

test('a rejected old quote cannot lend volume or previous close to a saved daily price', () => {
  const old=quote({sessionDate:'2026-10-07',quoteAt:'2026-10-07T10:00:00Z',volume:200000,prevClose:90});
  const v=scannerIndicators(company(),old,{now:AT});
  assert.equal(v.price,100); // Retain the useful saved reading.
  assert.equal(v.liveVolume,null);
  assert.equal(v.prevClose,null);
  assert.equal(evaluateFilter('volume-momentum',v).pass,false);
  assert.equal(evaluateFilter('strong-momentum',v).evaluable,false);
  assert.equal(evaluateFilter('strong-momentum',scannerIndicators(company(),quote(),{now:AT,unavailable:true})).pass,false);
  const noTrade=quote({quoteAt:'2026-10-08T10:00:00Z',feedAt:new Date(AT).toISOString(),volume:0});
  assert.equal(scannerIndicators(company(),noTrade,{now:AT}).isLiveQuote,false);
});

test('Volume + Momentum can evaluate a newer stock without 100/200-day or monthly history', () => {
  const c=company({sma100:null,sma200:null,rsi_multi:{daily:frame(80),weekly:null,monthly:null}});
  const v=scannerIndicators(c,quote(),{now:AT});
  assert.equal(evaluateFilter('volume-momentum',v).pass,true);
  assert.equal(evaluateFilter('strong-momentum',v).evaluable,false);
});

test('Monday and first-of-month capture retain the completed previous period', () => {
  const bars=[{date:'2026-08-31',close:90},{date:'2026-09-25',close:95},{date:'2026-09-30',close:100},{date:'2026-10-01',close:102}];
  assert.equal(completedPeriods(bars,'week','2026-10-05').at(-1).date,'2026-10-01');
  assert.equal(completedPeriods(bars,'month','2026-10-01').at(-1).date,'2026-09-30');
});

test('legacy and new weekly states agree with a full independent RSI across Monday rollover', () => {
  const closes=Array.from({length:24},(_,i)=>100+i/2+Math.sin(i)*4);
  const monday=Date.parse('2026-10-05T06:30:00Z'),last=closes.at(-1),live=last+3;
  const old=wilderRsiState(closes.slice(0,-1)),updated={...wilderRsiState(closes),asOf:'2026-10-01'};
  for(const weekly of [old,updated]) {
    const c=company({cmp:last,bar_date:'2026-10-01',rsi_multi:{daily:frame(80,last),weekly,monthly:frame(75,last)}});
    const q=quote({price:live,prevClose:last,sessionDate:'2026-10-05',quoteAt:new Date(monday).toISOString(),volumeBase:{...volumeBase,to:'2026-10-01'}});
    near(scannerIndicators(c,q,{now:monday}).rsiWeekly,rsi([...closes,live],14).at(-1));
  }
});

test('monthly legacy state restores the completed previous month before the live step', () => {
  const closes=Array.from({length:24},(_,i)=>100+i+Math.sin(i)*5),last=closes.at(-1),live=last+2;
  const at=Date.parse('2026-10-01T06:30:00Z');
  for(const monthly of [wilderRsiState(closes.slice(0,-1)),{...wilderRsiState(closes),asOf:'2026-09-30'}]) {
    const c=company({cmp:last,bar_date:'2026-09-30',rsi_multi:{daily:frame(80,last),weekly:frame(80,last),monthly}});
    const q=quote({price:live,prevClose:last,sessionDate:'2026-10-01',quoteAt:new Date(at).toISOString(),volumeBase:{...volumeBase,to:'2026-09-30'}});
    near(scannerIndicators(c,q,{now:at}).rsiMonthly,rsi([...closes,live],14).at(-1));
  }
});

test('already completed daily and monthly readings are not advanced a second time', () => {
  const at=Date.parse('2026-10-01T03:00:00Z'),closeAt='2026-09-30T10:00:00Z';
  const c=company({bar_date:'2026-09-30',rsi_multi:{daily:frame(80),weekly:frame(80),monthly:{...frame(75),asOf:'2026-09-30'}}});
  const q=quote({price:100,sessionDate:'2026-09-30',quoteAt:closeAt,checkedAt:closeAt,volumeBase:{...volumeBase,to:'2026-09-29'}});
  const v=scannerIndicators(c,q,{now:at});
  assert.equal(v.rsiDaily,80);assert.equal(v.rsiMonthly,75);
  assert.equal(v.macdLine,10);assert.equal(v.macdSignal,1);
});

test('a saved MACD crossover is not repeated as a new intraday crossover', () => {
  const c=company({macd:{ema12:110,ema26:100,line:10,signal:1,positive_crossover:true}});
  const v=scannerIndicators(c,quote(),{now:AT});
  assert.equal(v.macdBullish,true);
  assert.equal(v.freshCross,false);
});

test('small MACD readings use unrounded running state rather than display figures', () => {
  const state={ema12:0.01234567,ema26:0.01211111,signal:0.00022,asOf:'2026-10-08'};
  const c=company({cmp:0.0123,macd:{ema12:0.0123,ema26:0.0121,line:0,signal:0,state}});
  const q=quote({price:0.0123});
  const v=scannerIndicators(c,q,{now:AT}),expected=advanceMacd(state,q.price);
  near(v.macdLine,expected.line);near(v.macdSignal,expected.signal);
  assert.equal(v.freshCross,false); // It was already bullish before display rounded it to zero.
  const completed=scannerIndicators({...c,bar_date:q.sessionDate},q,{now:AT});
  near(completed.macdLine,state.ema12-state.ema26);near(completed.macdSignal,state.signal);
  assert.equal(completed.macdBullish,true);
});

test('shared capture carries the volume window into minute quotes only for the same venue/session', () => {
  const fallback={version:1,state:'complete',targets:['TEST'],rows:[quote({provider:'Yahoo Finance'})],failures:[],completedAt:new Date(AT).toISOString()};
  const primary={at:AT,completedAt:AT,targets:['TEST'],rows:[quote({volumeBase:undefined})],failures:[],instrumentFailures:[]};
  assert.deepEqual(mergePrimary(fallback,primary,AT).rows[0].volumeBase,volumeBase);
  primary.rows[0].exchange='BSE';
  assert.equal(mergePrimary(fallback,primary,AT).rows[0].volumeBase,undefined);
});

test('Yahoo capture derives a ten-session window from already fetched bars without using today', () => {
  const dates=['2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09'];
  const data={chart:{result:[{meta:{symbol:'TEST.NS',regularMarketTime:AT/1000,regularMarketPrice:102,regularMarketVolume:2000},
    timestamp:dates.map(date=>Date.parse(date+'T04:00:00Z')/1000),indicators:{quote:[{close:dates.map(()=>100),high:dates.map(()=>105),low:dates.map(()=>95),volume:dates.map((_,i)=>i===11?2000:1000)}]}}]}};
  assert.deepEqual(parseYahooQuote(data,{ticker:'TEST'},AT).volumeBase,volumeBase);
  assert.equal(volumeWindow10d([{date:'2026-10-08',volume:1}],'2026-10-09','TEST.NS'),null);
});
