#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateTelegramCapture, TELEGRAM_REPO, TELEGRAM_ARTIFACT } from '../public/js/data/telegram-shared.js';
import { readTelegramCollector } from '../worker/telegram-collector.mjs';
const at = '2026-09-06T01:00:00.000Z';
const raw = { schemaVersion:2, channel:'researchreportss', route:'mtproto', lastCheckedAt:at, latestVerifiedAt:at,
  lastRun:{at,status:'ok'}, apiState:{newestSyncedId:500,historyOffsetId:400},
  posts:[{id:500,text:'Report',publishedAt:at,session:'NEVER-PUBLISH',sender:{phone:'NEVER-PUBLISH'}}],
  session:'NEVER-PUBLISH',api_hash:'NEVER-PUBLISH' };
const capture=validateTelegramCapture(raw);
const safety = {paused:false,reason:'rate-limit',failures:1,nextAttemptAt:new Date(Date.now()+86400000).toISOString()};
const scratch=mkdtempSync(join(tmpdir(),'telegram-safety-'));
try {
  for(const apiSafety of [safety,{paused:true,reason:'account-attention',failures:1,nextAttemptAt:null}]) {
    const input=join(scratch,'input.json'), restored=join(scratch,'restored.json'), packed=join(scratch,'capture.gz');
    // A connection error may happen while the retained archive still has the public-page route.
    writeFileSync(input,JSON.stringify({...raw,route:'embed+permalink',apiSafety:{...apiSafety,session:'NEVER-PUBLISH'}}));
    for(const args of [['failed',input],['restore',input,restored],['pack',restored,packed]])
      execFileSync(process.execPath,['scripts/telegram-artifact.mjs',...args],{env:{...process.env,GITHUB_ACTIONS:'false'}});
    const roundTrip=JSON.parse(gunzipSync(readFileSync(packed)));
    assert.deepEqual(roundTrip.apiSafety,apiSafety,'safety state survives health stamping, archive restore and publication');
    assert(!JSON.stringify(roundTrip).includes('NEVER-PUBLISH'));
  }
} finally {rmSync(scratch,{recursive:true,force:true});}
assert.equal(validateTelegramCapture({...raw,apiSafety:{...safety,nextAttemptAt:'invalid'}}).apiSafety.paused,true);
assert.equal(validateTelegramCapture({...raw,apiSafety:{reason:'unknown'}}).apiSafety.paused,true);
assert(!JSON.stringify(capture).includes('NEVER-PUBLISH'));
assert.equal(capture.apiState.newestSyncedId,500);
assert.throws(()=>validateTelegramCapture({...raw,channel:'another_channel'}));
assert.throws(()=>validateTelegramCapture({...raw,posts:[raw.posts[0],raw.posts[0]]}));
const bytes=gzipSync(JSON.stringify(capture));
const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
const run={id:1,name:'Telegram collection',head_branch:'main',head_repository:{full_name:TELEGRAM_REPO},event:'schedule',status:'completed',conclusion:'success'};
for (const scenario of ['ok','digest','host','fork','expired','failed','missing','bootstrap','oversize']) {
  const calls=[];
  const fetcher=async (url,options)=>{
    calls.push([url,options]);
    if(url.includes('.blob.core.windows.net')) {
      assert(!options.headers?.authorization,'GitHub token must never reach artifact storage');
      return new Response(bytes);
    }
    assert.equal(options.headers.authorization,'Bearer test-secret');
    if(url.includes('/runs?')) return Response.json({total_count:scenario==='missing'?0:1,workflow_runs:scenario==='missing' || (scenario==='bootstrap' && url.includes('status=success'))?[]:[{...run,...(scenario==='bootstrap'?{status:'in_progress',conclusion:null}:{}),...(scenario==='fork'?{head_repository:{full_name:'foreign/repository'}}:{}),...(scenario==='failed'?{conclusion:'failure'}:{})}]});
    if(url.includes('/artifacts?')) return Response.json({artifacts:[{id:2,name:TELEGRAM_ARTIFACT,expired:scenario==='expired',workflow_run:{id:1},digest:scenario==='digest'?'sha256:'+'0'.repeat(64):digest,size_in_bytes:scenario==='oversize'?100000000:bytes.length}]});
    if(url.endsWith('/zip')) return new Response(null,{status:302,headers:{location:scenario==='host'?'https://attacker.example/secret':'https://example.blob.core.windows.net/artifact'}});
    throw Error('Unexpected request '+url);
  };
  if(scenario==='ok') {
    const result=await readTelegramCollector({token:'test-secret',fetcher});
    assert.equal(result.capture.posts.length,1);
    assert.equal(result.source.collectorRunId,1);
    assert.equal(calls.length,5);
  } else if (['missing','bootstrap'].includes(scenario)) assert.equal(await readTelegramCollector({token:'test-secret',fetcher,allowMissing:true}),null);
  else await assert.rejects(()=>readTelegramCollector({token:'test-secret',fetcher}));
}
console.log('PASS Telegram artifacts: trusted workflow/repository, integrity, expiry, redirect and credential boundaries, first-run bootstrap');
// Exercise the actual Worker route, its conditional cache, and failure response entirely locally.
const worker = (await import('../worker/index.js')).default;
const savedFetch=globalThis.fetch, savedCaches=globalThis.caches;
const cache=new Map(), pending=[];
globalThis.caches={default:{async match(key){return cache.get(String(key))?.clone();},async put(key,res){cache.set(String(key),res.clone());}}};
let networkReads=0;
globalThis.fetch=async (url,options)=>{
  networkReads++;
  const path=String(url);
  if(path.includes('/runs?')) return Response.json({total_count:1,workflow_runs:[run]});
  if(path.includes('/artifacts?')) return Response.json({artifacts:[{id:2,name:TELEGRAM_ARTIFACT,expired:false,workflow_run:{id:1},digest,size_in_bytes:bytes.length}]});
  if(path.endsWith('/zip')) return new Response(null,{status:302,headers:{location:'https://example.blob.core.windows.net/artifact'}});
  assert(!options.headers?.authorization);
  return new Response(bytes);
};
try {
  const env={GH_DISPATCH_TOKEN:'test-secret'},ctx={waitUntil(p){pending.push(p);}};
  const response=await worker.fetch(new Request('https://local.test/api/telegram/posts'),env,ctx);
  assert.equal(response.status,200);
  assert.equal((await response.json()).posts[0].id,500);
  await Promise.all(pending);
  const repeat=await worker.fetch(new Request('https://local.test/api/telegram/posts',{headers:{'if-none-match':response.headers.get('etag')}}),env,ctx);
  assert.equal(repeat.status,304);
  assert.equal(networkReads,5,'edge cache avoids repeated GitHub/blob requests');
  assert.equal((await worker.fetch(new Request('https://local.test/api/telegram/posts',{method:'POST'}),env,ctx)).status,405);
  cache.clear();
  assert.equal((await worker.fetch(new Request('https://local.test/api/telegram/posts'),{},ctx)).status,503);
} finally {globalThis.fetch=savedFetch;globalThis.caches=savedCaches;}
console.log('PASS Telegram Worker route: artifact delivery, ETag, edge cache, GET-only and unavailable-source response');
