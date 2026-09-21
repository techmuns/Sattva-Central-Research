import assert from 'node:assert/strict';
import {companyFragments} from './lib/mutual-funds-transport.mjs';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const scratch=mkdtempSync(join(tmpdir(),'mf-runtime-')),port=19879,origin=`http://127.0.0.1:${port}`,config=join(scratch,'wrangler.json');
writeFileSync(join(scratch,'entry.mjs'),`import {CaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};export {CaptureRegistry};export default {async fetch(request,env){const b=await request.json();const s=env.STORE.getByName('mf-fixture');if(b.action==='scanner-inventory')return Response.json(await s.mfScannerInventory(b.companies));if(b.action==='scanner-reserve')return Response.json(await s.mfScannerReserve(b.run,b.requestId,b.kind));if(b.action==='scanner-complete')return Response.json(await s.mfScannerComplete(b.run,b.input));if(b.action==='private-detail')return Response.json(await s.mfPrivateDetail(b.isin,b.month));if(b.action==='private-read')return Response.json(await s.mfPrivateRead(b.isins,''));if(b.action==='begin')return Response.json(await s.mfBegin(b.run,b.manifest));if(b.action==='fragment')return Response.json(await s.mfFragment(b.run,b.fragment));if(b.action==='reports')return Response.json(await s.mfReports(b.run,b.reports));if(b.action==='checkpoint')return Response.json(await s.mfCheckpoint(b.run,b.companies));if(b.action==='finish')return Response.json(await s.mfFinish(b.run));if(b.action==='detail')return Response.json(await s.mfDetail(b.isin,b.month));if(b.action==='arm')return Response.json(await s.mfArm());if(b.action==='read')return Response.json(await s.mfRead(b.isins,b.cursor||''));return Response.json({capture:await s.mfRead(null,''),schedule:await s.mfScheduleStatus()});}};`);
writeFileSync(config,JSON.stringify({name:'mf-local-test',main:join(scratch,'entry.mjs'),compatibility_date:'2026-05-23',durable_objects:{bindings:[{name:'STORE',class_name:'CaptureRegistry'}]},migrations:[{tag:'v1',new_sqlite_classes:['CaptureRegistry']}]}));
let child,logs='';async function call(body={}){const r=await fetch(origin,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});assert(r.ok,await r.clone().text());return r.json();}
async function start(){child=spawn('npx',['--yes','--offline','wrangler@4','dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(scratch,'state')],{cwd:scratch,detached:true,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',c=>logs=(logs+c).slice(-12000));const until=Date.now()+90000;while(Date.now()<until){if(child.exitCode!==null)throw Error(logs);try{await call();return;}catch{}await new Promise(r=>setTimeout(r,300));}throw Error(logs);}
async function stop(){if(!child||child.exitCode!==null)return;const done=once(child,'exit');const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}}
const isin='INE090A01021',other='INE040A01034';const company={isin,name:'Fixture Bank',funds:[{id:'fixture:fund',name:'Fixture Fund',amc:'Fixture',months:{'2026-08':{shares:120,checkedAt:'2026-09-20T00:00:00Z'},'2026-07':{shares:100,checkedAt:'2026-08-20T00:00:00Z'}}}]};
try{
 await start();assert.equal((await call()).schedule.alarmAt,null);await call({action:'arm'});
 await call({action:'begin',run:'1:1',manifest:{targets:[isin,other],amcs:[{status:'ok',month:'2026-08'}],checkedAt:new Date().toISOString()}});await call({action:'checkpoint',run:'1:1',companies:[company]});await stop();await start();
 let state=await call();assert.equal(state.capture.meta.state,'collecting');assert.equal(state.capture.rows[0].netChange,20);assert(state.schedule.alarmAt);
 await call({action:'checkpoint',run:'1:1',companies:[{isin:other,name:'Second Bank',funds:[]}]});await call({action:'finish',run:'1:1'});await stop();await start();assert.equal((await call()).capture.meta.state,'complete');
 const detail=await call({action:'detail',isin});assert.equal(detail.company.funds[0].current.shares,120);assert.equal(detail.company.funds[0].months['2026-07'].shares,100);
 // Exercise a real large single-stock book over the actual RPC serializer.
 const seed=JSON.parse(readFileSync('public/data/mutual-funds/index.json'));const big=seed.rows.sort((a,b)=>(b.holders||0)-(a.holders||0))[0];const full=JSON.parse(readFileSync(`public/data/mutual-funds/companies/${big.isin}.json`)).company;
 await call({action:'begin',run:'2:1',manifest:{targets:[big.isin],amcs:[],checkedAt:new Date().toISOString()}});const fragments=companyFragments(full,64000);assert(fragments.length>1);await call({action:'fragment',run:'2:1',fragment:fragments[0]});await stop();await start();for(const fragment of fragments.slice(1))await call({action:'fragment',run:'2:1',fragment});await call({action:'finish',run:'2:1'});assert.equal((await call({action:'detail',isin:big.isin})).company.funds.length,full.funds.length);
 const fund=full.funds.find(f=>f.current?.shares>0);await call({action:'begin',run:'3:1',manifest:{targets:[big.isin],amcs:[],reportCount:1}});await call({action:'reports',run:'3:1',reports:[{id:fund.id,month:full.month,checkedAt:new Date().toISOString(),complete:true,isins:[]}]});await call({action:'checkpoint',run:'3:1',companies:[{isin:big.isin,name:full.name,funds:[]}]});await call({action:'finish',run:'3:1'});assert.equal((await call({action:'detail',isin:big.isin})).company.funds.find(f=>f.id===fund.id).current.shares,0);
 // Node SQLite permits more parameters than Cloudflare's 100-binding limit.
 // Exercise both the live 118-stock portfolio size and the full 250-stock API cap
 // against workerd, including duplicate IDs and a disjoint universe page.
 const many=Array.from({length:251},(_,i)=>({isin:`INE${String(i).padStart(9,'0')}`,name:`Scoped fixture ${i}`,funds:[]}));
 await call({action:'begin',run:'4:1',manifest:{targets:many.map(c=>c.isin),amcs:[]}});
 for(let at=0;at<many.length;at+=10)await call({action:'checkpoint',run:'4:1',companies:many.slice(at,at+10)});
 await call({action:'finish',run:'4:1'});
 for(const count of [100,101,118,250])assert.deepEqual((await call({action:'read',isins:many.slice(0,count).map(c=>c.isin).reverse()})).rows.map(r=>r.isin),many.slice(0,count).map(c=>c.isin));
 assert.equal((await call({action:'read',isins:Array(250).fill(many[0].isin)})).rows.length,1);
 assert.equal((await call({action:'read',isins:[]})).rows.length,0);
 const firstPage=await call({action:'read',isins:null}),secondPage=await call({action:'read',isins:null,cursor:firstPage.nextCursor});
 assert.equal(firstPage.rows.length,250);assert(secondPage.rows.some(r=>r.isin===many.at(-1).isin));
 assert.equal(new Set([...firstPage.rows,...secondPage.rows].map(r=>r.isin)).size,firstPage.rows.length+secondPage.rows.length);
 // The private supplemental path crosses the real RPC and SQLite boundaries.
 await call({action:'scanner-inventory',companies:[{isin:other,name:'Private fixture bank'}]});
 const reservation=await call({action:'scanner-reserve',run:'5:1',requestId:'1',kind:'stock'});
 const checkedAt=new Date().toISOString(),sourceUrl='https://mfscanner.com/stock/fixture-bank';
 const privatePage={isin:other,month:'2026-08',priorMonth:'2026-07',checkedAt,sourceUrl,reportedFunds:1,unreportedFunds:0,unknownAmcs:0,funds:[{id:'scanner:fixture-fund',name:'Private Fixture Fund',amc:'hdfc',months:Object.fromEntries([['2026-08',75],['2026-07',50]].map(([month,shares])=>[month,{shares,valueCr:null,pctOfAum:null,sourceUrl,source:'MF Scanner',checkedAt}]))}]};
 privatePage.funds=Array.from({length:800},(_,i)=>({...privatePage.funds[0],id:`scanner:fixture-fund-${i}`,name:`Private Fixture Fund ${i}`,months:Object.fromEntries(Object.entries(privatePage.funds[0].months).map(([m,p])=>[m,{...p,shares:p.shares+i}]))}));privatePage.reportedFunds=800;
 await call({action:'scanner-complete',run:'5:1',input:{reservation:reservation.reservation,isin:other,page:privatePage}});
 assert.equal((await call({action:'private-read',isins:[other]})).rows[0].totalShares,379600);
 assert.equal((await call({action:'read',isins:[other]})).rows[0].totalShares,null);
 assert.equal((await call({action:'private-detail',isin:other})).company.funds.length,800);
 await stop();await start();assert.equal((await call({action:'private-read',isins:[other]})).rows[0].totalShares,379600);
 console.log('PASS local Worker: Mutual Fund SQL, RPC, interrupted capture, retained history and alarm survive restart; large fund book and 250-company scope cross real runtime boundaries');
}finally{await stop();rmSync(scratch,{recursive:true,force:true});}
