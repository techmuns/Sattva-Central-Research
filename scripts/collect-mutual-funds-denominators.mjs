import fs from 'node:fs';
import path from 'node:path';
import {HEADERS} from '../worker/nse-ann.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {loadActivePortfolio} from './lib/active-portfolio.mjs';
import {atomicJson} from './lib/mutual-funds-files.mjs';
const book=await loadActivePortfolio('public/data/portfolio-companies.json');
const source=path.join(process.env.AMFIBEAS_PATH,'src/data/portfolio-tracker/shares-outstanding.json');
const estimates=JSON.parse(fs.readFileSync(source)).companies||{},denominators={};
for(const h of book.holdings) {
  const e=estimates[h.isin];
  if(e?.sharesOutstanding>0&&Number.isSafeInteger(e.sharesOutstanding))denominators[h.isin]={shares:e.sharesOutstanding,checkedAt:e.asOf,asOf:e.asOf,source:e.source,kind:'estimate',method:'Market capitalization divided by quoted price; rounded source values'};
}
fs.mkdirSync('artifacts',{recursive:true});
const save=()=>atomicJson('artifacts/mutual-funds-denominators.json',denominators);
save();
// Source denials are respected. A denied NSE session is not retried under another identity.
for(const h of book.holdings.filter(h=>h.ticker)) {
  try {
    const url=`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(h.ticker)}`;
    const response=await fetch(url,{headers:HEADERS,redirect:'error',signal:AbortSignal.timeout(12000)});
    if([401,403,429].includes(response.status)){await response.body?.cancel();break;}
    const data=await boundedJson(response,1024*1024),shares=Number(data.securityInfo?.issuedSize);
    if(data.info?.isin===h.isin&&Number.isSafeInteger(shares)&&shares>0){denominators[h.isin]={shares,checkedAt:new Date().toISOString(),asOf:data.metadata?.lastUpdateTime||null,source:url,kind:'exchange',method:'NSE issued shares, exact ISIN match'};save();}
  }catch{/* A failed denominator read cannot invent a value. */}
  await new Promise(done=>setTimeout(done,200));
}
save();
console.log(`${Object.values(denominators).filter(d=>d.kind==='exchange').length} exchange denominators; ${Object.values(denominators).filter(d=>d.kind==='estimate').length} explicitly labelled estimates`);
