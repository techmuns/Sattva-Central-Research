// Incremental, public-source recovery. Runs only on GitHub; no broker token or paid source.
import {fetchBars, istDay} from './yahoo.mjs';
import {expectedSession} from '../../public/js/data/breakout-live-shared.js';
import {yahooSymbol} from '../../worker/upstox-market.mjs';
import {computeIndicators, computeLiquidityIndicators, recentWindow} from '../scrape-technicals.mjs';
import {volumeWindow10d} from '../../public/js/scoring/momentum-history.js';
import {researchPriceHistory,retainedPriceHistory} from './research-price-history.mjs';
import {marketBreadth, priceDateOf} from './technicals-file.mjs';

const MINUTE=60000, DAY=86400000;
export function completedSession(at) {
  const day=istDay(at), local=new Date(at+19800000), settled=local.getUTCHours()>=16;
  return expectedSession(settled ? at : Date.parse(`${day}T09:00:00+05:30`));
}
export function needsHistory(row, session) {
  return !!row.error || (row.price_date || row.bar_date || '')<session ||
    row.closeHistory?.sourceSymbol!==yahooSymbol(row) || !row.rsi_multi?.daily || !row.macd?.state;
}
function coverage(rows, session) {
  const current=rows.filter(row=>!needsHistory(row,session));
  return {expectedSession:session,total:rows.length,current:current.length,pending:rows.length-current.length,
    complete:current.length===rows.length};
}
export async function recoverTechnicals(input, savedLedger={}, {now=Date.now, bars=fetchBars,
  sleep=ms=>new Promise(done=>setTimeout(done,ms)), checkpoint=()=>{}, budgetMs=25*MINUTE, maxRequests=650}={}) {
  const at=now(), session=completedSession(at);
  if (!Array.isArray(input?.companies) || !input.companies.length || new Set(input.companies.map(row=>row.ticker)).size!==input.companies.length) throw Error('Invalid technical inventory');
  const payload=structuredClone(input), ledger={version:1,...structuredClone(savedLedger),companies:{...savedLedger.companies}};
  const summary={requests:0,repaired:0,failed:0,skipped:0,...coverage(payload.companies,session)};
  if (ledger.holdUntil>at || ledger.lastAttemptAt>at-15*MINUTE) return {payload:input,ledger:savedLedger,summary:{...summary,held:true}};
  const due=payload.companies.filter(row=>needsHistory(row,session)).filter(row=>{
    const old=ledger.companies[row.ticker];
    return !old || (old.session!==session && old.state==='insufficient-history') || !(old.retryAt>at);
  }).sort((a,b)=>(ledger.companies[a.ticker]?.at||0)-(ledger.companies[b.ticker]?.at||0));
  if (!due.length) return {payload:input,ledger:savedLedger,summary};
  ledger.lastAttemptAt=at;
  let lastRequest=-Infinity, indexBars=[];
  const request=async symbol=>{
    if (summary.requests>=maxRequests || now()>=at+budgetMs) throw Error('Recovery budget reached');
    const wait=2000-(now()-lastRequest);if(wait>0)await sleep(wait);
    summary.requests++;lastRequest=now();
    return bars(symbol,new Date(now()-4050*DAY),new Date(now()),{maxAttempts:1,now:()=>new Date(now())});
  };
  const refusal=error=>{
    if (![401,403,429].includes(error.status)) return false;
    ledger.strikes=(ledger.strikes||0)+1;
    ledger.holdUntil=Math.max(now()+Math.min(DAY,60*MINUTE*2**Math.min(ledger.strikes-1,5)),error.retryAt||0);
    ledger.reason='source-cooldown';return true;
  };
  const save=async()=>{
    const status=coverage(payload.companies,session);
    payload.price_date=priceDateOf(payload.companies);
    payload.price_date_rows=payload.companies.filter(item=>item.bar_date===payload.price_date).length;
    payload.failures=payload.companies.filter(item=>item.error || item.history_check?.state==='failed').length;
    payload.market_breadth=marketBreadth(payload.companies);
    if(summary.repaired)payload.generated_at=new Date(now()).toISOString();
    payload.history_recovery={checkedAt:new Date(now()).toISOString(),...status,requests:summary.requests,
      repaired:summary.repaired,failed:summary.failed,nextEligibleAt:ledger.holdUntil ? new Date(ledger.holdUntil).toISOString():null};
    await checkpoint(payload,ledger);
  };
  try { indexBars=await request('^CRSLDX'); }
  catch(error) { if(refusal(error)){await save();return {payload,ledger,summary:{...summary,held:true}};} }
  // An index outage must not block stock RSI, MACD and averages. Preserve the
  // previous index-relative evidence separately with its actual date.
  const indexCurrent=indexBars.at(-1)?.date>=session;
  if(!indexCurrent)indexBars=[];
  for (const row of due) {
    if (summary.requests>=maxRequests || now()>=at+budgetMs) break;
    const previous=ledger.companies[row.ticker], symbol=yahooSymbol(row);
    ledger.companies[row.ticker]={...previous,at:now(),session,state:'checking',retryAt:now()+15*MINUTE};
    await save(); // An interrupted attempt remains paced on the next runner.
    try {
      const long=await request(symbol);
      if (long.meta?.symbol && long.meta.symbol!==symbol) throw Error('Source symbol mismatch');
      if (new Set(long.map(bar=>bar.date)).size!==long.length || long.some((bar,i)=>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) || !(bar.close>0) || !(bar.high>0) || !(bar.low>0) || !Number.isFinite(bar.volume) || bar.volume<0 ||
        (i && bar.date<=long[i-1].date) || bar.date>session)) throw Error('Invalid completed history');
      const recent=recentWindow(long,new Date(now()-400*DAY));
      if (recent.length<60) {
        const error=new Error(`only ${recent.length} bars`);error.insufficient=true;throw error;
      }
      const last=recent.at(-1).date;
      if (last<session || last<(row.price_date || row.bar_date || '')) throw Error('History has not reached the required completed session');
      const indicators=computeIndicators(recent,indexBars,[],indexBars.map(bar=>bar.close),long,istDay(now()));
      // A new close invalidates old move-verification receipts. Never carry a
      // confirmation for a different close into the repaired day move.
      for (const key of Object.keys(row)) if (key.startsWith('move_')) delete row[key];
      const deliveryDate=row.delivery_reading_date || row.bar_date;
      Object.assign(row,indicators,computeLiquidityIndicators(recent),{price_date:last,momentum_volume_10d:volumeWindow10d(recent,null,symbol),
        closeHistory:researchPriceHistory(recent,{sourceSymbol:symbol,capturedAt:new Date(now()).toISOString()}) || retainedPriceHistory(row.closeHistory),
        history_check:{checkedAt:new Date(now()).toISOString(),state:'current',source:'Yahoo Finance',symbol,through:last},
        index_reading_date:indexCurrent?indexBars.at(-1).date:input.price_date});
      if(row.delivery_days_count>0)row.delivery_reading_date=deliveryDate;
      if(!indexCurrent) {
        const old=input.companies.find(item=>item.ticker===row.ticker);
        row.retained_index_reading=old.retained_index_reading || {date:old.bar_date,
          beta_1y:old.beta_1y??null,return_6m_index:old.return_6m_index??null,relative_strength_6m:old.relative_strength_6m??null};
        // Retain old evidence, but never score yesterday's relative readings as
        // if they had been recomputed against today's stock history.
        for(const key of ['beta_1y','return_6m_index','relative_strength_6m'])row[key]=null;
      } else {
        delete row.retained_index_reading;
      }
      delete row.error;
      ledger.companies[row.ticker]={at:now(),session,state:'current',retryAt:0,attempts:0};
      summary.repaired++;
    } catch(error) {
      summary.failed++;
      const attempts=(previous?.session===session?previous.attempts||0:0)+1;
      const state=error.insufficient?'insufficient-history':'failed';
      const retryAt=now()+(error.insufficient?DAY:Math.min(6*60*MINUTE,15*MINUTE*2**Math.min(attempts-1,5)));
      ledger.companies[row.ticker]={at:now(),session,state,attempts,retryAt,reason:String(error.message).slice(0,200)};
      row.history_check={checkedAt:new Date(now()).toISOString(),state,source:'Yahoo Finance',symbol,through:row.price_date||row.bar_date||null,reason:ledger.companies[row.ticker].reason};
      if(refusal(error)){await save();break;}
    }
    await save();
  }
  if(!ledger.holdUntil || ledger.holdUntil<=now()){ledger.holdUntil=0;ledger.reason=null;ledger.strikes=0;}
  await save();
  return {payload,ledger,summary:{...summary,...coverage(payload.companies,session)}};
}
