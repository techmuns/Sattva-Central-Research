import assert from 'node:assert/strict';
import {buildOwnership} from './lib/mutual-funds-build.mjs';
import {change,mergeCompany,projectCompany,coverageState,companyRevision} from '../worker/mutual-funds-model.mjs';
import {handleMutualFunds} from '../worker/mutual-funds.mjs';
const now=Date.parse('2026-09-20T00:00:00Z'),isin='INE090A01021',other='INE040A01034';
const h=(id,quantity,pct=100)=>({isin:id,name:id,quantity,pctToNav:pct,marketValueCr:25});
const sc=(name,month,rows)=>({schemeName:name,asOf:`${month}-31`,holdings:rows});
const snapshot={amcSlug:'fixture',amc:'Fixture AMC',asOfMonth:'Aug-26',fetchedAt:'2026-09-19T00:00:00Z',sourceUrl:'https://example.com/aug.xlsx',schemes:[sc('Growth Fund','2026-08',[h(isin,150)]),sc('Exit Fund','2026-08',[h(other,100)]),sc('Missing Quantity','2026-08',[h(isin,null)])],history:[{asOfMonth:'Jul-26',schemes:[sc('Growth Fund','2026-07',[h(isin,100)]),sc('Exit Fund','2026-07',[h(isin,30)]),sc('Unreported Fund','2026-07',[h(isin,70)]),sc('Missing Quantity','2026-07',[h(isin,20)])]}]};
const built=buildOwnership([snapshot],{now});const company=built.companies.find(c=>c.isin===isin);
let p=projectCompany({...company,denominator:{shares:1000,checkedAt:'2026-09-19T00:00:00Z',kind:'exchange'}},{now});
assert.equal(p.totalShares,150);assert.equal(p.netChange,20);assert.equal(p.addedShares,50);assert.equal(p.reducedShares,30);assert.equal(p.pendingFunds,2);assert.equal(p.companyPct,15);assert.equal(p.funds.find(f=>f.name==='Exit Fund').action,'Exited');assert.equal(p.funds.find(f=>f.name==='Unreported Fund').change,null);assert.equal(p.funds.find(f=>f.name==='Missing Quantity').current.shares,null);
assert.equal(change(100,0).action,'New');assert.equal(change(100,0).changePct,null);assert.equal(change(0,100).changePct,-100);assert.equal(change(1,1).action,'No material change');
// Unknown or partial sheets cannot establish a zero. Non-adjacent periods cannot establish MoM.
const partial=structuredClone(snapshot);partial.schemes[1].holdings[0].pctToNav=40;
assert.equal(projectCompany(buildOwnership([partial],{now}).companies.find(c=>c.isin===isin),{now}).funds.find(f=>f.name==='Exit Fund').change,null);
const futures=structuredClone(snapshot);futures.schemes[0].holdings.push({...h(isin,-20),name:'Fixture-SEP2026'}, {...h(isin,30),name:'Fixture-29-Sep-2026'});assert.equal(projectCompany(buildOwnership([futures],{now}).companies.find(c=>c.isin===isin),{now}).totalShares,150,'Derivative exposure is not owned shares');
const duplicate=structuredClone(snapshot);duplicate.schemes.push(sc('Growth Fund','2026-08',[h(isin,999)]));assert.equal(projectCompany(buildOwnership([duplicate],{now}).companies.find(c=>c.isin===isin),{now}).funds.find(f=>f.name==='Growth Fund').current.shares,null);
const missing=structuredClone(company);missing.funds[0].months['2026-06']=missing.funds[0].months['2026-07'];delete missing.funds[0].months['2026-07'];assert.equal(projectCompany(missing,{now}).funds[0].change,null);
const newer=structuredClone(company);delete newer.funds[0].months['2026-07'];newer.funds[0].months['2026-08'].shares=175;
const merged=mergeCompany(company,newer);assert.equal(merged.funds[0].months['2026-07'].shares,100);assert.equal(merged.funds[0].months['2026-08'].shares,175);
const unavailable=structuredClone(newer);unavailable.funds[0].months['2026-08'].shares=null;assert.equal(mergeCompany(merged,unavailable).funds[0].months['2026-08'].shares,175);
const older=structuredClone(newer);older.funds[0].months['2026-08'].checkedAt='2026-09-01T00:00:00Z';assert.equal(mergeCompany(merged,older).funds[0].months['2026-08'].shares,175);
const rechecked=structuredClone(company);rechecked.funds[0].months['2026-08'].checkedAt='2026-09-20T00:00:00Z';assert.equal(companyRevision(company),companyRevision(rechecked));
assert.equal(coverageState({state:'complete',checkedAt:new Date(now).toISOString(),amcs:[{month:'2026-07',status:'ok'}]},now).state,'partial');
assert.equal(coverageState({state:'complete',checkedAt:'2026-09-01',amcs:[{month:'2026-08',status:'ok'}]},now).state,'stale');
assert.equal(coverageState({state:'complete',checkedAt:new Date(now).toISOString(),amcs:[{month:'2026-08',status:'ok'}]},now+12*86400000).state,'stale');
assert.equal(projectCompany({...company,denominator:{shares:1000,checkedAt:'2026-08-01'}},{now}).companyPct,null);
// Only this workflow's OIDC identity may publish, and reader requests cannot arm a timer.
let calls=0;const env={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async()=>{calls++;return{meta:{checkedAt:null},rows:[]};}})}};
assert.equal((await handleMutualFunds(new Request('https://sattva-central-research.tech-441.workers.dev/api/mutual-funds/collector',{method:'POST',body:'{}'}),env)).status,403);
assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds?isins=invalid'),env)).status,400);assert.equal(calls,0);
const read=await handleMutualFunds(new Request('https://test/api/mutual-funds'),env);assert.equal(read.status,200);const tag=read.headers.get('etag');assert(tag);
assert.equal((await handleMutualFunds(new Request('https://test/api/mutual-funds',{headers:{'if-none-match':tag}}),env)).status,304);
console.log('PASS Mutual Funds: exact ISINs, comparable months, exits vs missing reports, missing quantities, changes, denominator age, rollover, retained corrections and conditional/authenticated routes');
const {DatabaseSync}=await import('node:sqlite');const {MutualFundsStore}=await import('../worker/mutual-funds-store.mjs');const {MutualFundsSchedule}=await import('../worker/mutual-funds-schedule.mjs');
const db=new DatabaseSync(':memory:'),kv=new Map();let alarm=null,clock=now;
const storage={sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args);return{toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,structuredClone(v)),getAlarm:async()=>alarm,setAlarm:async a=>{alarm=a;}};storage.transaction=async fn=>fn(storage);
let store=new MutualFundsStore(storage,{now:()=>clock});const manifest={targets:[isin,other],amcs:[{month:'2026-08',status:'ok'}],checkedAt:new Date(now).toISOString()};
store.begin('1:1',manifest);store.checkpoint('1:1',[company]);assert.throws(()=>store.finish('1:1'),/Incomplete/);assert.equal(store.read().meta.state,'collecting');
store.checkpoint('1:1',[company]);assert.equal(store.status().receivedCompanies,1,'A repeated acknowledged fragment does not double-count the company');
store=new MutualFundsStore(storage,{now:()=>clock});assert.equal(store.detail(isin).company.totalShares,150);store.checkpoint('1:1',built.companies.filter(c=>c.isin===other));store.finish('1:1');assert.equal(store.read().meta.state,'complete');
store.finish('1:1');assert.equal(store.status().receivedCompanies,2,'A lost completion acknowledgement may safely be retried');
clock+=1000;store.begin('2:1',manifest);store.confirm('2:1',store.read().rows.map(r=>({isin:r.isin,revision:r.revision})));store.finish('2:1');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mf_revisions').get().n,2,'Unchanged checks do not duplicate stored holdings');
clock+=1000;store.begin('3:1',manifest);store.checkpoint('3:1',[newer]);assert.equal(store.detail(isin).company.funds.find(f=>f.name==='Growth Fund').months['2026-07'].shares,100);assert.equal(store.detail(isin).company.totalShares,175);assert.throws(()=>store.checkpoint('2:1',[company]),/Inactive/);
assert.equal(store.read([isin]).rows.length,1);assert.equal(store.read([]).rows.length,0);
const timer=new MutualFundsSchedule(storage,{}, {now:()=>clock});await timer.arm();assert(alarm);await timer.wake();assert.equal((await timer.status()).reason,'dispatch-unavailable');assert(alarm>clock,'Failed dispatch still has a durable next attempt');
console.log('PASS Mutual Funds SQLite: interrupted collection resumes, completeness gate, unchanged checkpoints, revision retention, older-month retention, scope reads and durable retry timer');

