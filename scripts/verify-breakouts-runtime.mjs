// Local workerd exercises the provisioned class, SQLite RPCs and alarm persistence across restart.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const scratch=mkdtempSync(join(tmpdir(),'breakouts-runtime-')),port=19874,origin=`http://127.0.0.1:${port}`;
const config=join(scratch,'wrangler.json');
writeFileSync(join(scratch,'entry.mjs'),`
import {CaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
export {CaptureRegistry};
export default {async fetch(request,env){const body=await request.json(),store=env.STORE.getByName('breakout-local-fixture');
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
 console.log('PASS local workerd: breakout SQL/RPC, incremental capture, failed targets, independent alarm, recovered candles and history survive restarts');
}finally{await stop();rmSync(scratch,{recursive:true,force:true});}
