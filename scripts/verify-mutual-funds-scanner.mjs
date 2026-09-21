import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {parseScannerStock,parseScannerCatalogue,scannerStockUrl} from './lib/mutual-funds-scanner.mjs';
import {scannerFetch,collectScanner,scannerCaptureHealthy} from './collect-mutual-funds-scanner.mjs';
import {supplementCompany} from '../worker/mutual-funds-scanner-model.mjs';
import {MutualFundsStore} from '../worker/mutual-funds-store.mjs';
import {MutualFundsScannerStore} from '../worker/mutual-funds-scanner-store.mjs';
import {handleMutualFunds} from '../worker/mutual-funds.mjs';
import {MF_ORIGIN} from '../worker/mutual-funds-model.mjs';

let clock=Date.parse('2026-09-21T01:00:00Z');const isin='INE090A01021',url='https://mfscanner.com/stock/fixture-bank';
// Synthetic markup only; no copied provider pages or private portfolios in Git.
const row=(slug,name,action,prior,current,delta)=>`<tr><td><a href="/fund/${slug}">${name}</a><span>HDFC</span></td><td>${action}</td><td>${prior}</td><td>${current}</td><td>${delta}</td><td>—</td></tr>`;
const html=(rows,count=1)=>`<html><head><link rel="canonical" href="${url}"><meta name="description" content="Holdings — ${count} schemes, share counts"></head><body><span>${isin}</span> · fund activity <table><thead><tr>${['Fund','Action','July 2026','August 2026','Δ shares','Value (₹Cr)'].map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
const sample=html(row('hdfc-fixture','HDFC Fixture Fund','increased','100','150','+50'));
const parse=s=>parseScannerStock(s,{isin,url,checkedAt:new Date(clock).toISOString(),now:clock});
let page=parse(sample);assert.equal(page.funds[0].months['2026-08'].shares,150);
for(const malformed of [sample.replace(isin,'INE040A01034'),sample.replace('August 2026','October 2026'),sample.replace('+50','+60'),sample.replace('1 schemes','2 schemes'),sample.replace('</html>',''),html(row('a','A','held','100','100','0')+row('a','A','held','100','100','0'),2)])assert.throws(()=>parse(malformed));
const pending=parse(html(row('a','A','pending','100','—','—')+row('b','B','new','0','20','+20')));assert.equal(pending.funds[0].months['2026-08'].shares,null);
const catHTML='<html><span>1</span> stocks.<a href="/stock/fixture-bank">Fixture Bank Limited</a></html>';
const catalogue=parseScannerCatalogue(catHTML);assert.equal(scannerStockUrl(catalogue,{name:'Fixture Bank',ticker:'FIX'}),url);assert.throws(()=>parseScannerCatalogue(catHTML.replace('>1<','>2<')));
assert.equal(scannerStockUrl([{name:'The North & South Bank Ltd.',url}],{name:'N&S Bank',aliases:['North and South Bank Ltd']}),url,'Company aliases survive articles and ampersand formatting');
assert.equal(scannerStockUrl([{name:'Fixture Electrical Eqp Ltd',url}],{name:'Fixture Electrical Equipments Ltd'}),url,'Common source abbreviations can discover a page; its exact ISIN is still mandatory');

const primary={isin,name:'Fixture Bank',month:'2026-08',funds:[{id:'hdfc:hdfc fixture fund',name:'HDFC Fixture Fund',amc:'HDFC',months:{'2026-07':{shares:100},'2026-06':{shares:75}}}]};
let combined=supplementCompany(primary,page,{now:clock});assert.equal(combined.funds.length,1);assert.equal(combined.totalShares,150);assert.equal(combined.netChange,50);assert.equal(combined.funds[0].months['2026-06'].shares,75);
const verified=structuredClone(primary);verified.funds[0].months['2026-08']={shares:0,absenceVerified:true};assert.equal(supplementCompany(verified,page,{now:clock}).totalShares,0,'Verified primary absence wins over a backup');
const duplicate=structuredClone(page);duplicate.funds.push({...duplicate.funds[0],id:'scanner:another-slug'});assert.equal(supplementCompany(primary,duplicate,{now:clock}).totalShares,null,'Ambiguous duplicate backup schemes are withheld');
assert.equal(supplementCompany(primary,{...page,funds:[]},{now:clock}).netChange,null,'An omitted fund is never an exit');
const conflicting=structuredClone(primary);conflicting.funds[0].name='HDFC Old Name Fund';conflicting.funds[0].months={'2026-08':{shares:120}};
assert.equal(supplementCompany(conflicting,page,{now:clock}).totalShares,120,'An unresolved rename cannot inflate an AMC above both source inventories');
const completeAmc={...page,funds:[{...page.funds[0],name:'HDFC Other Fund'}]};assert.equal(supplementCompany({...primary,funds:[]},completeAmc,{now:clock,amcs:[{slug:'hdfc',month:'2026-08',status:'ok'}]}).totalShares,null);

const db=new DatabaseSync(':memory:');
const storage={sql:{exec(sql,...args){const rows=db.prepare(sql).all(...args);return{toArray:()=>rows,one:()=>{assert.equal(rows.length,1);return rows[0];}};}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const base=new MutualFundsStore(storage,{now:()=>clock});let store=new MutualFundsScannerStore(storage,base,{now:()=>clock});base.scanner=store;
base.begin('1:1',{targets:[isin],amcs:[{slug:'hdfc',status:'partial',month:'2026-08'}]});base.checkpoint('1:1',[primary]);base.finish('1:1');
store.inventory([{isin,name:'Fixture Bank'}]);
const reserved=store.reserve('2:1','1','catalogue');assert.deepEqual(store.reserve('2:1','1','catalogue'),reserved,'A lost reservation acknowledgement replays the same lease');
store.complete('2:1',{reservation:reserved.reservation,catalogue});assert.equal(store.reserve('2:1','1','catalogue').reason,'already-completed');clock+=2100;
let task=store.reserve('2:1','2');page=parse(sample);store.complete('2:1',{reservation:task.reservation,isin,page});store.complete('2:1',{reservation:task.reservation,isin,page});
assert.equal(base.read([isin]).rows[0].totalShares,100,'Public API never includes a private observation');
assert.equal(store.read([isin]).rows[0].totalShares,150);
assert.equal(store.status().currentCompanies,1);
store=new MutualFundsScannerStore(storage,base,{now:()=>clock});base.scanner=store;
assert.equal(store.read([isin]).rows[0].totalShares,150,'Private observations survive object restart');
clock+=2100;assert.equal(store.reserve('3:1','1').reason,'nothing-due');
clock+=16*60000;task=store.reserve('3:1','2');store.complete('3:1',{reservation:task.reservation,isin,failure:'timeout'});
assert.equal(store.read([isin]).rows[0].totalShares,150);assert.equal(store.status().currentCompanies,0,'Failed checks do not certify freshness');
clock+=16*60000;task=store.reserve('3:1','3');store.complete('3:1',{reservation:task.reservation,isin,failure:'http-429',retryAfterMs:7200000});
assert.equal(store.reserve('3:1','4').reason,'source-cooldown');
clock+=1000;store=new MutualFundsScannerStore(storage,base,{now:()=>clock});base.scanner=store;assert.equal(store.reserve('4:1','1').reason,'source-cooldown','Cooldown survives process and run changes');
// Primary capture refreshes the cached private total in the same transaction.
const corrected=structuredClone(primary);corrected.funds[0].months['2026-08']={shares:160,checkedAt:new Date(clock).toISOString()};
base.begin('5:1',{targets:[isin],amcs:[{slug:'hdfc',status:'ok',month:'2026-08'}]});base.checkpoint('5:1',[corrected]);base.finish('5:1');assert.equal(store.read([isin]).rows[0].totalShares,160);assert.equal(db.prepare('SELECT COUNT(*) n FROM mf_scanner_history').get().n,2);

let privateCalls=0;const env={CAPTURE_REGISTRY:{getByName:()=>({mfRead:async ids=>base.read(ids),mfPrivateRead:async ids=>{privateCalls++;return store.read(ids);}})}};
let response=await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/private'),env,{authorise:async()=>({ok:false,reason:'no-session'})});assert.equal(response.status,401);assert.equal(privateCalls,0);assert.match(response.headers.get('cache-control'),/private.*no-store/);
response=await handleMutualFunds(new Request(MF_ORIGIN+`/api/mutual-funds/private?isins=${isin}`),env,{authorise:async()=>({ok:true})});assert.equal(response.status,200);assert.equal(response.headers.get('vary'),'Authorization');assert.equal((await response.json()).rows[0].totalShares,160);
response=await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/private',{headers:{origin:'https://untrusted.example'}}),env,{authorise:async()=>{throw Error('Must reject origin first');}});assert.equal(response.status,403);
await handleMutualFunds(new Request(MF_ORIGIN+'/api/mutual-funds/collector',{method:'POST',body:JSON.stringify({action:'scanner-status'})}),{CAPTURE_REGISTRY:{getByName:()=>({mfScannerStatus:async()=>({})})}},
  {identity:async(_request,options)=>{assert.equal(options.workflow,'mutual-funds-scanner.yml');return '7:1';}});
let fetchCalls=0;const denied=await scannerFetch(url,{fetcher:async(_url,options)=>{fetchCalls++;assert.equal(options.redirect,'manual');assert.equal(options.headers.authorization,undefined);return new Response('',{status:429,headers:{'retry-after':'7200'}});}});assert.equal(fetchCalls,1);assert.equal(denied.retryAfterMs,7200000);
const out=await collectScanner({companies:[{isin,name:'Fixture Bank'}],client:async body=>body.action==='scanner-reserve'?{ok:true,reason:'source-cooldown'}:{ok:true},fetcher:()=>{throw Error('Cooldown must prevent source requests');}});assert.equal(out.reason,'source-cooldown');
// A future portfolio company can arrive in the supplement before primary import.
clock+=3*3600000;const newIsin='INE040A01034';store.inventory([{isin,name:'Fixture Bank'},{isin:newIsin,name:'New holding'}]);
task=store.reserve('6:1','1');assert.equal(task.company.isin,newIsin);
const next=structuredClone(page);next.isin=newIsin;next.checkedAt=new Date(clock).toISOString();next.funds[0].amc='navi';
for(const point of Object.values(next.funds[0].months))point.checkedAt=next.checkedAt;
store.complete('6:1',{reservation:task.reservation,isin:newIsin,page:next});
assert.equal(base.read([newIsin]).rows.length,0);assert.equal(store.read([newIsin]).rows[0].totalShares,150);
assert(store.read(null).rows.some(r=>r.isin===newIsin),'Universe pagination includes private-only identities');
console.log('PASS MF Scanner: exact identities/months/counts, pending vs exits, primary precedence, duplicate guards, private API boundary, durable corrections, resume, rate budget and cooldown');

const {mutualFundEvidenceRows}=await import('../public/js/data/mutual-funds-evidence.js');
const evidence=mutualFundEvidenceRows([{...combined,supplement:{...combined.supplement,used:true}}],{checkedAt:'2026-09-18',supplementReadFailed:true});
assert.equal(evidence[0].primaryCheckedAt,undefined,'Primary date is carried once at packet level');assert.equal(evidence[0].mfScanner.source,'MF Scanner');assert.equal(evidence[0].mfScanner.checkState,'read-failed');assert.equal(evidence[0].mfScanner.checkedAt,combined.supplement.checkedAt);
assert(scannerCaptureHealthy({failed:0},{expectedCompanies:2,currentCompanies:2}));
assert(!scannerCaptureHealthy({failed:1},{expectedCompanies:2,currentCompanies:2}));
assert(!scannerCaptureHealthy({failed:0},{expectedCompanies:2,currentCompanies:1}));
assert(!scannerCaptureHealthy({failed:0,reason:'source-cooldown'},{expectedCompanies:2,currentCompanies:2}));
console.log('PASS research source provenance and unattended incomplete-capture health gate');

const {providerMutualFunds}=await import('../public/js/research/evidence-shared.js');const packed=providerMutualFunds({id:'mutual-funds',source:'AmfiBeas; MF Scanner',asOf:'2026-09-18',rows:evidence});
assert.equal(packed.rows[0][packed.columns.indexOf('mfScanner.checkedAt')],combined.supplement.checkedAt);assert.equal(packed.rows[0][packed.columns.indexOf('mfScanner.checkState')],'read-failed');
const {supplementStatus}=await import('../public/js/data/mutual-funds-supplement.js');
const backupStatus=supplementStatus({checkedAt:'2026-09-21T05:00:00Z',supplement:{currentCompanies:1,expectedCompanies:1,companies:[{checkedAt:'2026-09-20T04:00:00Z'}],catalogue:{state:'timeout',lastAttemptAt:'2026-09-21T03:00:00Z'}}});
assert.match(backupStatus,/1\/1 companies checked/);assert.match(backupStatus,/20 Sept 2026/);assert.match(backupStatus,/Catalogue check unavailable \(21 Sept 2026/);
assert.match(supplementStatus({supplementReadFailed:true}),/primary disclosures shown/);
const largeBook=Array.from({length:5000},(_,i)=>({isin:`INE${String(i).padStart(9,'0')}`,name:`Fixture ${i}`}));
store.inventory(largeBook);assert.equal(store.status().expectedCompanies,5000,'The complete validated portfolio is accepted');
assert.equal(store.status().companies.some(c=>c.isin===newIsin),false,'Exited holdings leave the active inventory');
assert.equal(store.read([newIsin]).rows[0].totalShares,150,'Exited holdings retain their captured history');
assert.throws(()=>store.inventory([...largeBook,{isin:'INE999999999',name:'Over limit'}]));
console.log('PASS backup check dates, failed catalogue visibility and full 5000-holding inventory reconciliation');
