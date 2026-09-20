// Runs under AmfiBeas's pinned tsx runtime in an isolated checkout. Only its public,
// first-party HTTP adapters are used; no browser challenge or archive proxy tier.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {STATUTORY_PAGES,statutoryLinks} from './lib/mutual-funds-discovery.mjs';
import {atomicJson,runSourcePool} from './lib/mutual-funds-source-pool.mjs';
import {QUANTUM_PAGE,quantumDisclosures,parseQuantumWorkbook} from './lib/mutual-funds-quantum.mjs';
import {PUBLIC_PAGES,publicReader,publicDisclosures,readDisclosures,resumeDisclosures,schemeNameResolver,parsePublicWorkbook} from './lib/mutual-funds-public.mjs';
import {reconcileSourceChecks} from './lib/mutual-funds-checks.mjs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MF_ORIGIN,monthKey,targetMonth} from '../worker/mutual-funds-model.mjs';
import * as familyContract from '../public/js/data/family-book-contract.js';
const boundedJson=familyContract.boundedJson||familyContract.default?.boundedJson;
const root=path.resolve(process.env.AMFIBEAS_PATH||'');
if(!process.env.AMFIBEAS_PATH)throw Error('AMFIBEAS_PATH required');
const opts={pctScale:1,valueToCr:100},dir=path.join(root,'public/amc-holdings');
const index=JSON.parse(fs.readFileSync(path.join(dir,'index.json')));
const selected=process.env.MF_SOURCE_AMCS?.split(',').filter(Boolean),checksFile=process.env.MF_SOURCE_CHECK_FILE||path.join(dir,'sattva-checks.json');
const previousChecks=fs.existsSync(checksFile)?JSON.parse(fs.readFileSync(checksFile)):[];
const checks=selected?previousChecks.filter(c=>!selected.includes(c.slug)):[];
if(!process.env.MF_SOURCE_WORKER) {
  // Only a compact continuation URL is retained in coverage. Read that manifest
  // before starting sources so a fresh scheduled runner resumes the unfinished
  // tail; no extra holdings payload or browser-triggered collection is needed.
  let initial=previousChecks;
  if(process.env.MF_RESUME_LIVE==='true') {
    try{const prior=await boundedJson(await fetch(`${MF_ORIGIN}/api/mutual-funds?isins=`,{redirect:'error',signal:AbortSignal.timeout(20000)}),1024*1024);if(Array.isArray(prior.meta?.amcs))initial=prior.meta.amcs;}
    catch{console.warn('Previous source progress unavailable; retained local progress will be used.');}
  }
  const result=await runSourcePool(index.amcs.filter(e=>!selected||selected.includes(e.slug)),{
    command:path.join(root,'node_modules/.bin/tsx'),args:[fileURLToPath(import.meta.url)],checksFile,initial,
    onResult:c=>console.log(`${c.slug}: ${c.status} ${c.month||''}${c.reason?' '+c.reason:''}`)
  });
  if(result.interrupted)process.exitCode=1;
} else {
const importSource=file=>import(pathToFileURL(path.join(root,'scripts/ingest/amc-factsheets',file)).href);
const [{fetchLatest},{parseAmcWorkbook},{parseZip,normalizeSchemePct},{PAGE_SCRAPE_CONFIG,pageScrapeAmc,downloadAndParse},{JSON_API_CONFIG,jsonApiAmc}]=await Promise.all(['fetch.ts','parse.ts','advisorkhoj.ts','page-scrape.ts','json-api.ts'].map(importSource));
for(const entry of index.amcs) {
  if(selected&&!selected.includes(entry.slug))continue;
  const startedAt=new Date().toISOString();let result=null;
  const file=path.join(dir,entry.slug+'.json');let old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
  const priorCheck={slug:entry.slug,lastCompleteCheckedAt:old.lastCompleteCheckedAt||null,...JSON.parse(process.env.MF_SOURCE_PREVIOUS_CHECK||'null')},resolveNames=schemeNameResolver(old);
  function saveResult(result,{recordCheck=true}={}) {
    const counts=new Map();for(const s of result.schemes){const m=monthKey(s.asOf);if(m&&m<=targetMonth())counts.set(m,(counts.get(m)||0)+1);}
    const month=[...counts].sort((a,b)=>b[1]-a[1]||b[0].localeCompare(a[0]))[0]?.[0];
    if(!month)throw Error('Disclosure month unverified');
    const existing=[{asOfMonth:old.asOfMonth,schemes:old.schemes},...(old.history||[])].filter(b=>b.schemes?.length).map(b=>({...b,checkedAt:b.checkedAt||old.fetchedAt,sourceUrl:b.sourceUrl||old.sourceUrl}));
    const schemes=resolveNames(result.schemes).map(s=>({...normalizeSchemePct(s),checkedAt:startedAt,sourceUrl:s.sourceUrl||result.usedUrl||old.sourceUrl})),oldMonth=existing.find(b=>monthKey(b.asOfMonth)===month);
    const names=new Set(schemes.map(s=>s.schemeName)),missing=oldMonth?.schemes.filter(s=>!names.has(s.schemeName)&&!(/^mutual fund units$/i.test(s.schemeName)&&schemes.some(next=>next.validatedSchemeHeader&&next.schemeCode===s.schemeCode)))||[];
    const months=new Map(existing.map(b=>[monthKey(b.asOfMonth),b]));
    months.set(month,{asOfMonth:month,schemes:[...schemes,...missing.map(s=>({...s,checkedAt:s.checkedAt||oldMonth.checkedAt||old.fetchedAt,sourceUrl:s.sourceUrl||oldMonth.sourceUrl||old.sourceUrl}))],checkedAt:startedAt,sourceUrl:result.usedUrl||old.sourceUrl});
    const buckets=[...months].filter(([m])=>m).sort((a,b)=>b[0].localeCompare(a[0])).map(([,b])=>b),latest=buckets[0];
    const partial=Boolean(missing.length||result.failedFiles||result.pendingFiles);
    const saved={amc:entry.amc,amcSlug:entry.slug,asOfMonth:latest.asOfMonth,schemes:latest.schemes,sourceUrl:latest.sourceUrl||old.sourceUrl,fetchedAt:latest.checkedAt||old.fetchedAt,history:buckets.slice(1),lastCompleteCheckedAt:recordCheck&&!partial?startedAt:old.lastCompleteCheckedAt||null};
    atomicJson(file,saved);old=saved;
    if(!recordCheck)return;
    const check=reconcileSourceChecks([priorCheck],[{slug:entry.slug,name:entry.amc,month,status:partial?'partial':'ok',checkedAt:partial?null:startedAt,lastAttemptAt:startedAt,partialCheckedAt:partial?startedAt:null,schemeCount:schemes.length,missingSchemes:missing.length}])[0];
    for(const key of ['expectedFiles','completedFiles','failedFiles','pendingFiles','resumeUrl'])if(result[key]!==undefined)check[key]=result[key];
    const prior=checks.findIndex(c=>c.slug===entry.slug);if(prior>=0)checks[prior]=check;else checks.push(check);
    atomicJson(checksFile,checks);
  }
  // Each AMC uses its configured primary public adapter. A refusal remains a failure;
  // do not switch IPs, challenge clients or archive proxies to get around it.
  try {
    if(PUBLIC_PAGES[entry.slug]) {
      const month=targetMonth(),read=publicReader(entry.slug);
      // The upstream adapter's checked-in client token is public website config,
      // not a private API credential. Keep it in the pinned source checkout.
      const axisPublicToken=entry.slug==='axis'?/const AXIS_TOKEN\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(root,'scripts/ingest/amc-factsheets/json-api.ts'),'utf8'))?.[1]:undefined;
      const links=resumeDisclosures(await publicDisclosures(entry.slug,month,read,{axisPublicToken,includeHistory:true}),priorCheck);
      const XLSX=await import(pathToFileURL(path.join(root,'node_modules/xlsx/xlsx.mjs')).href);
      const parse=(buffer,link)=>{
        const schemes=parsePublicWorkbook(buffer,{XLSX,parseAmcWorkbook,parseVerifiedWorkbook:parseQuantumWorkbook,opts,month:link.disclosureMonth||month,link});
        if(schemes.length===1&&/fund|etf/i.test(link.text||'')&&(/name of instrument|portfolio statement|^\s*\(|open[ -]?ended?\s+(scheme|fund)/i.test(schemes[0].schemeName)||schemes[0].schemeName.trim().length<6))schemes[0].schemeName=link.text;
        return schemes;
      };
      const checkpoint=progress=>{
        const groups=new Map();for(const scheme of progress.schemes){const key=monthKey(scheme.asOf);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(scheme);}
        if(!checks.some(c=>c.slug===entry.slug))checks.push(reconcileSourceChecks([priorCheck],[{slug:entry.slug,name:entry.amc,month:priorCheck.month||monthKey(old.asOfMonth),status:'partial',checkedAt:null,lastAttemptAt:startedAt,partialCheckedAt:startedAt}])[0]);
        // Older reports enrich history, while coverage continues to refer to the
        // current month. Save it last; interrupted history never erases current data.
        for(const [key,schemes] of [...groups].sort(([a],[b])=>a.localeCompare(b)))if(!progress.lastCompletedMonth||key===progress.lastCompletedMonth)saveResult({...progress,schemes,usedUrl:PUBLIC_PAGES[entry.slug]},{recordCheck:key===month});
        // A historical file changes progress, not the current month's holdings.
        // Update its small check record without rewriting every other month again.
        if(!groups.has(month)||progress.lastCompletedMonth&&progress.lastCompletedMonth!==month) {
          const check=checks.find(c=>c.slug===entry.slug);
          if(check){for(const key of ['expectedFiles','completedFiles','failedFiles','pendingFiles','resumeUrl'])check[key]=progress[key];check.status=!groups.has(month)||check.missingSchemes||progress.failedFiles||progress.pendingFiles?'partial':'ok';check.checkedAt=check.status==='ok'?startedAt:priorCheck.lastCompleteCheckedAt;check.partialCheckedAt=check.status==='partial'?startedAt:null;check.lastCompleteCheckedAt=check.checkedAt;atomicJson(checksFile,checks);}
        }
      };
      result=await readDisclosures(links,{read,parse,month,onCheckpoint:checkpoint});
      checkpoint(result);
      result.schemes=result.schemes.filter(s=>monthKey(s.asOf)===month);
      result.usedUrl=PUBLIC_PAGES[entry.slug];
    }
    else if(STATUTORY_PAGES[entry.slug]) {
      const page=STATUTORY_PAGES[entry.slug];
      const html=execFileSync('curl',['--fail','--location','--silent','--show-error','--max-time','30',page],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:35000});
      const links=statutoryLinks(entry.slug,html,targetMonth()),schemes=[];
      for(const link of links)schemes.push(...downloadAndParse([link],opts,page).schemes.map(s=>({...s,sourceUrl:link.url})));
      result={schemes,usedUrl:page};
    }
    else if(entry.slug==='quantum') {
      const month=targetMonth(),XLSX=await import(pathToFileURL(path.join(root,'node_modules/xlsx/xlsx.mjs')).href);
      const download=url=>execFileSync('curl',['--fail','--location','--silent','--show-error','--max-time','30','--max-filesize','20000000',url],{maxBuffer:20*1024*1024,timeout:35000});
      const links=await quantumDisclosures(month,url=>JSON.parse(download(url).toString('utf8'))),schemes=[];
      for(const url of links)schemes.push(...parseQuantumWorkbook(download(url),{XLSX,parseAmcWorkbook,opts,month}).map(s=>({...s,sourceUrl:url})));
      result={schemes,usedUrl:QUANTUM_PAGE};
    }
    else if(PAGE_SCRAPE_CONFIG[entry.slug])result=pageScrapeAmc(PAGE_SCRAPE_CONFIG[entry.slug],opts,new Date());
    else if(JSON_API_CONFIG[entry.slug])result=jsonApiAmc(entry.slug,opts,new Date());
    else if(['sbi','nippon','kotak','icici-pru'].includes(entry.slug)) {
      const file=fetchLatest(entry.slug,3);
      if(file){let schemes=[];try{schemes=parseAmcWorkbook(file.buf,opts);}catch{/* ZIP files are another disclosure format. */}
        if(!schemes.length)schemes=parseZip(file.buf,opts);result={schemes,usedUrl:file.url};}
    }
    if(!result?.schemes?.length)throw Error('Disclosure unavailable');
    saveResult(result);
  }catch{const check=checks.find(c=>c.slug===entry.slug);if(check){Object.assign(check,{status:'partial',reason:'source-check-failed',checkedAt:priorCheck.lastCompleteCheckedAt,lastCompleteCheckedAt:priorCheck.lastCompleteCheckedAt,partialCheckedAt:startedAt,lastAttemptAt:startedAt});}else checks.push(reconcileSourceChecks([priorCheck],[{slug:entry.slug,name:entry.amc,month:priorCheck.month||monthKey(old.asOfMonth)||monthKey(entry.asOfMonth),status:'unavailable',checkedAt:null,lastAttemptAt:startedAt,reason:'source-discovery-failed'}])[0]);}
  atomicJson(checksFile,checks);
  console.log(`${entry.slug}: ${checks.at(-1).status} ${checks.at(-1).month||''}`);
}
}
