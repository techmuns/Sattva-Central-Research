// Local workerd exercises the provisioned class, SQLite RPCs and alarm persistence across restart.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
const scratch=mkdtempSync(join(tmpdir(),'breakouts-runtime-')),port=19874,origin=`http://127.0.0.1:${port}`;
const config=join(scratch,'wrangler.json');
const revision='a'.repeat(40);let redirectCommit=false,redirectRaw=false,followed=0;
const upstream=createServer((req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/redirect-target'){followed++;res.end('{}');return;}
 if((path==='/commits' && redirectCommit) || (path!=='/commits' && redirectRaw)) {res.writeHead(302,{location:'/redirect-target'}).end();return;}
 res.setHeader('content-type','application/json');res.setHeader('etag','"fixture"');
 res.end(JSON.stringify(path==='/commits'?[{sha:revision}]:path.endsWith('technicals.json')?{companies:[{ticker:'TEST'}]}:{TEST:[]}));
});
await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
writeFileSync(join(scratch,'entry.mjs'),`
import {CaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
import {handleTechnicals} from ${JSON.stringify(resolve('worker/breakouts.mjs'))};
export {CaptureRegistry};
export default {async fetch(request,env){const body=await request.json();
if(body.action==='daily') {
 const fetcher=(url,options)=>{const source=new URL(url);if(!['api.github.com','raw.githubusercontent.com'].includes(source.hostname))throw Error('Unexpected source');
   return fetch(${JSON.stringify(upstreamOrigin)}+(source.hostname==='api.github.com'?'/commits':source.pathname),options);};
 const result=await handleTechnicals(new Request('https://daily-fixture'+body.path),{ASSETS:{fetch:async()=>Response.json({fallback:true})}},{fetcher,edgeCache:null});
 return Response.json({status:result.status,revision:result.headers.get('x-sattva-revision'),delivery:result.headers.get('x-sattva-delivery'),data:await result.json()});
}
const store=env.STORE.getByName('breakout-local-fixture');
if(body.action==='arm')return Response.json(await store.breakoutArm());
if(body.action==='begin')return Response.json(await store.breakoutBegin(body.run,body.targets,false));
if(body.action==='checkpoint')return Response.json(await store.breakoutCheckpoint(body.run,body.rows,body.failures));
if(body.action==='finish')return Response.json(await store.breakoutFinish(body.run));
if(body.action==='recovery')return Response.json(await store.breakoutRecovery(body.run,body.ticker,body.from,body.to,body.rows));
if(body.action==='history')return Response.json(await store.breakoutHistory(body.ticker,body.before));
return Response.json({capture:await store.breakoutRead(),schedule:await store.breakoutScheduleStatus()});}};`);
writeFileSync(config,JSON.stringify({name:'breakout-local-test',main:join(scratch,'entry.mjs'),compatibility_date:'2026-05-23',durable_objects:{bindings:[{name:'STORE',class_name:'CaptureRegistry'}]},migrations:[{tag:'v1',new_sqlite_classes:['CaptureRegistry']}]}));
let child,logs='';
async function call(body={}){const res=await fetch(origin,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});assert(res.ok,await res.clone().text());return res.json();}
async function start(){child=spawn('npx',['--yes','--offline','wrangler@4','dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(scratch,'state')],{cwd:scratch,detached:true,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-12000);});const deadline=Date.now()+90000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error(logs);try{await call();return;}catch{}await new Promise(done=>setTimeout(done,400));}throw Error(logs);}
async function stop(){if(!child||child.exitCode!==null)return;const done=once(child,'exit'),timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}}
const at=Date.parse('2026-09-15T06:00Z'),row={ticker:'TEST',name:'Test',price:105,volume:2000,prevClose:98,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider:'Yahoo Finance',base:{high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'}};
try{
 await start();assert.equal((await call()).schedule.alarmAt,null);
 // Use native workerd fetch against a local HTTP source. A mocked fetch cannot
 // detect request options rejected by the production runtime before any I/O.
 const daily=await call({action:'daily',path:'/api/technicals'});
 assert.equal(daily.delivery,'repository');assert.equal(daily.revision,revision);assert.equal(daily.data.companies[0].ticker,'TEST');
 for(const file of ['atr-history','source']) {const companion=await call({action:'daily',path:'/api/technicals/'+file+'?revision='+revision});assert.equal(companion.status,200);assert.equal(companion.revision,revision);}
 redirectCommit=true;assert.equal((await call({action:'daily',path:'/api/technicals'})).delivery,'deployed-fallback');redirectCommit=false;
 redirectRaw=true;assert.equal((await call({action:'daily',path:'/api/technicals'})).delivery,'deployed-fallback');
 assert.equal((await call({action:'daily',path:'/api/technicals/atr-history?revision='+revision})).status,503);assert.equal(followed,0);redirectRaw=false;
 await call({action:'arm'});await stop();await start();
 assert((await call()).schedule.alarmAt);assert.equal((await call()).capture.state,'not-started');
 await call({action:'begin',run:'1:1',targets:['TEST','MISSING']});
 await call({action:'checkpoint',run:'1:1',rows:[row]});
 await stop();await start();
 let state=await call();assert.equal(state.capture.state,'collecting');assert.equal(state.capture.rows[0].price,105);assert(state.schedule.alarmAt);
 await call({action:'checkpoint',run:'1:1',rows:[],failures:[{ticker:'MISSING',reason:'unavailable'}]});await call({action:'finish',run:'1:1'});
 await call({action:'recovery',run:'1:1',ticker:'TEST',from:at-30*60000,to:at,rows:[{...row,kind:'recovered-candle'}]});
 await stop();await start();
 state=await call();assert.equal(state.capture.state,'complete');assert.equal(state.capture.failures.length,1);assert.equal(state.capture.recoveryPending.length,1);
 const history=await call({action:'history',ticker:'TEST'});assert.equal(history.rows.length,2);assert(history.rows.some(row=>row.kind==='recovered-candle'));
 assert.equal(state.capture.rows[0].kind,'quote');
 console.log('PASS local workerd: native daily-file fetch and redirect refusal; breakout SQL/RPC, incremental capture, failed targets, independent alarm, recovered candles and history survive restarts');
}finally{await stop();await new Promise(done=>upstream.close(done));rmSync(scratch,{recursive:true,force:true});}