// A refreshed denominator is material even when the disclosed quantity is unchanged.
const d1={...company,denominator:{shares:1000,checkedAt:'2026-09-19'}};
assert.notEqual(companyRevision(d1),companyRevision({...d1,denominator:{...d1.denominator,checkedAt:'2026-09-20'}}));
store.begin('9:1',manifest);store.begin('10:1',manifest);assert.equal(store.active().id,'10:1');assert.throws(()=>store.begin('9:2',manifest),/Superseded/);
// Run the real research adapter and evidence budget against every committed portfolio identity.
const fs=await import('node:fs');globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};globalThis.location={hostname:'localhost'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{try{return new Response(fs.readFileSync(new URL('../public/'+String(url).replace(/^\//,''),import.meta.url)),{headers:{'content-type':'application/json'}});}catch{return new Response('{}',{status:404});}};
try {
  const book=JSON.parse(fs.readFileSync(new URL('../public/data/portfolio-companies.json',import.meta.url)));
  const coverage=await import('../public/js/data/coverage.js');coverage.prime(book);
  const {buildResearchEvidence}=await import('../public/js/research/estate.js');
  const evidence=await buildResearchEvidence({question:'Which mutual funds added or sold stocks across the portfolio last month?',prepared:{deferred:{},loadErrors:new Map()}});
  const mf=evidence.sources.find(s=>s.id==='mutual-funds');assert.equal(mf.rows.length,book.holdings.length);assert.equal(mf.rowCount,book.holdings.length);
  const {validateResearchBody}=await import('../worker/research.mjs');assert(validateResearchBody({question:'Which mutual funds bought?',evidence}).ok);
  console.log(`PASS Ask Research: every ${book.holdings.length} portfolio company survives the provider evidence budget and Worker validation`);
}finally{globalThis.fetch=originalFetch;}

let dispatched=0;
const fetcher=async(url,options={})=>{
  if(options.method==='POST'){dispatched++;assert.match(url,/mutual-funds-refresh.yml\/dispatches$/);return new Response(null,{status:204});}
  return Response.json({total_count:0,workflow_runs:[]});
};
clock+=20*60000;const healthyTimer=new MutualFundsSchedule(storage,{GH_DISPATCH_TOKEN:'fixture',GH_REPO:'techmuns/Sattva-Central-Research'},{now:()=>clock,fetcher});
await healthyTimer.wake();assert.equal(dispatched,1);assert.equal((await healthyTimer.status()).reason,'dispatched');
await healthyTimer.wake();assert.equal(dispatched,1,'Alarm redelivery cannot dispatch twice in the same interval');
// A corrected complete disclosure removes a former holding, without erasing its old revision.
clock=now+10000;const currentRevision=store.read([isin]).rows[0].revision;
store.begin('11:1',{...manifest,targets:[isin],reportCount:1});
assert.throws(()=>store.confirm('11:1',[{isin,revision:currentRevision}]),/Incomplete source/);
store.reports('11:1',[{id:company.funds.find(f=>f.name==='Growth Fund').id,month:'2026-08',checkedAt:'2026-09-20T00:00:01Z',complete:true,isins:[],sourceUrl:'https://example.com/corrected.xlsx'}]);
store.confirm('11:1',[{isin,revision:currentRevision}]);store.finish('11:1');
assert.equal(store.detail(isin).company.totalShares,0);
assert(db.prepare('SELECT payload FROM mf_observation_revisions WHERE isin=?').all(isin).some(r=>JSON.parse(r.payload).shares===175),'The retracted disclosure remains auditable');
// More than the old 3 MiB upload ceiling, split even within one long-lived fund.
const {companyFragments}=await import('./lib/mutual-funds-transport.mjs');
const long={isin:other,name:'Long history',funds:[{id:'long:fund',name:'Long Fund',months:{}}]};
for(let year=2000;year<=2026;year++)for(let m=1;m<=12;m++)long.funds[0].months[`${year}-${String(m).padStart(2,'0')}`]={shares:year*100+m,checkedAt:'2026-09-20',sourceUrl:'https://example.com/'+('a'.repeat(11000))};
assert(Buffer.byteLength(JSON.stringify(long))>3*1024*1024);const fragments=companyFragments(long);assert(fragments.length>1);assert(fragments.every(f=>Buffer.byteLength(JSON.stringify({fragment:f}))<600*1024));
store.begin('12:1',{...manifest,targets:[other]});store.fragment('12:1',fragments[0]);assert.throws(()=>store.finish('12:1'),/Incomplete/);
store=new MutualFundsStore(storage,{now:()=>clock});for(const part of fragments.slice(1))store.fragment('12:1',part);store.finish('12:1');
assert.equal(store.detail(other,'2001-06').company.funds.find(f=>f.id==='long:fund').current.shares,200106);
assert.equal(store.detail(other).company.months.length,3);assert(store.detail(other).company.availableMonths.length>300);
assert(db.prepare('SELECT MAX(LENGTH(payload)) AS n FROM mf_observations').get().n<12000,'Stored rows do not grow with historical depth');
console.log('PASS complete-report corrections, immutable observation history, multi-part restart and history beyond the former upload ceiling');

const {statutoryLinks}=await import('./lib/mutual-funds-discovery.mjs');
const monthly={title:'August 31, 2026',downloadUrl:null,downloadMedia:{name:'Monthly.xls',url:'/uploads/monthly.xls'}};
const fortnightly={...monthly,title:'August 15, 2026',downloadMedia:{url:'/uploads/fortnight.xls'}};
assert.deepEqual(statutoryLinks('abakkus',JSON.stringify(JSON.stringify([monthly,fortnightly])),'2026-08').map(r=>r.url),['https://www.abakkusmf.com/uploads/monthly.xls']);
assert.equal(statutoryLinks('abakkus',JSON.stringify(monthly),'2026-09').length,0);
assert.equal(statutoryLinks('old-bridge','<h2>Old Bridge Flexi Cap Fund - August 2026</h2><a href="/uploads/aug.xlsx">Download</a><h2>Financials - August 2026</h2><a href="/uploads/financial.xlsx">Download</a>','2026-08').length,1);
