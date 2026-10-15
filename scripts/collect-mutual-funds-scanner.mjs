import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectorClient } from './collect-mutual-funds.mjs';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';
import { parseScannerCatalogue,parseScannerStock,scannerStockUrl,scannerFailureReason } from './lib/mutual-funds-scanner.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
export async function scannerFetch(url,{fetcher=fetch}={}) {
  if(!/^https:\/\/mfscanner\.com\/(?:stock\/[a-z0-9-]+)?$/.test(url))throw Error('Unexpected source URL');
  let response;
  try { response=await fetcher(url,{headers:{accept:'text/html','user-agent':'SattvaResearch/1.0 (+https://github.com/techmuns/Sattva-Central-Research)'},redirect:'manual',signal:AbortSignal.timeout(30000)}); }
  catch(error) {return {failure:'timeout',failureReason:error?.name==='TimeoutError'||error?.name==='AbortError'?'request-timeout':'transport-error'};}
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
export async function collectScanner({client=collectorClient(),fetcher=fetch,sleep=pause,now=Date.now,companies,maxRequests=180,maxDurationMs=20*60000}={}) {
  const deadline=now()+maxDurationMs;
  await client({action:'scanner-inventory',companies});
  let requestId=0,catalogue=null,completed=0,failed=0,reason=null;const failures={},failureReasons={},periods={},partialPages={pending:0,unknownAmcs:0};
  const result=()=>({completed,failed,failures,failureReasons,periods,partialPages,reason});
  const recordFailure=(kind,detail)=>{failed++;failures[kind]=(failures[kind]||0)+1;if(detail)failureReasons[detail]=(failureReasons[detail]||0)+1;};
  const reserve=async kind=>{
    const id=String(++requestId);
    for(;;){if(now()>=deadline){reason='capture-window';return {reason};}const r=await client({action:'scanner-reserve',requestId:id,kind});if(r.waitUntil&&r.reason==='spacing'){await sleep(Math.min(3000,Math.max(1,r.waitUntil-now())));continue;}return r;}
  };
  const catalog=await reserve('catalogue');
  if(catalog.catalogue)catalogue=catalog.catalogue;
  else if(catalog.reservation) {
    const fetched=await scannerFetch(catalog.url,{fetcher});
    if(!fetched.failure){try{catalogue=parseScannerCatalogue(fetched.html);}catch(error){fetched.failure='invalid-page';fetched.failureReason=scannerFailureReason(error);}}
    await client({action:'scanner-complete',input:{reservation:catalog.reservation,catalogue,failure:fetched.failure||null,retryAfterMs:fetched.retryAfterMs,failureReason:fetched.failureReason}});
    if(fetched.failure) {
      recordFailure(fetched.failure,fetched.failureReason);
      if(['http-403','http-429'].includes(fetched.failure)||!catalog.savedCatalogue){reason=fetched.failure;return result();}
      catalogue=catalog.savedCatalogue;
    }
  } else {reason=catalog.reason;return result();}
  for(let i=0;i<Math.min(maxRequests,companies.length);i++) {
    const task=await reserve('stock');if(!task.reservation)break;
    const {company,reservation}=task,url=task.url||scannerStockUrl(catalogue,company);
    if(!url){await client({action:'scanner-complete',input:{reservation,isin:company.isin,failure:'unmatched'}});recordFailure('unmatched');continue;}
    const fetched=await scannerFetch(url,{fetcher});let page=null;
    if(!fetched.failure){try{page=parseScannerStock(fetched.html,{isin:company.isin,url,now:now(),checkedAt:new Date(now()).toISOString()});}catch(error){fetched.failure='invalid-page';fetched.failureReason=scannerFailureReason(error);}}
    await client({action:'scanner-complete',input:{reservation,isin:company.isin,page,failure:fetched.failure||null,retryAfterMs:fetched.retryAfterMs,failureReason:fetched.failureReason}});
    if(fetched.failure)recordFailure(fetched.failure,fetched.failureReason);else {completed++;periods[page.month]=(periods[page.month]||0)+1;if(page.unreportedFunds)partialPages.pending++;if(page.unknownAmcs)partialPages.unknownAmcs++;}
    if(['http-403','http-429'].includes(fetched.failure)){reason=fetched.failure;break;}
  }
  return result();
}
export const scannerCaptureHealthy=(result,status)=>!result.failed&&status?.expectedCompanies>0&&status.currentCompanies===status.expectedCompanies&&!['source-cooldown','in-flight','reservation-expired','capture-window'].includes(result.reason);
async function main() {
  const book=await loadActivePortfolio('public/data/portfolio-companies.json',{live:true});
  const identities=Object.values(JSON.parse(fs.readFileSync('public/data/exchange-deals.json')).securityMap||{});
  const companies=book.holdings.filter(h=>/^IN[A-Z0-9]{10}$/.test(h.isin||'')).map(h=>({isin:h.isin,name:h.name,ticker:h.ticker,aliases:[h.matchedName,h.bookName,...identities.filter(c=>c.isin===h.isin).map(c=>c.name)].filter(Boolean)}));
  const client=collectorClient(),result=await collectScanner({companies,client});
  const status=(await client({action:'scanner-status'})).supplement;
  // Counts only: this public repository's workflow logs/artifacts must not
  // publish source pages, scheme observations, or the private portfolio.
  console.log(`MF Scanner: ${result.completed} pages saved; ${result.failed} pages unavailable${result.reason?`; ${result.reason}`:''}.`);
  if(result.failures&&Object.keys(result.failures).length)console.log(`Failure counts: ${JSON.stringify(result.failures)}`);
  console.log(`Observed source periods: ${JSON.stringify(result.periods||{})}; partial pages: ${JSON.stringify(result.partialPages||{})}; validation reasons: ${JSON.stringify(result.failureReasons||{})}.`);
  if(status?.cooldownUntil>Date.now())console.log(`Source access paused until ${new Date(status.cooldownUntil).toISOString()}; saved progress is retained.`);
  if(!scannerCaptureHealthy(result,status)) {
    console.error(`MF Scanner coverage incomplete: ${status?.currentCompanies||0}/${status?.expectedCompanies||companies.length} current company pages. Saved observations remain available; the next automatic run resumes collection.`);
    process.exitCode=1;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Private MF Scanner collection interrupted; saved progress will resume automatically.');process.exitCode=1;});
