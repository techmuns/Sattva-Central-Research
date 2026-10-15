// Local workerd exercises the provisioned class, SQLite RPCs and alarm persistence across restart.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createServer as createPortFinder} from 'node:net';
import {gzipSync} from 'node:zlib';
mkdirSync('.cache',{recursive:true});const scratch=mkdtempSync(resolve('.cache/breakouts-runtime-'));
const finder=createPortFinder();await new Promise(done=>finder.listen(0,'127.0.0.1',done));const port=finder.address().port;await new Promise(done=>finder.close(done));const origin=`http://127.0.0.1:${port}`;
const config=join(scratch,'wrangler.json');
const revision='a'.repeat(40);let redirectCommit=false,redirectRaw=false,followed=0;
const upstream=createServer((req,res)=>{
 const path=new URL(req.url,'http://fixture').pathname;
 if(['/instruments','/quotes'].includes(path) && req.headers['user-agent']!=='SattvaCentralResearch/1.0'){res.writeHead(403).end('Application identification required');return;}
 if(path==='/instruments'){res.end(gzipSync(JSON.stringify([{segment:'NSE_EQ',instrument_key:'NSE_EQ|INE000000001',trading_symbol:'TEST'}])));return;}
 if(path==='/quotes'){assert.equal(req.headers.authorization,'Bearer local-fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'success',data:{TEST:{instrument_token:'NSE_EQ|INE000000001',symbol:'TEST',last_price:111,volume:2500,net_change:11,last_trade_time:Date.parse('2026-09-15T06:00Z')}}}));return;}
 if(path==='/redirect-target'){followed++;res.end('{}');return;}
 if((path==='/commits' && redirectCommit) || (path!=='/commits' && redirectRaw)) {res.writeHead(302,{location:'/redirect-target'}).end();return;}
 res.setHeader('content-type','application/json');res.setHeader('etag','"fixture"');
 res.end(JSON.stringify(path==='/commits'?[{sha:revision}]:path.endsWith('technicals.json')?{companies:[{ticker:'TEST'}]}:{TEST:[]}));
});
await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
const upstreamOrigin=`http://127.0.0.1:${upstream.address().port}`;
writeFileSync(join(scratch,'entry.mjs'),`
import {CaptureRegistry as BaseCaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
import {handleTechnicals} from ${JSON.stringify(resolve('worker/breakouts.mjs'))};
import {primaryInstruments,minuteQuotes} from ${JSON.stringify(resolve('worker/breakout-primary.mjs'))};
// Pin only the fixture store clock to its dated candles. The real alarm clock remains live
// across restarts; otherwise the five-day recovery assertion expires as calendar time advances.
export class CaptureRegistry extends BaseCaptureRegistry {
 constructor(state,env){super(state,env);this.breakouts.now=()=>Date.parse('2026-09-15T06:05Z');}
 fixtureBegin(run,targets){return this.breakouts.begin(run,targets,false);}
 fixtureCheckpoint(run,rows,failures){return this.breakouts.checkpoint(run,rows,failures);}
 fixtureFinish(run){return this.breakouts.finish(run);}
 fixtureRecovery(run,ticker,from,to,rows){return this.breakouts.recovery(run,ticker,from,to,rows);}
 fixturePrimary(input){return this.breakouts.primarySave(input);}
 fixtureInventory(targets){return this.breakoutPrimary.inventory(targets,false);}
 fixtureAlarm(){return this.ctx.storage.getAlarm();}
 async fixtureRetire(kind){await this.ctx.storage.put(kind==='primary'?'upstox-minute-timer':'breakout-timer',{started:true});await this.ctx.storage.setAlarm(Date.now()+86400000);await this.alarm();return this.ctx.storage.getAlarm();}
 async fixtureExport(input){const before=this.ctx.storage.sql.exec('SELECT total_changes() n').one().n;const exported=await this.breakoutExport(input);return {...exported,writes:this.ctx.storage.sql.exec('SELECT total_changes() n').one().n-before};}
}

export default {async fetch(request,env){const body=await request.json();
if(body.action==='native-upstox') {
 const fetcher=(url,options)=>fetch(${JSON.stringify(upstreamOrigin)}+(new URL(url).hostname==='assets.upstox.com'?'/instruments':'/quotes'),options);
 const instruments=await primaryInstruments('NSE',fetcher);
 const result=await minuteQuotes([{ticker:'TEST',upstoxSymbol:'TEST',instrumentKey:instruments[0].instrument_key}],new Map(),'local-fixture',{fetcher,now:()=>Date.parse('2026-09-15T06:00Z')});
 return Response.json({instruments,result});
}
if(body.action==='daily') {
 const fetcher=(url,options)=>{const source=new URL(url);if(!['api.github.com','raw.githubusercontent.com'].includes(source.hostname))throw Error('Unexpected source');
   return fetch(${JSON.stringify(upstreamOrigin)}+(source.hostname==='api.github.com'?'/commits':source.pathname),options);};
 const result=await handleTechnicals(new Request('https://daily-fixture'+body.path),{ASSETS:{fetch:async()=>Response.json({fallback:true})}},{fetcher,edgeCache:null});
 return Response.json({status:result.status,revision:result.headers.get('x-sattva-revision'),delivery:result.headers.get('x-sattva-delivery'),data:await result.json()});
}
const store=env.STORE.getByName('breakout-local-fixture');
if(body.action==='retire')return Response.json(await store.fixtureRetire(body.kind));
if(body.action==='blocked'){try{await store.breakoutBegin('99:1',['TEST'],false);return Response.json({blocked:false});}catch{return Response.json({blocked:true});}}
if(body.action==='export')return Response.json(await store.fixtureExport(body));
if(body.action==='begin')return Response.json(await store.fixtureBegin(body.run,body.targets));
if(body.action==='checkpoint')return Response.json(await store.fixtureCheckpoint(body.run,body.rows,body.failures));
if(body.action==='finish')return Response.json(await store.fixtureFinish(body.run));
if(body.action==='recovery')return Response.json(await store.fixtureRecovery(body.run,body.ticker,body.from,body.to,body.rows));
if(body.action==='history')return Response.json(await store.breakoutHistory(body.ticker,body.before));
if(body.action==='primary-save')return Response.json(await store.fixturePrimary(body.input));
if(body.action==='primary-inventory')return Response.json(await env.CAPTURE_REGISTRY.getByName('breakout-upstox:v1').fixtureInventory(body.targets));
return Response.json({capture:await store.breakoutRead(),schedule:await store.breakoutScheduleStatus(),alarmAt:await store.fixtureAlarm()});}};`);
writeFileSync(config,JSON.stringify({name:'breakout-local-test',main:join(scratch,'entry.mjs'),compatibility_date:'2026-05-23',durable_objects:{bindings:[{name:'STORE',class_name:'CaptureRegistry'},{name:'CAPTURE_REGISTRY',class_name:'CaptureRegistry'}]},migrations:[{tag:'v1',new_sqlite_classes:['CaptureRegistry']}]}));
let child,logs='';
async function call(body={}){const res=await fetch(origin,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});assert(res.ok,await res.clone().text());return res.json();}
async function start(){logs='';child=spawn(process.env.WRANGLER_BIN||'npx',[...(process.env.WRANGLER_BIN?[]:['--yes','--offline','wrangler@4']),'dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(scratch,'state')],{cwd:scratch,detached:true,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-12000);});const deadline=Date.now()+90000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error(logs);if(logs.includes('Ready on '+origin)){try{await call();return;}catch{}}await new Promise(done=>setTimeout(done,400));}throw Error(logs);}
async function stop(){if(!child||child.exitCode!==null)return;const done=once(child,'exit'),timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}}
const at=Date.parse('2026-09-15T06:00Z'),row={ticker:'TEST',name:'Test',price:105,volume:2000,prevClose:98,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider:'Yahoo Finance',base:{high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'},volumeBase:{average:1000,from:'2026-08-28',to:'2026-09-11',count:10,exchange:'NSE'}};
try{
 await start();assert.equal((await call()).alarmAt,null);
 const native=await call({action:'native-upstox'});assert.equal(native.instruments.length,1);assert.equal(native.result.rows[0].price,111);
 // Use native workerd fetch against a local HTTP source. A mocked fetch cannot
 // detect request options rejected by the production runtime before any I/O.
 const daily=await call({action:'daily',path:'/api/technicals'});
 assert.equal(daily.delivery,'repository');assert.equal(daily.revision,revision);assert.equal(daily.data.companies[0].ticker,'TEST');
 for(const file of ['atr-history','source']) {const companion=await call({action:'daily',path:'/api/technicals/'+file+'?revision='+revision});assert.equal(companion.status,200);assert.equal(companion.revision,revision);}
 redirectCommit=true;assert.equal((await call({action:'daily',path:'/api/technicals'})).delivery,'deployed-fallback');redirectCommit=false;
 redirectRaw=true;assert.equal((await call({action:'daily',path:'/api/technicals'})).delivery,'deployed-fallback');
 assert.equal((await call({action:'daily',path:'/api/technicals/atr-history?revision='+revision})).status,503);assert.equal(followed,0);redirectRaw=false;
 assert.equal(await call({action:'retire',kind:'capture'}),null);assert.equal(await call({action:'retire',kind:'primary'}),null);assert.deepEqual(await call({action:'blocked'}),{blocked:true});await stop();await start();
 assert.equal((await call()).alarmAt,null);assert.equal((await call()).capture.state,'not-started');
 await call({action:'begin',run:'1:1',targets:['TEST','MISSING']});
 await call({action:'checkpoint',run:'1:1',rows:[row]});
 await stop();await start();
 let state=await call();assert.equal(state.capture.state,'collecting');assert.equal(state.capture.rows[0].price,105);assert.equal(state.alarmAt,null);
 assert.deepEqual(state.capture.rows[0].volumeBase,row.volumeBase,'dated momentum volume history survives real SQLite RPC and restart');
 await call({action:'checkpoint',run:'1:1',rows:[],failures:[{ticker:'MISSING',reason:'unavailable'}]});await call({action:'finish',run:'1:1'});
 await call({action:'recovery',run:'1:1',ticker:'TEST',from:at-30*60000,to:at,rows:[{...row,kind:'recovered-candle'}]});
 await stop();await start();
 state=await call();assert.equal(state.capture.state,'complete');assert.equal(state.capture.failures.length,1);assert.equal(state.capture.recoveryPending.length,1);
 const history=await call({action:'history',ticker:'TEST'});assert.equal(history.rows.length,2);assert(history.rows.some(row=>row.kind==='recovered-candle'));
 assert.equal(state.capture.rows[0].kind,'quote');
 const minuteAt=at+60000;
 await call({action:'primary-inventory',targets:Array.from({length:1000},(_,i)=>({ticker:'T'+i,name:'Long instrument name '.repeat(7)}))});
 await call({action:'primary-save',input:{at:minuteAt,completedAt:minuteAt,targets:['TEST'],rows:[{...row,provider:'Upstox',price:111}],failures:[]}});
 await stop();await start();
 const retained=await call({action:'history',ticker:'TEST'});assert.equal(retained.rows.length,3);assert.equal(retained.rows[0].provider,'Upstox');
 assert((await call()).capture.primary);
 // Migrate both retained stores from NSE to BSE, whose last trade can be older.
 const handoverAt=at+4*60000;
 const bse={...row,exchange:'BSE',volumeBase:{...row.volumeBase,exchange:'BSE'},quoteAt:new Date(at-60000).toISOString(),checkedAt:new Date(handoverAt).toISOString(),price:104};
 await call({action:'begin',run:'2:1',targets:['TEST']});
 await call({action:'checkpoint',run:'2:1',rows:[bse]});await call({action:'finish',run:'2:1'});
 await call({action:'primary-save',input:{at:handoverAt,completedAt:handoverAt,targets:['TEST'],rows:[{...bse,provider:'Upstox',feedAt:bse.checkedAt}],failures:[]}});
 await stop();await start();
 state=await call();assert.equal(state.capture.rows[0].exchange,'BSE');assert.equal(state.capture.rows[0].price,104);
 assert.equal(state.capture.primary.primaryUsed,1);assert.equal(state.capture.primary.failures.length,0);
 const exported=await call({action:'export',table:'breakout_quotes',cursor:0});assert.equal(exported.writes,0);assert(exported.rows.length>0);
 console.log('PASS local workerd: native gzip and authenticated Upstox quote fetch; daily-file redirects; minute/fallback SQL history, large inventory, read-only source export, rejected collector writes, retired alarms and recovery survive restarts');
}catch(error){writeFileSync(resolve('.cache/breakout-runtime-last-failure.log'),logs);throw error;}finally{await stop();await new Promise(done=>upstream.close(done));rmSync(scratch,{recursive:true,force:true});}
