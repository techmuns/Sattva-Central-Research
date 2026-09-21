import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectorClient } from './collect-mutual-funds.mjs';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
import { parseScannerCatalogue,parseScannerStock,scannerStockUrl } from './lib/mutual-funds-scanner.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
export async function scannerFetch(url,{fetcher=fetch}={}) {
  if(!/^https:\/\/mfscanner\.com\/(?:stock\/[a-z0-9-]+)?$/.test(url))throw Error('Unexpected source URL');
  let response;
  try { response=await fetcher(url,{headers:{accept:'text/html','user-agent':'SattvaResearch/1.0 (+https://github.com/techmuns/Sattva-Central-Research)'},redirect:'manual',signal:AbortSignal.timeout(30000)}); }
  catch {return {failure:'timeout'};}
  if(!response.ok) {
    await response.body?.cancel();
    const retry=response.headers.get('retry-after'),seconds=Number(retry);
    return {failure:response.status===403?'http-403':response.status===429?'http-429':'http-error',retryAfterMs:retry?(Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(retry)-Date.now())):null};
  }
  if(!/text\/html/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>8*1024*1024){await response.body?.cancel();return {failure:'invalid-page'};}
  const reader=response.body.getReader(),chunks=[];let length=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8*1024*1024)throw Error('Source page too large');chunks.push(value);}}
  catch {await reader.cancel().catch(()=>{});return {failure:'invalid-page'};}
  finally{reader.releaseLock();}
  return {html:Buffer.concat(chunks).toString('utf8')};
}
export async function collectScanner({client=collectorClient(),fetcher=fetch,sleep=pause,now=Date.now,companies,maxRequests=180}={}) {
  await client({action:'scanner-inventory',companies});
  let requestId=0,catalogue=null,completed=0,failed=0;
  const reserve=async kind=>{
    const id=String(++requestId);
    for(;;){const r=await client({action:'scanner-reserve',requestId:id,kind});if(r.waitUntil&&r.reason==='spacing'){await sleep(Math.min(3000,Math.max(1,r.waitUntil-now())));continue;}return r;}
  };
  const catalog=await reserve('catalogue');
  if(catalog.catalogue)catalogue=catalog.catalogue;
  else if(catalog.reservation) {
    const fetched=await scannerFetch(catalog.url,{fetcher});
    if(!fetched.failure){try{catalogue=parseScannerCatalogue(fetched.html);}catch{fetched.failure='invalid-page';}}
    await client({action:'scanner-complete',input:{reservation:catalog.reservation,catalogue,failure:fetched.failure||null,retryAfterMs:fetched.retryAfterMs}});
    if(fetched.failure) {
      if(['http-403','http-429'].includes(fetched.failure)||!catalog.savedCatalogue)return {completed,failed:1,reason:fetched.failure};
      catalogue=catalog.savedCatalogue;failed++;
    }
  } else return {completed,failed,reason:catalog.reason};
  for(let i=0;i<Math.min(maxRequests,companies.length);i++) {
    const task=await reserve('stock');if(!task.reservation)break;
    const {company,reservation}=task,url=task.url||scannerStockUrl(catalogue,company);
    if(!url){await client({action:'scanner-complete',input:{reservation,isin:company.isin,failure:'unmatched'}});failed++;continue;}
    const fetched=await scannerFetch(url,{fetcher});let page=null;
    if(!fetched.failure){try{page=parseScannerStock(fetched.html,{isin:company.isin,url,now:now(),checkedAt:new Date(now()).toISOString()});}catch{fetched.failure='invalid-page';}}
    await client({action:'scanner-complete',input:{reservation,isin:company.isin,page,failure:fetched.failure||null,retryAfterMs:fetched.retryAfterMs}});
    if(fetched.failure)failed++;else completed++;
    if(['http-403','http-429'].includes(fetched.failure))break;
  }
  return {completed,failed};
}
export const scannerCaptureHealthy=(result,status)=>!result.failed&&status?.expectedCompanies>0&&status.currentCompanies===status.expectedCompanies&&!['source-cooldown','in-flight','reservation-expired'].includes(result.reason);
async function main() {
  const book=await loadActivePortfolio('public/data/portfolio-companies.json',{live:true});
  const identities=Object.values(JSON.parse(fs.readFileSync('public/data/exchange-deals.json')).securityMap||{});
  const companies=book.holdings.filter(h=>/^IN[A-Z0-9]{10}$/.test(h.isin||'')).map(h=>({isin:h.isin,name:h.name,ticker:h.ticker,aliases:[h.matchedName,h.bookName,...identities.filter(c=>c.isin===h.isin).map(c=>c.name)].filter(Boolean)}));
  const client=collectorClient(),result=await collectScanner({companies,client});
  const status=(await client({action:'scanner-status'})).supplement;
  // Counts only: this public repository's workflow logs/artifacts must not
  // publish source pages, scheme observations, or the private portfolio.
  console.log(`MF Scanner: ${result.completed} pages saved; ${result.failed} pages unavailable${result.reason?`; ${result.reason}`:''}.`);
  if(!scannerCaptureHealthy(result,status)) {
    console.error(`MF Scanner coverage incomplete: ${status?.currentCompanies||0}/${status?.expectedCompanies||companies.length} current company pages. Saved observations remain available; the next automatic run resumes collection.`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Private MF Scanner collection interrupted; saved progress will resume automatically.');process.exitCode=1;});
