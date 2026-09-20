import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runSourcePool} from './lib/mutual-funds-source-pool.mjs';
import {retainSeedObservations} from './lib/mutual-funds-seed.mjs';
import {projectCompany} from '../worker/mutual-funds-model.mjs';
import {publishCompanies} from './lib/mutual-funds-transport.mjs';
import {collectorClient} from './collect-mutual-funds.mjs';
import {quantumDisclosures,directPortfolioRows,parseQuantumWorkbook} from './lib/mutual-funds-quantum.mjs';
import './verify-mutual-funds-public.mjs';
const quantumFile={FactSheetDate:'/Date(1788114600000)/',SchemeId:-1,FactSheetFreq:1,IsActive:1,FileUrl:'https://www.quantumamc.com/FileCDN/FactSheet/august-2026.xlsx'};
const quantumReply=(page,files,pages=1)=>({success:true,pageIndex:page,totalPageCount:pages,objProductPortfolioList:files});
const requested=[];
const quantumLinks=await quantumDisclosures('2026-08',async url=>{
  const q=new URL(url).searchParams;requested.push(Number(q.get('pageIndex')));
  assert.equal(q.get('yearId'),'2026');assert.equal(q.get('monthId'),'8');assert.equal(q.get('Frequency'),'1');
  return requested.length===1?quantumReply(1,[{...quantumFile,FactSheetDate:'/Date(1380499200000)/'},
    {...quantumFile,FactSheetFreq:2},{...quantumFile,SchemeId:4},{...quantumFile,IsActive:0},
    {...quantumFile,FileUrl:'https://example.test/report.xlsx'}],2):quantumReply(2,[quantumFile,quantumFile],2);
});
assert.deepEqual(requested,[1,2]);assert.deepEqual(quantumLinks,[quantumFile.FileUrl]);
await assert.rejects(quantumDisclosures('2026-08',async()=>quantumReply(1,[quantumFile],51)),/Incomplete/);
await assert.rejects(quantumDisclosures('2026-08',async()=>quantumReply(1,[],1)),/unavailable/);
await assert.rejects(quantumDisclosures('2026-08',async url=>quantumReply(Number(new URL(url).searchParams.get('pageIndex')),[],2)),/unavailable/);
await assert.rejects(quantumDisclosures('2026-08',async url=>quantumReply(Number(new URL(url).searchParams.get('pageIndex')),[],Number(new URL(url).searchParams.get('pageIndex'))===1?2:1)),/changed/);
const ownRows=[['Quantum Diversified Equity All Cap Active FOF'],['Fund units','INF209K01WE3',1347101]];
const appendix=[['Monthly Portfolio Statement of the Underlying Schemes of Quantum Diversified Equity All Cap Active FOF'],['Underlying company','INE090A01021',10000000]];
assert.deepEqual(directPortfolioRows([...ownRows,...appendix]),ownRows);
assert.deepEqual(directPortfolioRows(ownRows),ownRows);
assert.deepEqual(directPortfolioRows([['Company equity','INE090A01021',150]]),[['Company equity','INE090A01021',150]],'Real directly held equity remains intact');
// Exercise the workbook adapter with injected I/O; the source runtime supplies XLSX.
const fakeXlsx={read:()=>({SheetNames:['FoF','Equity'],Sheets:{FoF:[...ownRows,...appendix],Equity:[['Direct equity','INE090A01021',150]]}}),utils:{sheet_to_json:s=>s,aoa_to_sheet:r=>r},write:book=>book.Sheets};
const parseFixture=book=>{assert.deepEqual(book.FoF,ownRows);assert.equal(book.Equity[0][2],150);return[{asOf:'2026-08-31',holdings:[]}];};
assert.equal(parseQuantumWorkbook(null,{XLSX:fakeXlsx,parseAmcWorkbook:parseFixture,opts:{},month:'2026-08'}).length,1);
assert.throws(()=>parseQuantumWorkbook(null,{XLSX:fakeXlsx,parseAmcWorkbook:()=>[{asOf:'2013-09-30'}],opts:{},month:'2026-08'}),/month unverified/);
assert.throws(()=>parseQuantumWorkbook(null,{XLSX:fakeXlsx,parseAmcWorkbook:()=>[{asOf:'2026-08-31',schemeName:'Quantum Equity FOF',holdings:[{isin:'INE090A01021'}]}],opts:{},month:'2026-08'}),/Ambiguous FoF/);
const original=Buffer.from('original workbook'),withoutAppendix={...fakeXlsx,read:()=>({SheetNames:['Equity'],Sheets:{Equity:[['Direct equity','INE090A01021',150]]}}),write:()=>{throw Error('Unnecessary workbook rewrite');}};
parseQuantumWorkbook(original,{XLSX:withoutAppendix,parseAmcWorkbook:buffer=>{assert.equal(buffer,original);return[{asOf:'2026-08-31',schemeName:'Equity Fund',holdings:[]}];},opts:{},month:'2026-08'});
console.log('PASS Quantum disclosures: exact month, complete pagination, permitted files, actual workbook dates and direct ownership without underlying-fund double counting');
const dated={isin:'INE123A01016',name:'Captured company',funds:[{id:'amc:fund',name:'Fund',amc:'AMC',months:{'2026-08':{shares:100,checkedAt:'2026-09-20T08:00:00Z',change:100,action:'New'}}}]};
const missing={isin:dated.isin,name:'Current portfolio name',funds:[]};
const retained=retainSeedObservations([missing],[{company:dated}])[0];
assert.equal(retained.funds[0].months['2026-08'].shares,100,'A failed source cannot remove the initial captured report');
assert.equal(retained.name,'Current portfolio name');
assert.equal(retained.funds[0].months['2026-08'].change,undefined,'Derived display math is not a source observation');
const older=structuredClone(dated);older.funds[0].months['2026-08']={shares:50,checkedAt:'2026-09-20T07:00:00Z'};
assert.equal(retainSeedObservations([older],[{company:dated}])[0].funds[0].months['2026-08'].shares,100);
const corrected=structuredClone(dated);corrected.funds[0].months['2026-08']={shares:0,checkedAt:'2026-09-20T09:00:00Z',absenceVerified:true};
const merged=retainSeedObservations([corrected],[{company:dated}])[0];
assert.equal(merged.funds[0].months['2026-08'].shares,0,'A newer confirmed nil holding supersedes the dated seed');
assert.equal(retainSeedObservations([],[{company:dated}]).length,1,'Historical seed companies survive leaving the current source window');
const seedFiles=fs.readdirSync('public/data/mutual-funds/companies').filter(f=>f.endsWith('.json'));
for(const file of seedFiles){const seed=JSON.parse(fs.readFileSync(`public/data/mutual-funds/companies/${file}`));const result=projectCompany(retainSeedObservations([],[seed])[0],{now:Date.parse('2026-09-20T12:00:00Z')});assert.equal(result.totalShares,seed.company.totalShares);assert.equal(result.netChange,seed.company.netChange);}
console.log(`PASS retained seed capture: newer observations win, missing sources retain history, and ${seedFiles.length} portfolio totals survive normalization`);
const books=Array.from({length:7},(_,i)=>({...dated,isin:`INE123A0101${i}`,funds:[{...dated.funds[0],months:Object.fromEntries(Array.from({length:8},(_,m)=>[`2026-0${m+1}`,{shares:100,checkedAt:'2026-09-20T08:00:00Z',sourceUrl:'https://example.test/'+('a'.repeat(100))}]))}]}));
let inFlight=0,peak=0;const parts=new Map(),acknowledged=new Set();
const receiver=async({fragment:f})=>{inFlight++;peak=Math.max(peak,inFlight);assert.equal(f.part,parts.get(f.company.isin)||0);await new Promise(done=>setTimeout(done,5));parts.set(f.company.isin,f.part+1);if(f.part===f.parts-1)acknowledged.add(f.company.isin);inFlight--;};
await publishCompanies(books,receiver,{concurrency:3,limit:700});
assert.equal(inFlight,0);assert.equal(peak,3);assert.equal(acknowledged.size,books.length);assert([...parts.values()].every(n=>n>1));
acknowledged.clear();parts.clear();
await assert.rejects(publishCompanies(books,async body=>{if(body.fragment.company.isin===books[0].isin)throw Error('Transport failure');await receiver(body);},{concurrency:3,limit:700}),/1 company uploads/);
assert.equal(inFlight,0);assert.equal(acknowledged.size,books.length-1,'One failed company cannot discard the other acknowledged checkpoints');
console.log('PASS bounded publication: independent stocks overlap, each company remains ordered, and failures wait for all other checkpoints');
const oidcEnv={ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture'};
const bodies=[],waits=[];let attempts=0;
const retryClient=collectorClient({env:oidcEnv,pause:async ms=>waits.push(ms),fetcher:async(url,options)=>{
  if(String(url).includes('actions.githubusercontent.com'))return Response.json({value:'fixture-identity'});
  bodies.push(options.body);attempts++;
  if(attempts===1)return new Response('',{status:503});
  if(attempts===2)throw Error('Acknowledgement lost');
  return Response.json({ok:true});
}});
await retryClient({action:'fragment',fragment:{part:0}});
assert.equal(new Set(bodies).size,1,'Recovery repeats the exact idempotent request');assert.deepEqual(waits,[1000,2000]);
let refused=0;
await assert.rejects(collectorClient({env:oidcEnv,pause:async()=>{throw Error('Must not retry refusal');},fetcher:async url=>String(url).includes('actions.githubusercontent.com')?Response.json({value:'fixture'}):(refused++,new Response('',{status:403}))})({action:'arm'}),/403/);
assert.equal(refused,1);
let unavailable=0;
await assert.rejects(collectorClient({env:oidcEnv,pause:async()=>{},fetcher:async url=>String(url).includes('actions.githubusercontent.com')?Response.json({value:'fixture'}):(unavailable++,new Response('',{status:503}))})({action:'arm'}),/503/);
assert.equal(unavailable,4,'Repeated outages exhaust a bounded retry budget');
console.log('PASS capture recovery: temporary server errors and lost acknowledgements retry unchanged requests, refusals stop, persistent failure remains bounded');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mf-source-pool-test-'));
try {
  const script=path.join(dir,'source.mjs'),events=path.join(dir,'events'),checksFile=path.join(dir,'checks.json');
  fs.writeFileSync(script,`import fs from 'node:fs';import{spawn}from'node:child_process';
const slug=process.env.MF_SOURCE_AMCS;
fs.appendFileSync(process.env.EVENTS,JSON.stringify({slug,event:'start'})+'\\n');
if(slug==='failed')process.exit(2);
if(slug==='hanging'||slug==='checkpointed'){
  if(slug==='checkpointed')fs.writeFileSync(process.env.MF_SOURCE_CHECK_FILE,JSON.stringify([{slug,status:'partial',schemeCount:2,checkedAt:'2026-09-20T09:00:00Z',month:'2026-08',expectedFiles:3,completedFiles:2,pendingFiles:1}]));
  const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  fs.writeFileSync(process.env.DESCENDANT,String(descendant.pid));
  process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
}else setTimeout(()=>{
  fs.writeFileSync(process.env.MF_SOURCE_CHECK_FILE,JSON.stringify([{slug,status:'ok',checkedAt:'2026-09-20T09:00:00Z',month:'2026-08'}]));
  fs.appendFileSync(process.env.EVENTS,JSON.stringify({slug,event:'done'})+'\\n');
},20);`);
  const descendant=path.join(dir,'descendant'),env={...process.env,EVENTS:events,DESCENDANT:descendant};
  const entries=['hanging','fast','later','failed'].map(slug=>({slug,amc:slug}));
  const completed=[];
  const result=await runSourcePool(entries,{command:process.execPath,args:[script],env,checksFile,concurrency:2,timeoutMs:1000,
    initial:[{slug:'untouched',status:'ok',checkedAt:'original-source-time'}],onResult:c=>completed.push(c.slug)});
  assert(!result.interrupted);
  assert(completed.indexOf('fast')<completed.indexOf('hanging'),'A stalled first source cannot block a later source');
  const bySlug=new Map(result.checks.map(c=>[c.slug,c]));
  assert.equal(bySlug.get('hanging').reason,'source-timeout');assert.equal(bySlug.get('hanging').checkedAt,null);
  assert.equal(bySlug.get('failed').reason,'source-process-failed');assert.equal(bySlug.get('later').status,'ok');
  assert.equal(bySlug.get('untouched').checkedAt,'original-source-time');
  assert.deepEqual(JSON.parse(fs.readFileSync(checksFile)),result.checks,'Every completion is durably checkpointed');
  const eventsRead=fs.readFileSync(events,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert(eventsRead.findIndex(e=>e.slug==='later'&&e.event==='start')>eventsRead.findIndex(e=>e.slug==='fast'&&e.event==='done'),'No third source starts before a slot is free');
  // An exited descendant can briefly remain as a zombie until init reaps it; neither
  // a missing process nor a zombie can continue making source requests.
  const pid=Number(fs.readFileSync(descendant));
  await new Promise(done=>setTimeout(done,50));
  try {process.kill(pid,0);const {execFileSync}=await import('node:child_process');assert.match(execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}),/^\s*Z/);}catch(error){if(error.code!=='ESRCH'&&error.status!==1)throw error;}

  const cancel=new AbortController();cancel.abort();
  const interrupted=await runSourcePool([{slug:'not-started',amc:'Not started'}],{command:process.execPath,args:[script],env,checksFile,signal:cancel.signal});
  assert(interrupted.interrupted);assert.equal(interrupted.checks[0].status,'unchecked');
  assert.equal(fs.existsSync(`${checksFile}.tmp`),false);
  const activeCancel=new AbortController();
  const active=runSourcePool([{slug:'hanging',amc:'Hanging'},{slug:'queued',amc:'Queued'}],{command:process.execPath,args:[script],env,checksFile,concurrency:1,timeoutMs:10000,signal:activeCancel.signal});
  setTimeout(()=>activeCancel.abort(),300);
  const stopped=await active;
  assert(stopped.interrupted);assert.equal(stopped.checks.find(c=>c.slug==='hanging').reason,'interrupted');
  assert.equal(stopped.checks.find(c=>c.slug==='queued').status,'unchecked','Cancellation cannot start another source');
  const saved=await runSourcePool([{slug:'checkpointed',amc:'Checkpointed'}],{command:process.execPath,args:[script],env,checksFile,timeoutMs:1000});
  assert.equal(saved.checks[0].status,'partial');assert.equal(saved.checks[0].schemeCount,2);
  assert.equal(saved.checks[0].checkedAt,'2026-09-20T09:00:00Z');assert.equal(saved.checks[0].reason,'source-timeout');
  assert.equal(saved.checks[0].pendingFiles,1,'A timed-out file retains completed reports without claiming a full check');
  console.log('PASS source isolation: bounded concurrency, hung source and descendant timeout, later-source progress, failed child, durable checkpoints, preserved check times and interruption');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
