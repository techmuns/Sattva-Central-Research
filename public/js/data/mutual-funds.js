import { conditionalJson,revalidatedJson,readEntry,writeEntry } from '../core/store.js';
import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import { filterByScope } from './scope.js';
const snapshots=new Map(), pending=new Map(), rowsByIsin=new Map();
let latestMeta={}, lastDetail=null;
export const meta=()=>latestMeta;
export const all=()=>[...rowsByIsin.values()];
function adopt(payload, {fallback=false}={}) {
  for(const row of payload.rows) if(!fallback || !rowsByIsin.has(row.isin)) rowsByIsin.set(row.isin,row);
}
const local=()=>['localhost','127.0.0.1'].includes(location.hostname);
export function scopedRows(scope='portfolio',holdings=coverage.holdings()) {
  const rows=all();
  if(scope==='portfolio') { const map=new Map(rows.map(r=>[r.isin,r]));return holdings.map(h=>({...map.get(h.isin),isin:h.isin,ticker:h.ticker,name:h.name,sector:h.sector,missing:!map.has(h.isin)})); }
  const scoped=filterByScope(rows,scope,holdings);
  if(scope==='watchlist'){const byTicker=new Map(scoped.map(r=>[r.ticker,r]));return watchlist.all().map(h=>byTicker.get(h.ticker)||{ticker:h.ticker,name:h.name||h.ticker,missing:true});}
  return scoped;
}
export function load(scope='portfolio', {holdings=coverage.holdings(),refresh=true}={}) {
  const ids=scope==='portfolio'?[...new Set(holdings.map(h=>h.isin).filter(id=>/^IN[A-Z0-9]{10}$/.test(id)))].sort():null;
  const key=ids?ids.join(','):'universe';
  if(pending.has(key))return pending.get(key);
  if(!refresh&&snapshots.has(key))return Promise.resolve(snapshots.get(key));
  const promise=(async()=>{
    try {
      let payload,fallback=false,readFailed=false;
      if(local()) payload=await revalidatedJson('data/mutual-funds/index.json');
      else {
        const rows=[];let meta={};
        // Scope reads stay bounded even when the live book grows beyond one API page.
        const batches=ids?Array.from({length:Math.ceil(ids.length/250)},(_,i)=>ids.slice(i*250,(i+1)*250)):[null];
        for(const batch of batches) {
          let cursor='';
          do {
            const params=new URLSearchParams(batch?{isins:batch.join(',')}:{cursor});
            const cacheKey=`mf:${batch?.join(',')||'universe'}:${cursor}`;
            let result;
            try{result=await conditionalJson(`/api/mutual-funds?${params}`,{key:cacheKey,signal:AbortSignal.timeout(15000)});}
            catch(error){const saved=await readEntry(cacheKey);if(!saved?.value?.rows)throw error;result={value:saved.value};readFailed=true;}
            if(!Array.isArray(result.value?.rows))throw Error('Mutual fund response unavailable');
            rows.push(...result.value.rows);meta=result.value.meta;cursor=result.value.nextCursor||'';
          }while(cursor);
        }
        payload={rows,meta};
        if(!rows.length&&!meta?.checkedAt){payload=await revalidatedJson('data/mutual-funds/index.json');fallback=true;}
      }
      if(!Array.isArray(payload?.rows))throw Error('Mutual fund capture unavailable');
      adopt(payload,{fallback});snapshots.set(key,payload);if(!readFailed&&!fallback)writeEntry(`mf-snapshot:${key}`,{value:payload});latestMeta={...payload.meta,readFailed};return {...payload,meta:latestMeta};
    }catch(error) {
      latestMeta={...latestMeta,readFailed:true};
      if(snapshots.has(key))return {...snapshots.get(key),meta:latestMeta};
      const saved=await readEntry(`mf-snapshot:${key}`);
      if(saved?.value?.rows){adopt(saved.value,{fallback:true});snapshots.set(key,saved.value);latestMeta={...saved.value.meta,readFailed:true};return {...saved.value,meta:latestMeta};}
      try {const seed=await revalidatedJson('data/mutual-funds/index.json');adopt(seed,{fallback:true});snapshots.set(key,seed);latestMeta={...seed.meta,readFailed:true};return {...seed,meta:latestMeta};}
      catch {throw error;}
    }
  })().finally(()=>pending.delete(key));pending.set(key,promise);return promise;
}
export async function detail(isin,month=null) {
  if(!/^IN[A-Z0-9]{10}$/.test(isin || ''))throw Error('No confirmed equity identity');
  if(local()) {
    const data=await revalidatedJson(`data/mutual-funds/companies/${isin}.json`);
    return data;
  }
  const params=new URLSearchParams({isin,...(month?{month}:{})});
  try {
    const out=await conditionalJson(`/api/mutual-funds/company?${params}`,{key:`mf-detail:${isin}:${month||'latest'}`,signal:AbortSignal.timeout(15000)});
    if(out.value?.company || month){lastDetail={isin,month,payload:out.value};return out.value;}
  } catch(error) {
    // Restore the persisted response below, including older-month reads.
    // A dated seed remains readable during first rollout or an unavailable capture.
  }
  if(lastDetail?.isin===isin && lastDetail.month===month)return {...lastDetail.payload,meta:{...lastDetail.payload.meta,readFailed:true}};
  const saved=await readEntry(`mf-detail:${isin}:${month||'latest'}`);
  if(saved?.value?.company)return {...saved.value,meta:{...saved.value.meta,readFailed:true}};
  if(month)throw Error('Saved month unavailable');
  const seed=await revalidatedJson(`data/mutual-funds/companies/${isin}.json`);
  return {...seed,meta:{...seed.meta,readFailed:true}};
}
export function health(m=latestMeta,now=Date.now()) {
  if(m.readFailed)return 'Read failed · showing saved disclosures';
  if(!m.checkedAt)return 'Source checks pending';
  const age=now-Date.parse(m.checkedAt);
  if(!Number.isFinite(age)||age < -60000||age>45*60000)return 'Source checks overdue';
  const date=new Date(now);date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-1);
  const target=date.toISOString().slice(0,7);
  const total=m.amcs?.length||0,current=m.amcs?.filter(a=>a.status==='ok'&&a.month===target).length||0;
  return m.state!=='complete'||!total||current<total?`Partial coverage · ${current}/${total} AMCs reported`:'Latest reported disclosures';
}
export function researchRows(scope,holdings) {return scopedRows(scope,holdings).map(r=>({company:r.name,ticker:r.ticker,isin:r.isin,month:r.month,
  shares:r.totalShares,net:r.netChange,bought:r.addedFunds,sold:r.reducedFunds,topBuyer:r.topBuyer,topSeller:r.topSeller,pending:r.pendingFunds}));}
