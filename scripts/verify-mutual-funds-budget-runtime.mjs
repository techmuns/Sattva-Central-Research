import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readerKeys,encode64,sealForReader } from '../worker/mutual-funds-seal.mjs';
import {sealBackgroundView} from './lib/github-background-views.mjs';

mkdirSync('.cache',{recursive:true});
const dir=mkdtempSync(resolve('.cache/mf-budget-runtime-')),port=19884,secret='isolated-runtime-fixture-key-123456789';
const config=join(dir,'wrangler.json'),entry=join(dir,'entry.mjs');
writeFileSync(entry,`import {CaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
import {readerKeys,encode64,openForReader} from ${JSON.stringify(resolve('worker/mutual-funds-seal.mjs'))};
import {mfRelease} from ${JSON.stringify(resolve('worker/mutual-funds-github.mjs'))};
import {readBackgroundView} from ${JSON.stringify(resolve('worker/github-background-views.mjs'))};
import {exportMutualFunds} from ${JSON.stringify(resolve('worker/mutual-funds-export.mjs'))};
export class BudgetFixture extends CaptureRegistry {
  constructor(ctx,env){super(ctx,{...env,MF_RUNTIME:'github'});}
  async retiredTimer(){await this.ctx.storage.put('mutual-funds-timer',{started:true});await this.ctx.storage.setAlarm(Date.now()+86400000);await this.alarm();return {arm:await this.mfArm(),alarmAt:await this.ctx.storage.getAlarm()};}
  cursorExport(){
    this.mutualFunds.init();const sql=this.ctx.storage.sql;
    for(let n=0;n<400;n++)sql.exec('INSERT INTO mf_parts VALUES(?,?,?,?)','1:1','INE090A01021',n,'अ'.repeat(4000));
    const before=sql.exec('SELECT total_changes() n').one().n;let cursor=0,count=0,pages=0;
    for(;;){const page=exportMutualFunds(sql,'mf_parts',cursor);if(new TextEncoder().encode(JSON.stringify(page.rows)).byteLength>=2*1024*1024)throw Error('Oversized native cursor page');pages++;count+=page.rows.length;if(!page.cursor)break;cursor=page.cursor;}
    return {count,pages,writes:sql.exec('SELECT total_changes() n').one().n-before};
  }
}
export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/static-reader')return Response.json(await readBackgroundView({...env,GH_REPO:'techmuns/Sattva-Central-Research',GH_DISPATCH_TOKEN:${JSON.stringify(secret)}},request.url,'mutual-funds','fixture.json'));
  if(url.pathname==='/metadata')return Response.json({assets:[]});
  if(url.pathname==='/release-runtime')return Response.json(await mfRelease({GH_REPO:'techmuns/Sattva-Central-Research'},{fetcher:(_url,options)=>fetch(new URL('/metadata',request.url),options),edgeCache:null}));
  if(url.pathname==='/timer')return Response.json(await env.FIXTURE.getByName('budget-fixture').retiredTimer());
  if(url.pathname==='/export')return Response.json(await env.FIXTURE.getByName('export-fixture').cursorExport());
  if(request.method==='POST'){const value=await request.json();return Response.json({text:new TextDecoder().decode(await openForReader(value,${JSON.stringify(secret)},'runtime-fixture'))});}
  const keys=await readerKeys(${JSON.stringify(secret)});return Response.json({kid:keys.kid,publicKey:encode64(keys.publicKey)});
}};`);
const assets=join(dir,'public');mkdirSync(join(assets,'generated-views/mutual-funds'),{recursive:true});
const fixtureKeys=await readerKeys(secret);
writeFileSync(join(assets,'generated-views/mutual-funds/fixture.json'),(await sealBackgroundView({value:26.5,label:'Retained fixture'}, {kid:fixtureKeys.kid,publicKey:encode64(fixtureKeys.publicKey)},{repo:'techmuns/Sattva-Central-Research',feature:'mutual-funds',name:'fixture.json'})).bytes);
writeFileSync(config,JSON.stringify({assets:{directory:assets,binding:'ASSETS',run_worker_first:true},name:'mf-budget-fixture',main:entry,compatibility_date:'2026-05-23',durable_objects:{bindings:[{name:'FIXTURE',class_name:'BudgetFixture'}]},migrations:[{tag:'fixture-v1',new_sqlite_classes:['BudgetFixture']}]}));
const command=process.env.WRANGLER_BIN||'npx',prefix=process.env.WRANGLER_BIN?[]:['--yes','--offline','wrangler@4'];
let child,logs='';
try {
  child=spawn(command,[...prefix,'dev','--local','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',join(dir,'state')],{cwd:dir,detached:true,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',c=>logs=(logs+c).slice(-8000));
  const origin=`http://127.0.0.1:${port}`;let recipient;
  for(let at=0;at<180;at++) {
    if(child.exitCode!==null)throw Error(logs);
    try{const response=await fetch(origin,{signal:AbortSignal.timeout(1000)});if(response.ok){recipient=await response.json();break;}}catch{}
    await new Promise(r=>setTimeout(r,300));
  }
  if(!recipient)throw Error(logs);
  const expected=await readerKeys(secret);assert.equal(recipient.kid,expected.kid);
  const sealed=await sealForReader(new TextEncoder().encode('private fixture'),recipient,'runtime-fixture');
  const decrypted=await fetch(origin,{method:'POST',body:JSON.stringify(sealed)});assert(decrypted.ok);assert.equal((await decrypted.json()).text,'private fixture');
  const staticReader=await fetch(origin+'/static-reader');assert(staticReader.ok);assert.deepEqual(await staticReader.json(),{value:26.5,label:'Retained fixture'},'Prepared ciphertext decrypts and inflates through the actual local ASSETS binding');
  const release=await fetch(origin+'/release-runtime');assert(release.ok);assert.deepEqual(await release.json(),{assets:[]},'GitHub metadata fetch uses a redirect mode supported by workerd');
  const timer=await fetch(origin+'/timer');assert(timer.ok);const state=await timer.json();assert.equal(state.alarmAt,null);assert.deepEqual(state.arm,{runtime:'github-actions',started:false});
  const exported=await fetch(origin+'/export');assert(exported.ok);const copied=await exported.json();assert.equal(copied.count,400);assert(copied.pages>2);assert.equal(copied.writes,0,'Native cursor paging cannot modify the retained source');
  console.log('PASS actual local Worker: Node-to-Worker encrypted snapshot compatibility; an old MF alarm retires without dispatching and cannot be re-armed');
}finally{
  if(child&&child.exitCode===null){const done=once(child,'exit');const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}}
  rmSync(dir,{recursive:true,force:true});
}
