import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readerKeys,encode64,sealForReader } from '../worker/mutual-funds-seal.mjs';

mkdirSync('.cache',{recursive:true});
const dir=mkdtempSync(resolve('.cache/mf-budget-runtime-')),port=19884,secret='isolated-runtime-fixture-key-123456789';
const config=join(dir,'wrangler.json'),entry=join(dir,'entry.mjs');
writeFileSync(entry,`import {CaptureRegistry} from ${JSON.stringify(resolve('worker/capture-registry-object.mjs'))};
import {readerKeys,encode64,openForReader} from ${JSON.stringify(resolve('worker/mutual-funds-seal.mjs'))};
import {mfRelease} from ${JSON.stringify(resolve('worker/mutual-funds-github.mjs'))};
export class BudgetFixture extends CaptureRegistry {
  constructor(ctx,env){super(ctx,{...env,MF_RUNTIME:'github'});}
  async retiredTimer(){await this.ctx.storage.put('mutual-funds-timer',{started:true});await this.ctx.storage.setAlarm(Date.now()+86400000);await this.alarm();return {arm:await this.mfArm(),alarmAt:await this.ctx.storage.getAlarm()};}
}
export default {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/metadata')return Response.json({assets:[]});
  if(url.pathname==='/release-runtime')return Response.json(await mfRelease({GH_REPO:'techmuns/Sattva-Central-Research'},{fetcher:(_url,options)=>fetch(new URL('/metadata',request.url),options),edgeCache:null}));
  if(url.pathname==='/timer')return Response.json(await env.FIXTURE.getByName('budget-fixture').retiredTimer());
  if(request.method==='POST'){const value=await request.json();return Response.json({text:new TextDecoder().decode(await openForReader(value,${JSON.stringify(secret)},'runtime-fixture'))});}
  const keys=await readerKeys(${JSON.stringify(secret)});return Response.json({kid:keys.kid,publicKey:encode64(keys.publicKey)});
}};`);
writeFileSync(config,JSON.stringify({name:'mf-budget-fixture',main:entry,compatibility_date:'2026-05-23',durable_objects:{bindings:[{name:'FIXTURE',class_name:'BudgetFixture'}]},migrations:[{tag:'fixture-v1',new_sqlite_classes:['BudgetFixture']}]}));
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
  const release=await fetch(origin+'/release-runtime');assert(release.ok);assert.deepEqual(await release.json(),{assets:[]},'GitHub metadata fetch uses a redirect mode supported by workerd');
  const timer=await fetch(origin+'/timer');assert(timer.ok);const state=await timer.json();assert.equal(state.alarmAt,null);assert.deepEqual(state.arm,{runtime:'github-actions',started:false});
  console.log('PASS actual local Worker: Node-to-Worker encrypted snapshot compatibility; an old MF alarm retires without dispatching and cannot be re-armed');
}finally{
  if(child&&child.exitCode===null){const done=once(child,'exit');const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);try{process.kill(-child.pid,'SIGTERM');await done;}finally{clearTimeout(timer);}}
  rmSync(dir,{recursive:true,force:true});
}
