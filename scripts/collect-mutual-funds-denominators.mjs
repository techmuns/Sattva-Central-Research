import fs from 'node:fs';
import path from 'node:path';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {loadActivePortfolio} from './lib/active-portfolio.mjs';
import {atomicJson} from './lib/mutual-funds-files.mjs';
import {collectShareCounts} from './lib/mutual-funds-denominators.mjs';
import {freshShareCount} from '../public/js/data/mutual-funds-ownership.js';
import {MF_ORIGIN,validIsin} from '../worker/mutual-funds-model.mjs';
const book=await loadActivePortfolio('public/data/portfolio-companies.json');
const read=(file,fallback)=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):fallback;
const source=path.join(process.env.AMFIBEAS_PATH||'/tmp/sattva-amfibeas-source','src/data/portfolio-tracker/shares-outstanding.json');
const estimates=read(source,{}).companies||{},previous={},checks={},companies=new Map();
// Resume the oldest unchecked company across automatic runs, including Universe.
let cursor='';const seen=new Set();
do {
  if(seen.has(cursor))throw Error('Repeated ownership cursor');seen.add(cursor);
  const r=await boundedJson(await fetch(`${MF_ORIGIN}/api/mutual-funds?${new URLSearchParams({cursor})}`,{signal:AbortSignal.timeout(15000),redirect:'error'}),3*1024*1024);
  if(!Array.isArray(r.rows))throw Error('Ownership inventory unavailable');
  for(const row of r.rows)if(validIsin(row.isin)){companies.set(row.isin,row);previous[row.isin]=row.denominator;checks[row.isin]=row.shareCountCheck;}
  cursor=r.nextCursor||'';
}while(cursor);
for(const h of book.holdings)if(validIsin(h.isin))companies.set(h.isin,h);
fs.mkdirSync('artifacts',{recursive:true});
const result=await collectShareCounts({companies:[...companies.values()],portfolioIsins:book.holdings.map(h=>h.isin),previous,checks,estimates,
  map:read('public/data/mc-ticker-map.json',{}).map||{},identities:Object.entries(read('public/data/exchange-deals.json',{}).securityMap||{}).map(([bseCode,r])=>({...r,bseCode})),
  save:({denominators,checks})=>{atomicJson('artifacts/mutual-funds-denominators.json',denominators);atomicJson('artifacts/mutual-funds-share-count-checks.json',checks);}});
// Counts only: a portfolio line that keeps missing a direct count is visible in every run's log.
const lines=book.holdings.filter(h=>validIsin(h.isin)),missing=lines.filter(h=>{const d=result.denominators[h.isin];return !(d&&d.kind!=='estimate'&&freshShareCount(d));}).length;
console.log(`Company share counts: ${result.attempted} checked; ${result.discovered} codes found by ISIN; ${result.deferred} resume on the next automatic run. Portfolio lines without a fresh direct count: ${missing} of ${lines.length}.`);
