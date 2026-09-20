import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildOwnership,seededPayload} from './lib/mutual-funds-build.mjs';
import {MF_ENDPOINT,MF_ORIGIN,monthKey,targetMonth,projectCompany,companyRevision} from '../worker/mutual-funds-model.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';
import {loadActivePortfolio} from './lib/active-portfolio.mjs';
export function collectorClient({fetcher=fetch,env=process.env}={}) {
  let token=null,expires=0;
  return async body=>{
    if(!token||Date.now()>expires) {
      const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
      if(url.protocol!=='https:'||!url.hostname.endsWith('.actions.githubusercontent.com'))throw Error('OIDC unavailable');
      url.searchParams.set('audience',MF_ENDPOINT);
      const reply=await boundedJson(await fetcher(url,{headers:{authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(15000)}),64000);
      token=reply.value;expires=Date.now()+240000;
    }
    const reply=await boundedJson(await fetcher(MF_ENDPOINT,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(60000)}),1024*1024);
    if(!reply.ok)throw Error('Capture not acknowledged');return reply;
  };
}
async function main() {
  if(process.argv.includes('--bootstrap')) {
    const client=collectorClient();for(let attempt=0;attempt<45;attempt++){try{await client({action:'arm'});console.log('Mutual Funds timer armed');return;}catch{await new Promise(done=>setTimeout(done,10000));}}
    throw Error('Mutual Funds publishing unavailable');
  }
  const source=path.resolve(process.env.AMFIBEAS_PATH||'/tmp/sattva-amfibeas-source'),dir=path.join(source,'public/amc-holdings');
  const publish=process.argv.includes('--publish');
  const book=await loadActivePortfolio('public/data/portfolio-companies.json',{live:publish});
  const snapshots=fs.readdirSync(dir).filter(f=>f.endsWith('.json')&&!['index.json','sattva-checks.json'].includes(f)).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
  const index=JSON.parse(fs.readFileSync(path.join(dir,'index.json')));
  const checksFile=path.join(dir,'sattva-checks.json');
  const checks=fs.existsSync(checksFile)?JSON.parse(fs.readFileSync(checksFile)):index.amcs.map(a=>({slug:a.slug,name:a.amc,month:monthKey(a.asOfMonth),status:a.status,checkedAt:a.updatedAt}));
  const checkMap=new Map(checks.map(c=>[c.slug,c]));
  const amcs=index.amcs.map(a=>checkMap.get(a.slug)||{slug:a.slug,name:a.amc,month:monthKey(a.asOfMonth),status:'unchecked',checkedAt:null});
  const denomFile=process.env.MF_DENOMINATORS||'artifacts/mutual-funds-denominators.json';
  const denominators=fs.existsSync(denomFile)?JSON.parse(fs.readFileSync(denomFile)):{};
  const identities=Object.values(JSON.parse(fs.readFileSync('public/data/exchange-deals.json')).securityMap||{});
  const {companies,warnings}=buildOwnership(snapshots,{portfolio:book.holdings,identities,denominators});
  const target=targetMonth();
  for(const amc of amcs) {
    const issues=warnings.filter(w=>w.startsWith(amc.slug+':')&&(w.includes(':'+target+':')||w.endsWith(':invalid-month'))).length;
    if(issues){amc.validationFindings=issues;if(amc.status==='ok')amc.status='partial';}
  }
  const meta={state:'complete',checkedAt:checks.every(c=>c.checkedAt)?checks.map(c=>c.checkedAt).sort()[0]:new Date().toISOString(),
    targetMonth:targetMonth(),amcs,warnings:warnings.length,source:'AMC monthly portfolio disclosures via AmfiBeas',
    sourceRevision:process.env.AMFIBEAS_REVISION||null,
    retention:'All captured months and corrected company revisions retained; starting history varies by AMC. No claim of an exhaustive archive.'};
  fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/mutual-funds-health.json',JSON.stringify({meta,companies:companies.length,warnings},null,2));
  if(publish) {
    const client=collectorClient(),known=new Map();let cursor='';
    do {const r=await boundedJson(await fetch(`${MF_ORIGIN}/api/mutual-funds?cursor=${cursor}`,{signal:AbortSignal.timeout(30000)}),3*1024*1024);for(const row of r.rows||[])known.set(row.isin,row.revision);cursor=r.nextCursor||'';}while(cursor);
    await client({action:'begin',manifest:{...meta,targets:companies.map(c=>c.isin)}});
    const unchanged=[];let batch=[],batchBytes=0;
    const flush=async()=>{if(batch.length)await client({action:'checkpoint',companies:batch});batch=[];batchBytes=0;};
    for(const company of companies) {
      const revision=companyRevision(company);
      if(known.get(company.isin)===revision){unchanged.push({isin:company.isin,revision});continue;}
      const bytes=Buffer.byteLength(JSON.stringify(company));
      if(batch.length && (batch.length>=8 || batchBytes+bytes>2*1024*1024))await flush();
      batch.push(company);batchBytes+=bytes;
    }
    await flush();
    for(let at=0;at<unchanged.length;at+=200)await client({action:'confirm',companies:unchanged.slice(at,at+200)});
    await client({action:'finish'});await client({action:'arm'});
    console.log(`Published ${companies.length-unchanged.length} changed companies; ${unchanged.length} unchanged.`);
    // Source degradation is operationally visible after every useful checkpoint was saved.
    if(amcs.some(a=>a.status!=='ok'||a.month!==meta.targetMonth))process.exitCode=1;
  } else if(process.argv.includes('--seed')) {
    const out='public/data/mutual-funds';fs.mkdirSync(out+'/companies',{recursive:true});
    // Static fallback is the requested portfolio only. Production serves the complete universe.
    const isins=new Set(book.holdings.map(h=>h.isin)),portfolio=companies.filter(c=>isins.has(c.isin));
    fs.writeFileSync(out+'/index.json',JSON.stringify(seededPayload(portfolio,{...meta,origin:'seed'}))+'\n');
    for(const company of portfolio)fs.writeFileSync(`${out}/companies/${company.isin}.json`,JSON.stringify({meta:{state:'seed',checkedAt:meta.checkedAt,amcs},company:projectCompany(company)})+'\n');
    console.log(`Seeded ${portfolio.length} portfolio companies; ${companies.length} source companies; ${warnings.length} validation findings.`);
  } else console.log(`Verified local build: ${companies.length} companies, ${amcs.length} AMC statuses.`);
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
