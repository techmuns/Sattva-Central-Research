// Prepared public research only. This reader never scores companies or starts a collector.
import {filterByScope} from './scope.js';
import {readEntry,writeEntry} from '../core/store.js';

export const POLL_MS = 5 * 60_000;
export function validateRecommendations(value) {
  if (value?.version !== 1 || value?.stage !== 'research-candidates' || !Array.isArray(value.rows) || value.rowCount !== value.rows.length ||
      !Number.isFinite(Date.parse(value.generatedAt)) || value.rows.some(r => !r.id || !r.isin || !r.ticker || !r.company || !r.catalyst ||
        !Number.isFinite(Number(r.price)) || Number(r.price) <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(r.priceAsOf || '')) ||
      new Set(value.rows.map(r=>r.isin)).size !== value.rows.length) throw Error('Invalid recommendation publication');
  return value;
}

export function createRecommendationFeed({fetcher=fetch,now=Date.now,readSaved=()=>readEntry('ai-recommendations:v1'),save=value=>writeEntry('ai-recommendations:v1',{value})}={}) {
  let held=null, checking=null, checkedAt=null, error=null, etag=null;
  const listeners=new Set();
  const emit=()=>listeners.forEach(fn=>{try{fn();}catch{}});
  let restoring=null;
  const restore=()=>restoring||=(async()=>{try{const saved=await readSaved();if(!held&&saved?.value){held=validateRecommendations(saved.value);emit();}}catch{}})();
  async function refresh() {
    if (checking) return checking;
    checking=Promise.resolve().then(async()=>{
      await restore();
      try {
        const response=await fetcher('/data/ai-recommendations.json',{cache:'no-store',headers:etag?{'If-None-Match':etag}:{},signal:AbortSignal.timeout(25000)});
        if (response.status===304 && held) {checkedAt=new Date(now()).toISOString();error=null;return {checked:1,total:held.rows.length};}
        if (!response.ok) throw Error(`Prepared recommendations unavailable (${response.status})`);
        const text=await response.text();if(text.length>8*1024*1024)throw Error('Recommendation publication exceeds reader budget');
        const next=validateRecommendations(JSON.parse(text));
        if (held && Date.parse(next.generatedAt)<Date.parse(held.generatedAt)) throw Error('Older recommendation publication');
        const before=new Set((held?.rows||[]).map(r=>r.id));
        held=next;etag=response.headers.get('etag');checkedAt=new Date(now()).toISOString();error=null;
        try{await save(held);}catch{}
        return {checked:1,total:held.rows.length,added:held.rows.filter(r=>!before.has(r.id)).length};
      } catch (e) {error=e.message;return {checked:0,failed:1,total:held?.rows.length||0};}
    }).finally(()=>{checking=null;emit();});
    return checking;
  }
  return {refresh,load:async()=>{await restore();if(!held)await refresh();return held;},rows:()=>held?.rows||[],forScope:scope=>filterByScope(held?.rows||[],scope),
    meta:()=>({...held,rows:undefined,checking:!!checking,browserCheckedAt:checkedAt,error,
      stale:!held || now()-Date.parse(held.generatedAt)>8*60*60_000}),
    onChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
}
export const feed=createRecommendationFeed();
export const {load,refresh,rows,forScope,meta,onChange}=feed;
