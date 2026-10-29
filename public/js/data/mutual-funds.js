import {readableOwnership} from './mutual-funds-ownership.js';
import {sourceFreshness} from './mutual-funds-freshness.js';
import { conditionalJson,revalidatedJson,readEntry,readEntries,writeEntry } from '../core/store.js';
import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import { filterByScope } from './scope.js';
import {authHeaders,hostToken,onHostContext} from '../core/host-context.js';
import {boundedJson} from './family-book-contract.js';
const snapshots=new Map(), pending=new Map(), rowsByIsin=new Map();
let latestMeta={viewIncomplete:true}, lastDetail=null;
const privateRows=new Map(),privatePending=new Map(),sessionListeners=new Set(),updateListeners=new Set();
let privateMeta=null,generation=0;
export const meta=()=>({...latestMeta,...(hostToken()?privateMeta:{supplementAccess:'no-session'}),publicRevalidating:pending.size>0,revalidating:pending.size>0||privatePending.size>0});
export const all=()=>[...new Map([...rowsByIsin,...(hostToken()?privateRows:[])]).values()].map(row=>readableOwnership(row));
export const onSessionChange=fn=>{sessionListeners.add(fn);return()=>sessionListeners.delete(fn);};
export const onUpdate=fn=>{updateListeners.add(fn);return()=>updateListeners.delete(fn);};
const notify=()=>{for(const fn of updateListeners)fn();};
onHostContext((_context,changes)=>{if(changes?.session){generation++;privateRows.clear();privatePending.clear();privateMeta=null;for(const fn of sessionListeners)fn();}});
async function privateRequest(path) {
  const response=await fetch(path,{headers:{accept:'application/json',...authHeaders(path)},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){let reason='access';try{const body=await boundedJson(new Response(response.body),4096);if(['no-session','identity-unavailable','configuration-unavailable'].includes(body.reason))reason=body.reason;}catch{/* No source body is needed to reject a failed read. */}throw Object.assign(Error('Supplement unavailable'),{access:response.status===401||response.status===403,reason});}
  return boundedJson(response,5*1024*1024);
}
export async function load(scope='portfolio',options={}) {
  const result=await loadPublic(scope,options);
  if(!hostToken()||local())return result;
  const ids=[...new Set([...result.rows,...(options.holdings||coverage.holdings())].map(r=>r.isin).filter(id=>/^IN[A-Z0-9]{10}$/.test(id||'')))].sort(),key=ids.join(','),epoch=generation;
  if(!privatePending.has(key)) {
    const request=(async()=>{
      try {
        const rows=[];let supplement=null;
        for(let offset=0;offset<ids.length;offset+=250) {
          const payload=await privateRequest(`/api/mutual-funds/private?${new URLSearchParams({isins:ids.slice(offset,offset+250).join(',')})}`);
          if(!Array.isArray(payload.rows)||payload.rows.some(r=>!ids.includes(r.isin)))throw Error('Invalid supplement');
          rows.push(...payload.rows);supplement=payload.meta?.supplement;
        }
        if(epoch!==generation)return;
        for(const row of rows)privateRows.set(row.isin,row);privateMeta={supplement,supplementAccess:'ready'};
      } catch(error) {
        if(epoch!==generation)return;
        // A saved merged response must never shadow a newer primary capture.
        // Supplemental history remains on the server for the next healthy read.
        privateRows.clear();
        if(error.access){privateMeta={supplementAccess:error.reason};}
        else privateMeta={...privateMeta,supplementReadFailed:true};
      }
    })().finally(()=>{if(epoch===generation){privatePending.delete(key);notify();}});
    privatePending.set(key,request);queueMicrotask(notify);
  }
  await privatePending.get(key);
  return {...result,rows:ids.map(id=>hostToken()&&privateRows.get(id)||rowsByIsin.get(id)).filter(Boolean),meta:meta()};
}
function adopt(payload, {fallback=false}={}) {
  let changed=false;
  for(const row of payload.rows) if(!fallback || !rowsByIsin.has(row.isin)) {
    // A changed primary capture must be visible immediately, even while the
    // authenticated supplemental read is still in flight.
    if(JSON.stringify(rowsByIsin.get(row.isin))!==JSON.stringify(row)){privateRows.delete(row.isin);rowsByIsin.set(row.isin,row);changed=true;}
  }
  return changed;
}
const local=()=>['localhost','127.0.0.1'].includes(location.hostname);
export function scopedRows(scope='portfolio',holdings=coverage.holdings()) {
  const rows=all();
  if(scope==='portfolio') { const map=new Map(rows.map(r=>[r.isin,r]));return holdings.map(h=>({...map.get(h.isin),isin:h.isin,ticker:h.ticker,name:h.name,sector:h.sector,missing:!map.has(h.isin),checking:!map.has(h.isin)&&(pending.size>0||privatePending.size>0)})); }
  const scoped=filterByScope(rows,scope,holdings);
  if(scope==='watchlist'){const byTicker=new Map(scoped.map(r=>[r.ticker,r]));return watchlist.all().map(h=>byTicker.get(h.ticker)||{ticker:h.ticker,name:h.name||h.ticker,missing:true,checking:pending.size>0||privatePending.size>0});}
  return scoped;
}
async function restorePublic(key,ids) {
  const name=`mf-snapshot:${key}`,universe='mf-snapshot:universe';
  const saved=snapshots.has('universe')?null:await readEntries([...new Set([name,universe])]);
  if(snapshots.has(key))return; // A late disk read cannot roll back a fresh response.
  const value=snapshots.get('universe')||saved?.get(name)?.value||saved?.get(universe)?.value;
  if(!Array.isArray(value?.rows))return;
  const wanted=ids&&new Set(ids),payload=wanted?{...value,rows:value.rows.filter(row=>wanted.has(row.isin))}:value;
  adopt(payload,{fallback:true});snapshots.set(key,payload);
  latestMeta={...(!latestMeta.checkedAt?{...payload.meta,origin:'store'}:latestMeta),viewIncomplete:!!latestMeta.readFailed};
  notify();
}
function loadPublic(scope='portfolio', {holdings=coverage.holdings(),refresh=true}={}) {
  const ids=scope==='portfolio'?[...new Set(holdings.map(h=>h.isin).filter(id=>/^IN[A-Z0-9]{10}$/.test(id)))].sort():null;
  const key=ids?ids.join(','):'universe';
  if(pending.has(key))return pending.get(key);
  if(!refresh&&snapshots.has(key))return Promise.resolve(snapshots.get(key));
  // Disk restoration and revalidation start independently. Slow/blocked IndexedDB
  // must not put its six-second open deadline in front of the network request.
  if(!snapshots.has(key))void restorePublic(key,ids);
  const promise=(async()=>{
    try {
      let payload,fallback=false,readFailed=false;
      if(local()) payload=await revalidatedJson('data/mutual-funds/index.json');
      else {
        const rows=[];let meta={},walkId=null;
        const batches=ids?Array.from({length:Math.ceil(ids.length/250)},(_,i)=>ids.slice(i*250,(i+1)*250)):[null];
        for(const batch of batches) {
          let cursor='';const seen=new Set();
          do {
            if(seen.has(cursor))throw Error('Mutual fund pagination repeated');seen.add(cursor);
            const params=new URLSearchParams(batch?{isins:batch.join(',')}:{cursor});
            const cacheKey=`mf:${batch?.join(',')||'universe'}:${cursor}`;
            const validate=value=>{
              if(!Array.isArray(value?.rows)||value.rows.length>250||value.rows.some(row=>!/^IN[A-Z0-9]{10}$/.test(row?.isin||'')||batch&&!batch.includes(row.isin))||new Set(value.rows.map(row=>row.isin)).size!==value.rows.length)throw Error('Invalid mutual fund page');
              if(value.nextCursor&&(batch||!value.rows.some(row=>row.isin===value.nextCursor)||cursor&&value.nextCursor<=cursor))throw Error('Invalid mutual fund cursor');
            };
            let result;
            try{result=await conditionalJson(`/api/mutual-funds?${params}`,{key:cacheKey,cacheWaitMs:40,validate,signal:AbortSignal.timeout(15000)});}
            catch(error){const saved=await readEntry(cacheKey,{waitMs:40});if(!saved?.value?.rows)throw error;result={value:saved.value};readFailed=true;}
            validate(result.value);
            const saved=snapshots.get(key)||snapshots.get('universe'),snapshotId=result.value.meta?.publicSnapshotId;
            if(walkId&&snapshotId!==walkId)throw Error('Mutual fund publication changed during the read');
            if(snapshotId)walkId=snapshotId;
            // The prepared file digest covers the ENTIRE public index. One probe
            // can validate a complete saved view without downloading every page.
            if(!readFailed&&/^[a-f0-9]{64}$/.test(snapshotId||'')&&saved?.meta?.publicSnapshotId===snapshotId) {
              const wanted=ids&&new Set(ids),reused={rows:wanted?saved.rows.filter(row=>wanted.has(row.isin)):saved.rows,meta:result.value.meta};
              adopt(reused);snapshots.set(key,reused);void writeEntry(`mf-snapshot:${key}`,{value:reused});
              latestMeta={...reused.meta,readFailed:false,viewIncomplete:false,origin:'live'};
              return {...reused,meta:latestMeta};
            }
            rows.push(...result.value.rows);meta=result.value.meta;cursor=result.value.nextCursor||'';
            const changed=adopt(result.value);
            latestMeta={...meta,readFailed,origin:readFailed?'store':'live',viewIncomplete:!snapshots.has(key)};
            if(changed)notify(); // Show each verified page without waiting for later pages or private reads.
          }while(cursor);
        }
        payload={rows,meta};
        if(!rows.length&&!meta?.checkedAt){payload=await revalidatedJson('data/mutual-funds/index.json');fallback=true;}
      }
      if(!Array.isArray(payload?.rows))throw Error('Mutual fund capture unavailable');
      adopt(payload,{fallback});
      if(!fallback){snapshots.set(key,payload);if(!readFailed)void writeEntry(`mf-snapshot:${key}`,{value:payload});}
      latestMeta={...payload.meta,readFailed,viewIncomplete:fallback,origin:readFailed?'store':fallback||local()?'snapshot':'live'};
      return {...payload,meta:latestMeta};
    }catch(error) {
      // A failed walk may have adopted a newer first page over an older complete
      // cache. Keep those readings, but never export that unverified mixture.
      latestMeta={...latestMeta,readFailed:true,viewIncomplete:true};
      if(snapshots.has(key))return {...snapshots.get(key),meta:latestMeta};
      // Successfully read pages stay visible after a later failure. Do not
      // describe an incomplete first visit as a complete saved universe.
      if(rowsByIsin.size){const wanted=ids&&new Set(ids);return {rows:[...rowsByIsin.values()].filter(row=>!wanted||wanted.has(row.isin)),meta:latestMeta};}
      try {const {value:seed}=await conditionalJson('data/mutual-funds/index.json',{key:'mf:legacy-seed',cacheWaitMs:40});adopt(seed,{fallback:true});latestMeta={...seed.meta,readFailed:true,viewIncomplete:true};return {...seed,meta:latestMeta};}
      catch {throw error;}
    }
  })().finally(()=>{pending.delete(key);notify();});pending.set(key,promise);queueMicrotask(notify);return promise;
}
export async function detail(isin,month=null) {
  if(hostToken()&&!local()) {
    const epoch=generation;
    try {
      const payload=await privateRequest(`/api/mutual-funds/private/company?${new URLSearchParams({isin,...(month?{month}:{})})}`);
      if(epoch!==generation)throw Error('Session changed');
      if(payload.company?.isin===isin)return {...payload,company:readableOwnership(payload.company)};
    } catch(error) {
      if(epoch!==generation)throw Error('Session changed');
      privateRows.clear();
      privateMeta=error.access?{supplementAccess:error.reason}:{...privateMeta,supplementReadFailed:true};
    }
  }
  const result=await detailPublic(isin,month);
  return {...result,company:result.company?readableOwnership(result.company):null,meta:{...result.meta,...(hostToken()?privateMeta:{supplementAccess:'no-session'})}};
}
async function detailPublic(isin,month=null) {
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
export function health(m=meta(),now=Date.now()) {
  if(m.readFailed)return 'Read failed · showing saved disclosures';
  if(m.amcs?.length) {
    const h=sourceFreshness(m,now);
    if(h.state==='stale')return 'Source checks overdue';
    return h.state==='partial'?`Partial coverage · ${h.currentAmcs}/${h.totalAmcs} AMCs reported`:'Latest reported disclosures';
  }
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
