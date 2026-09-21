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
export async function collectShareCounts({companies,portfolioIsins=[],previous={},checks={},estimates={},map={},identities=[],fetcher=fetch,now=Date.now,pause=ms=>new Promise(done=>setTimeout(done,ms)),save=()=>{},maxCompanies=200,maxDurationMs=240000}={}) {
  const started=now(),denominators={...previous},sourceChecks={...checks},blocked=new Set();
  for(const [isin,e] of Object.entries(estimates)) {
    const estimate={shares:e.sharesOutstanding,checkedAt:e.asOf,asOf:e.asOf,source:e.source,sourceName:'Screener via AmfiBeas',kind:'estimate',method:'Market capitalization divided by quoted price; rounded source values'};
    denominators[isin]=selectShareCount(denominators[isin],estimate,now());
  }
  const wanted=new Set(portfolioIsins),last=c=>Date.parse(sourceChecks[c.isin]?.lastAttemptAt)||0;
  const due=companies.filter(c=>!last(c)||now()-last(c)>=DAY||last(c)>now()+60000)
    .sort((a,b)=>Number(wanted.has(b.isin))-Number(wanted.has(a.isin)) || last(a)-last(b) || a.isin.localeCompare(b.isin));
  const checkpoint=()=>save({denominators,checks:sourceChecks});
  checkpoint();let attempted=0;
  for(const c of due) {
    if(attempted>=maxCompanies || now()-started>=maxDurationMs)break;
    const checkedAt=new Date(now()).toISOString(),sources=[];let direct=null;
    const code=moneycontrolCode(c,map,identities);
    const routes=[...(c.ticker?[{name:'NSE',url:`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(c.ticker)}`,parse:nseShareCount,headers:HEADERS}]:[]),
      ...(code?[{name:'Moneycontrol',url:`https://priceapi.moneycontrol.com/pricefeed/${c.ticker?'nse':'bse'}/equitycash/${encodeURIComponent(code)}`,parse:moneycontrolShareCount,headers:{accept:'application/json','user-agent':'SattvaCentralResearch/1.0'}}]:[])];
    for(const route of routes) {
      if(blocked.has(route.name)){sources.push({source:route.name,state:'source-unavailable'});continue;}
      try {
        const r=await fetcher(route.url,{headers:route.headers,redirect:'error',signal:AbortSignal.timeout(8000)});
        if([401,403,429].includes(r.status)){await r.body?.cancel();blocked.add(route.name);sources.push({source:route.name,state:`http-${r.status}`});continue;}
        direct=route.parse(await boundedJson(r,1024*1024),c,checkedAt,route.url);
        sources.push({source:route.name,state:direct?'ok':'invalid-or-stale'});
        if(direct)break;
      }catch{sources.push({source:route.name,state:'unavailable'});}
    }
    if(direct)denominators[c.isin]=selectShareCount(denominators[c.isin],direct,now());
    // Attempts never freshen a retained value or the source quote timestamp.
    sourceChecks[c.isin]={lastAttemptAt:checkedAt,state:direct?'ok':'unavailable',sources};
    attempted++;checkpoint();await pause(150);
  }
  return {denominators,checks:sourceChecks,attempted,deferred:due.length-attempted};
}
