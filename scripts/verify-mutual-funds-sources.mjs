import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runSourcePool} from './lib/mutual-funds-source-pool.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mf-source-pool-test-'));
try {
  const script=path.join(dir,'source.mjs'),events=path.join(dir,'events'),checksFile=path.join(dir,'checks.json');
  fs.writeFileSync(script,`import fs from 'node:fs';import{spawn}from'node:child_process';
const slug=process.env.MF_SOURCE_AMCS;
fs.appendFileSync(process.env.EVENTS,JSON.stringify({slug,event:'start'})+'\\n');
if(slug==='failed')process.exit(2);
if(slug==='hanging'){
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
  console.log('PASS source isolation: bounded concurrency, hung source and descendant timeout, later-source progress, failed child, durable checkpoints, preserved check times and interruption');
} finally {fs.rmSync(dir,{recursive:true,force:true});}
