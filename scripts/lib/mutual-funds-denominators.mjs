import {boundedJson} from '../../public/js/data/family-book-contract.js';
import {freshShareCount,selectShareCount} from '../../public/js/data/mutual-funds-ownership.js';
import {HEADERS} from '../../worker/nse-ann.mjs';
const DAY=86400000;
// Moneycontrol also sends exact counts in scientific notation (9.07065126E+9).
// Parse decimal digits before converting so fractional/unsafe values cannot round into integers.
function integer(value) {
  if(typeof value==='number')return Number.isSafeInteger(value)?value:null;
  if(typeof value!=='string'||value.length>50)return null;
  const m=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value.trim());
  if(!m)return null;
  const shift=Number(m[3]||0)-(m[2]||'').length;
  if(Math.abs(shift)>30)return null;
  let digits=m[1]+(m[2]||'');
  if(shift<0){if(digits.length<=-shift||!digits.endsWith('0'.repeat(-shift)))return null;digits=digits.slice(0,shift);}
  else digits+='0'.repeat(shift);
  const count=BigInt(digits);
  return count<=BigInt(Number.MAX_SAFE_INTEGER)?Number(count):null;
}
const iso=value=>Number.isFinite(value)?new Date(value).toISOString():null;
export function nseShareCount(data,company,checkedAt,url) {
  const shares=integer(data?.securityInfo?.issuedSize);
  if(data?.info?.isin!==company.isin || !Number.isSafeInteger(shares) || shares<=0)return null;
  const stamp=data.metadata?.lastUpdateTime;
  // The exchange timestamp has no zone; it is India time, not runner-local time.
  const match=/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(stamp||'');
  const month=match?['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].toLowerCase())+1:0;
  const quoteAt=month?iso(Date.parse(`${match[3]}-${String(month).padStart(2,'0')}-${match[1]}T${match[4]}+05:30`)):null;
  const value={shares,checkedAt,asOf:null,quoteAt,source:url,sourceName:'NSE',kind:'exchange',method:'Issued shares reported by NSE'};
  return quoteAt&&freshShareCount(value,Date.parse(checkedAt))?value:null;
}
export function moneycontrolShareCount(body,company,checkedAt,url) {
  const d=body?.data,shares=integer(d?.SHRS),epoch=Number(d?.lastupd_epoch);
  if(String(body?.code)!=='200' || d?.isinid!==company.isin || !Number.isSafeInteger(shares) || shares<=0 || !Number.isFinite(epoch) || epoch<=0)return null;
  const value={shares,checkedAt,asOf:null,quoteAt:iso(epoch*1000),source:url,sourceName:'Moneycontrol',kind:'reported',method:'Company share count supplied directly by Moneycontrol'};
  return freshShareCount(value,Date.parse(checkedAt))?value:null;
}
export function moneycontrolCode(company,map,identities=[]) {
  const codes=new Set(identities.filter(r=>r.isin===company.isin&&r.bseCode).map(r=>String(r.bseCode)));
  const matches=Object.entries(map).filter(([,r])=>company.ticker&&String(r.ticker).replace(/-SM$/,'')===company.ticker.replace(/-SM$/,'') || codes.has(String(r.bseId)));
  // The map is discovery only: the live response must still match the exact ISIN.
  return matches.length===1?matches[0][0]:null;
}
const MC_HEADERS={accept:'application/json','user-agent':'SattvaCentralResearch/1.0'};
const MC_CODE=/^[A-Za-z0-9]{1,16}$/;
const MC_PRICE=/^https:\/\/priceapi\.moneycontrol\.com\/pricefeed\/(?:nse|bse)\/equitycash\/([A-Za-z0-9]{1,16})$/;
// A portfolio company still without a fresh direct count is asked again after six hours rather
// than a day, so a refusal is not repeated at the same hour every day and a new holding fills in.
const GAP_RETRY=6*3600000;
// A code an earlier run already proved against this exact ISIN. Remembering it means a later
// search refusal cannot take away a count that was working.
export function provenMoneycontrolCode(denominator) {
  if(denominator?.sourceName!=='Moneycontrol'||denominator.kind!=='reported')return null;
  return MC_PRICE.exec(String(denominator.source||''))?.[1]||null;
}
// Moneycontrol's own search, asked by ISIN, finds companies the results map never saw (new
// listings, SME, demerged and symbol-less holdings). Discovery only: exactly one code must name
// this ISIN, and the price response is still checked against the ISIN before a count is used.
export function moneycontrolSearchCode(body,isin) {
  if(!Array.isArray(body)||!/^[A-Z0-9]{12}$/.test(isin||''))return null;
  const named=new RegExp(`(?:^|[^A-Z0-9])${isin}(?:[^A-Z0-9]|$)`);
  const codes=new Set(body.filter(r=>named.test(String(r?.pdt_dis_nm||''))&&MC_CODE.test(String(r?.sc_id||''))).map(r=>String(r.sc_id)));
  return codes.size===1?[...codes][0]:null;
}
export async function collectShareCounts({companies,portfolioIsins=[],previous={},checks={},estimates={},map={},identities=[],fetcher=fetch,now=Date.now,pause=ms=>new Promise(done=>setTimeout(done,ms)),save=()=>{},maxCompanies=200,maxDurationMs=240000}={}) {
  const started=now(),denominators={...previous},sourceChecks={...checks},blocked=new Set();
  for(const [isin,e] of Object.entries(estimates)) {
    const estimate={shares:e.sharesOutstanding,checkedAt:e.asOf,asOf:e.asOf,source:e.source,sourceName:'Screener via AmfiBeas',kind:'estimate',method:'Market capitalization divided by quoted price; rounded source values'};
    denominators[isin]=selectShareCount(denominators[isin],estimate,now());
  }
  const wanted=new Set(portfolioIsins),last=c=>Date.parse(sourceChecks[c.isin]?.lastAttemptAt)||0;
  const direct=c=>freshShareCount(denominators[c.isin],now())&&denominators[c.isin].kind!=='estimate';
  const interval=c=>wanted.has(c.isin)&&!direct(c)?GAP_RETRY:DAY;
  const due=companies.filter(c=>!last(c)||now()-last(c)>=interval(c)||last(c)>now()+60000)
    .sort((a,b)=>Number(wanted.has(b.isin))-Number(wanted.has(a.isin)) || last(a)-last(b) || a.isin.localeCompare(b.isin));
  const checkpoint=()=>save({denominators,checks:sourceChecks});
  checkpoint();let attempted=0,discovered=0;
  for(const c of due) {
    if(attempted>=maxCompanies || now()-started>=maxDurationMs)break;
    const checkedAt=new Date(now()).toISOString(),sources=[],tried=new Set();let count=null;
    const read=async route=>{
      if(blocked.has(route.name)){sources.push({source:route.name,state:'source-unavailable'});return null;}
      try {
        const r=await fetcher(route.url,{headers:route.headers,redirect:'error',signal:AbortSignal.timeout(8000)});
        if([401,403,429].includes(r.status)){await r.body?.cancel();blocked.add(route.name);sources.push({source:route.name,state:`http-${r.status}`});return null;}
        const value=route.parse(await boundedJson(r,1024*1024),c,checkedAt,route.url);
        sources.push({source:route.name,state:value?'ok':route.miss||'invalid-or-stale'});
        return value;
      }catch{sources.push({source:route.name,state:'unavailable'});return null;}
    };
    // The listing exchange is asked first; the other answers a symbol-less NSE-only listing or a
    // stale first quote. Only an answered-but-unusable reply earns the second request.
    const quote=async code=>{
      tried.add(code);
      for(const exchange of c.ticker?['nse','bse']:['bse','nse']) {
        const value=await read({name:'Moneycontrol',url:`https://priceapi.moneycontrol.com/pricefeed/${exchange}/equitycash/${encodeURIComponent(code)}`,parse:moneycontrolShareCount,headers:MC_HEADERS});
        if(value||sources.at(-1).state!=='invalid-or-stale')return value;
      }
      return null;
    };
    if(c.ticker)count=await read({name:'NSE',url:`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(c.ticker)}`,parse:nseShareCount,headers:HEADERS});
    for(const code of [moneycontrolCode(c,map,identities),provenMoneycontrolCode(previous[c.isin])])
      if(!count&&code&&!tried.has(code))count=await quote(code);
    // Search only when the price host answered (or was never asked): an outage is not a reason
    // to spend another request, and the next attempt asks again.
    if(!count&&!blocked.has('Moneycontrol')&&!sources.some(s=>s.source==='Moneycontrol'&&s.state==='unavailable')) {
      const code=await read({name:'Moneycontrol search',url:`https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?${new URLSearchParams({classic:'true',query:c.isin,type:'1',format:'json'})}`,parse:body=>moneycontrolSearchCode(body,c.isin),headers:MC_HEADERS,miss:'no-exact-match'});
      if(code&&!tried.has(code)&&(count=await quote(code)))discovered++;
    }
    if(count)denominators[c.isin]=selectShareCount(denominators[c.isin],count,now());
    // Attempts never freshen a retained value or the source quote timestamp.
    sourceChecks[c.isin]={lastAttemptAt:checkedAt,state:count?'ok':'unavailable',sources};
    attempted++;checkpoint();await pause(150);
  }
  return {denominators,checks:sourceChecks,attempted,discovered,deferred:due.length-attempted};
}
