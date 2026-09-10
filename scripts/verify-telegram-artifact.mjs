#!/usr/bin/env node
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateTelegramCapture, TELEGRAM_REPO, TELEGRAM_ARTIFACT, TELEGRAM_HEAD_ARTIFACT, telegramCatchupRanges } from '../public/js/data/telegram-shared.js';
import { readTelegramCollector } from '../worker/telegram-collector.mjs';
import { mergeTelegramRestore } from './telegram-artifact.mjs';
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
    const publicSafety = { reason:'rate-limit', nextAttemptAt:safety.nextAttemptAt };
    writeFileSync(input,JSON.stringify({...raw,route:'embed+permalink',publicSafety:{...publicSafety,session:'NEVER-PUBLISH'},apiSafety:{...apiSafety,session:'NEVER-PUBLISH'}}));
    for(const args of [['failed',input],['restore',input,restored],['backup',restored,restored],['pack',restored,packed]])
      execFileSync(process.execPath,['scripts/telegram-artifact.mjs',...args],{env:{...process.env,GITHUB_ACTIONS:'false'}});
    const roundTrip=JSON.parse(gunzipSync(readFileSync(packed)));
    assert.deepEqual(roundTrip.apiSafety,apiSafety,'safety state survives health stamping, archive restore and publication');
    assert.deepEqual(roundTrip.publicSafety,publicSafety,'public source retry deadlines survive every publication step');
    assert(!JSON.stringify(roundTrip).includes('NEVER-PUBLISH'));
  }
} finally {rmSync(scratch,{recursive:true,force:true});}
assert.equal(validateTelegramCapture({...raw,apiSafety:{...safety,nextAttemptAt:'invalid'}}).apiSafety.paused,true);
assert.equal(validateTelegramCapture({...raw,apiSafety:{reason:'unknown'}}).apiSafety.paused,true);
assert.throws(()=>validateTelegramCapture({...raw,publicSafety:{reason:'rate-limit',nextAttemptAt:'invalid'}}));
assert(!JSON.stringify(capture).includes('NEVER-PUBLISH'));
assert.equal(capture.apiState.newestSyncedId,500);
assert.deepEqual(telegramCatchupRanges([{from:20,to:30},{from:10,to:19},{from:25,to:40},{from:50,to:50}]),[{from:10,to:40},{from:50,to:50}]);
assert.deepEqual(validateTelegramCapture({...raw,catchupRanges:[{from:501,to:600}]}).catchupRanges,[{from:501,to:600}]);
for (const ranges of [null, {}, [{from:0,to:1}], [{from:20,to:10}], [{from:1,to:Infinity}]]) assert.throws(()=>telegramCatchupRanges(ranges));
assert.throws(()=>validateTelegramCapture({...raw,channel:'another_channel'}));
assert.throws(()=>validateTelegramCapture({...raw,posts:[raw.posts[0],raw.posts[0]]}));
const restoredWithPause=mergeTelegramRestore({...raw,lastRun:{at:'2026-09-06T02:00:00Z',status:'ok'},catchupRanges:[{from:501,to:505}]},
  {...raw,publicSafety:{reason:'rate-limit',nextAttemptAt:'2099-01-01T00:00:00Z'},apiSafety:{paused:true,reason:'account-attention',failures:1},posts:[...raw.posts,{id:499,text:'Retained backfill'}]});
assert.equal(restoredWithPause.apiSafety.paused,true,'newer backup metadata does not authorize clearing a source checkpoint account pause');
assert.equal(restoredWithPause.publicSafety.nextAttemptAt,'2099-01-01T00:00:00Z');
assert.deepEqual(restoredWithPause.catchupRanges,[{from:501,to:505}]);
assert.deepEqual(restoredWithPause.posts.map(p=>p.id),[500,499],'restore merges retained IDs independently of backup arrival order');
const resumed=mergeTelegramRestore({...raw,apiSafety:{paused:true,reason:'account-attention',failures:1}},
  {...raw,lastRun:{at:'2026-09-06T02:00:00Z',status:'ok'},apiSafety:null});
assert.equal(resumed.apiSafety,null,'a newer final source checkpoint can record an actual reviewed resume');
const fallbackText = mergeTelegramRestore({...raw,lastRun:{at:'2026-09-06T02:00:00Z',status:'ok'},posts:[{...raw.posts[0],text:'Recovered text',firstSeenAt:'2026-09-05T22:00:00Z'}]},
  {...raw,lastRun:{at:'2026-09-06T02:30:00Z',status:'ok'},posts:[{...raw.posts[0],text:null,firstSeenAt:null,publishedAt:'2026-09-06T02:30:00Z'}]});
assert.equal(fallbackText.posts[0].text,'Recovered text','newer empty text cannot wipe older non-empty text');
assert.equal(fallbackText.posts[0].firstSeenAt,'2026-09-05T22:00:00Z','newer missing firstSeenAt cannot wipe older firstSeenAt');
const bytes=gzipSync(JSON.stringify(capture));
const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
const run={id:1,name:'Telegram collection (github-cron)',display_title:'Telegram collection (github-cron)',head_branch:'main',head_repository:{full_name:TELEGRAM_REPO},event:'schedule',status:'completed',conclusion:'success'};
assert.match(readFileSync('.github/workflows/telegram-refresh.yml','utf8'),/^run-name: Telegram collection \(/m,'workflow must identify artifact-producing runs in the REST run name');
assert.match(readFileSync('.github/workflows/telegram-archive.yml','utf8'),/telegram-artifact\.mjs backup /,'daily backups use read-only recovery rather than authorizing another source collection');
for (const scenario of ['ok','digest','host','fork','expired','failed','missing','legacy','bootstrap','oversize']) {
  const calls=[];
  const fetcher=async (url,options)=>{
    calls.push([url,options]);
    if(url.includes('.blob.core.windows.net')) {
      assert(!options.headers?.authorization,'GitHub token must never reach artifact storage');
      return new Response(bytes);
    }
    assert.equal(options.headers.authorization,'Bearer test-secret');
    if(url.includes('/runs?')) return Response.json({total_count:scenario==='missing'?0:1,workflow_runs:scenario==='missing' || (scenario==='bootstrap' && url.includes('status=success'))?[]:[{...run,...(scenario==='bootstrap'?{status:'in_progress',conclusion:null}:{}),...(scenario==='legacy'?{name:'Telegram refresh (auto)'}:{}),...(scenario==='fork'?{head_repository:{full_name:'foreign/repository'}}:{}),...(scenario==='failed'?{conclusion:'failure'}:{})}]});
    if(url.includes('/artifacts?')) return Response.json({artifacts:[{id:2,name:TELEGRAM_ARTIFACT,expired:scenario==='expired',workflow_run:{id:1},digest:scenario==='digest'?'sha256:'+'0'.repeat(64):digest,size_in_bytes:scenario==='oversize'?100000000:bytes.length}]});
    if(url.endsWith('/zip')) return new Response(null,{status:302,headers:{location:scenario==='host'?'https://attacker.example/secret':'https://example.blob.core.windows.net/artifact'}});
    throw Error('Unexpected request '+url);
  };
  if(scenario==='ok' || scenario==='failed') {
    const result=await readTelegramCollector({token:'test-secret',fetcher});
    assert.equal(result.capture.posts.length,1);
    assert.equal(result.source.collectorRunId,1);
    assert.equal(calls.length,5);
    assert.equal(result.source.collectorLatestFailed,scenario==='failed');
  } else if (['missing','legacy','bootstrap'].includes(scenario)) assert.equal(await readTelegramCollector({token:'test-secret',fetcher,allowMissing:true,
    ...(scenario==='bootstrap'?{purpose:'restore',excludeRunId:1}:{})}),null);
  else await assert.rejects(()=>readTelegramCollector({token:'test-secret',fetcher}));
}
// Simulate immutable checkpoints across several trusted runs, including an early head
// upload while the same run continues collecting historical messages.
function deliveryFixture(definitions) {
  const calls = [], downloads = new Map();
  const workflowRuns = definitions.map(({id,status='completed',conclusion='success',run_attempt=1}) => ({...run,id,status,conclusion,run_attempt}));
  const records = new Map(definitions.map(definition => [definition.id, (definition.artifacts || []).map((item,index) => {
    const id=definition.id*10+index;
    const body=item.bytes || gzipSync(JSON.stringify(item.capture || capture));
    downloads.set(id,body);
    return {id,name:item.name || (item.phase==='head'?TELEGRAM_HEAD_ARTIFACT:TELEGRAM_ARTIFACT),expired:!!item.expired,
      workflow_run:{id:definition.id},size_in_bytes:body.length,
      digest:item.corrupt?'sha256:'+'0'.repeat(64):'sha256:'+createHash('sha256').update(body).digest('hex')};
  })]));
  return {calls,fetcher:async (url,options)=>{
    calls.push(String(url));
    if(String(url).includes('.blob.core.windows.net')) {
      assert.equal(options.headers?.authorization,undefined,'fallback/checkpoint downloads must not receive the GitHub credential');
      return new Response(downloads.get(Number(new URL(url).pathname.slice(1))));
    }
    assert.equal(options.headers.authorization,'Bearer test-secret');
    if(String(url).includes('/runs?')) {
      const query=new URL(url).searchParams, size=Number(query.get('per_page') || 10), page=Number(query.get('page') || 1);
      const selected=query.get('status')==='success'?workflowRuns.filter(r=>r.status==='completed'&&r.conclusion==='success'):workflowRuns;
      return Response.json({total_count:selected.length,workflow_runs:selected.slice((page-1)*size,page*size)});
    }
    const attempt=String(url).match(/actions\/runs\/(\d+)\/attempts\/1\/jobs/);
    if(attempt)return Response.json(definitions.find(item=>item.id===Number(attempt[1]))?.jobs || {total_count:0,jobs:[]});
    const runId=String(url).match(/actions\/runs\/(\d+)\/artifacts/);
    if(runId)return Response.json({artifacts:records.get(Number(runId[1]))||[]});
    const artifactId=String(url).match(/artifacts\/(\d+)\/zip$/);
    if(artifactId)return new Response(null,{status:302,headers:{location:`https://example.blob.core.windows.net/${artifactId[1]}`}});
    throw Error('Unexpected fixture request');
  }};
}
const readFixture=(fixture,options={})=>readTelegramCollector({token:'test-secret',fetcher:fixture.fetcher,...options});
for (const latestArtifacts of [[],[{corrupt:true}],[{expired:true}],[{bytes:Buffer.from('invalid gzip')}]] ) {
  const fixture=deliveryFixture([{id:3,artifacts:latestArtifacts},{id:2,artifacts:[{}]}]);
  const result=await readFixture(fixture);
  assert.equal(result.source.collectorRunId,2);
  assert.equal(result.source.collectorFallback,true);
  assert.equal(result.source.status,'partial','an older good artifact is availability, not proof that the newest capture is healthy');
  assert.deepEqual(result.source.collectorSkippedRuns.map(r=>r.id),[3]);
  await assert.rejects(()=>readFixture(fixture,{purpose:'restore'}),/safety/,'display fallback must not silently reset an unknown newer source pause');
}
const head=deliveryFixture([{id:3,status:'in_progress',conclusion:null,artifacts:[{phase:'head'}]},{id:2,artifacts:[{}]}]);
const beforeHead=deliveryFixture([{id:3,status:'in_progress',conclusion:null},{id:2,artifacts:[{}]}]);
const beforeHeadResult=await readFixture(beforeHead);
assert.equal(beforeHeadResult.source.collectorRunId,2);
assert.equal(beforeHeadResult.source.collectorActiveRunId,3);
assert.equal(beforeHeadResult.source.collectorInProgress,true);
assert.equal(beforeHeadResult.source.status,'ok','a normal pre-upload interval does not make the retained valid capture unhealthy');
assert.equal(beforeHeadResult.source.degraded,false);
assert.deepEqual(beforeHeadResult.source.collectorSkippedRuns,[]);
await assert.rejects(()=>readFixture(beforeHead,{purpose:'restore'}),/safety/,'read-only pending publication is not permission to start another collection');
const headResult=await readFixture(head);
assert.equal(headResult.source.collectorRunId,3);
assert.equal(headResult.source.collectorArtifactPhase,'head');
assert.equal(headResult.source.collectorInProgress,true);
assert.equal(headResult.source.status,'ok','a valid early checkpoint is expected delivery while history continues');
assert.equal(headResult.source.degraded,false);
assert.equal(headResult.source.collectorLatestCompletedRunId,2);
await assert.rejects(()=>readFixture(head,{purpose:'restore'}),/safety/);
const selfExcluded=await readFixture(head,{purpose:'restore',excludeRunId:3});
assert.equal(selfExcluded.source.collectorRunId,2,'the collecting workflow excludes itself during restore');
await assert.rejects(()=>readFixture(head,{purpose:'restore',excludeRunId:3,runAttempt:2}),/safety/,
  'a rerun cannot exclude an earlier attempt with the same run ID and silently discard its unknown safety state');
await assert.rejects(()=>readFixture(head,{purpose:'restore',excludeRunId:99,runAttempt:2}),/safety/,
  'a rerun outside the recent inventory still cannot bypass the previous attempt safety state');
const interruptedHead=deliveryFixture([{id:3,conclusion:'failure',artifacts:[{phase:'head'}]},{id:2,artifacts:[{}]}]);
assert.equal((await readFixture(interruptedHead)).source.collectorLatestFailed,true);
await assert.rejects(()=>readFixture(interruptedHead,{purpose:'restore'}),/final checkpoint/);
const finalPreferred=deliveryFixture([{id:3,artifacts:[{phase:'head'},{capture:{...capture,posts:[{...capture.posts[0],text:'Final caption'}]}}]}]);
assert.equal((await readFixture(finalPreferred)).capture.posts[0].text,'Final caption','the final artifact wins over the early checkpoint from the same run');
const damagedFinal=deliveryFixture([{id:3,artifacts:[{corrupt:true},{phase:'head'}]}]);
assert.equal((await readFixture(damagedFinal)).source.collectorArtifactPhase,'head');
await assert.rejects(()=>readFixture(damagedFinal,{purpose:'restore'}),/safety/);
const oldFailure=deliveryFixture([{id:3,status:'in_progress',conclusion:null,artifacts:[{phase:'head'}]},{id:2,conclusion:'failure',artifacts:[{}]}]);
assert.equal((await readFixture(oldFailure)).source.degraded,false,'an older failed workflow does not invalidate a newer clean head checkpoint');
assert.equal((await readFixture(oldFailure)).source.collectorLatestFailed,false);
const repeatedFailures=deliveryFixture([{id:5,conclusion:'failure'},{id:4,conclusion:'failure'},{id:3,conclusion:'failure'},{id:2,artifacts:[{}]}]);
assert.equal((await readFixture(repeatedFailures)).source.collectorRunId,2,'repeated failures cannot crowd the retained successful baseline out of bounded display recovery');
assert.equal(repeatedFailures.calls.filter(url=>/actions\/runs\/\d+\/artifacts/.test(url)).length,3);
const failedFinal=deliveryFixture([{id:3,conclusion:'failure',artifacts:[{capture:{...capture,lastRun:{at,status:'failed'},
  publicSafety:{reason:'rate-limit',nextAttemptAt:'2099-01-01T00:00:00Z'},apiSafety:{paused:true,reason:'account-attention',failures:1}}}]}]);
const safeFailedRestore=await readFixture(failedFinal,{purpose:'restore'});
assert.equal(safeFailedRestore.capture.publicSafety.nextAttemptAt,'2099-01-01T00:00:00Z');
assert.equal(safeFailedRestore.capture.apiSafety.paused,true,'a valid final health artifact is retained even if the workflow later failed');
const bounded=deliveryFixture([{id:5},{id:4},{id:3},{id:2,artifacts:[{}]}]);
await assert.rejects(()=>readFixture(bounded));
assert.equal(bounded.calls.filter(url=>/actions\/runs\/\d+\/artifacts/.test(url)).length,3,'fallback never walks an unbounded Actions archive');
function preSourceFailureJobs(id) {
  const names=['Set up job','Run actions/checkout@v5','Run actions/setup-node@v5',
    'Restore retained collection independently of archive PRs','Collect recent public posts before historical work',
    'Collect channel through official API or public fallback','Post Run actions/setup-node@v5','Complete job'];
  return {total_count:1,jobs:[{name:'collect',run_id:id,status:'completed',conclusion:'failure',
    steps:names.map((name,index)=>({name,number:index+1,status:'completed',conclusion:index===3?'failure':[4,5].includes(index)?'skipped':'success'}))}]};
}
const safeRestoreFailures=deliveryFixture([{id:4,conclusion:'failure',jobs:preSourceFailureJobs(4)},
  {id:3,conclusion:'failure',jobs:preSourceFailureJobs(3)},{id:2,conclusion:'failure',jobs:preSourceFailureJobs(2)},
  {id:1,artifacts:[{capture:{...capture,publicSafety:{reason:'rate-limit',nextAttemptAt:'2099-01-01T00:00:00Z'}}}]}]);
const recoveredRestore=await readFixture(safeRestoreFailures,{purpose:'restore'});
assert.equal(recoveredRestore.source.collectorRunId,1,'contiguous proven pre-source failures cannot permanently block a retained safety checkpoint');
assert.equal(recoveredRestore.capture.publicSafety.nextAttemptAt,'2099-01-01T00:00:00Z');
assert.equal(safeRestoreFailures.calls.filter(url=>url.includes('/attempts/1/jobs')).length,3);
for (const scenario of ['source-started','recent-started','unknown-step','missing-source-step','extra-job','cancelled','timeout','rerun','unknown-status']) {
  const jobs=preSourceFailureJobs(3);
  if(scenario==='source-started')jobs.jobs[0].steps[5].conclusion='failure';
  if(scenario==='recent-started')jobs.jobs[0].steps[4].conclusion='success';
  if(scenario==='unknown-step')jobs.jobs[0].steps[2].name='Unrecognised source setup';
  if(scenario==='missing-source-step')jobs.jobs[0].steps.splice(5,1);
  if(scenario==='extra-job'){jobs.total_count=2;jobs.jobs.push({...jobs.jobs[0],name:'other'});}
  const definition={id:3,conclusion:scenario==='cancelled'?'cancelled':scenario==='timeout'?'timed_out':'failure',jobs,
    ...(scenario==='rerun'?{run_attempt:2}:{}),...(scenario==='unknown-status'?{status:'waiting'}:{})};
  const fixture=deliveryFixture([definition,{id:2,artifacts:[{}]}]);
  await assert.rejects(()=>readFixture(fixture,{purpose:'restore'}),/safety/,
    `${scenario} cannot establish that newer source safety is unchanged`);
  assert(!fixture.calls.some(url=>url.includes('/runs/2/artifacts')),'restore stops before crossing any unproven intervening run');
}
const unknownMiddle=deliveryFixture([{id:4,conclusion:'failure',jobs:preSourceFailureJobs(4)},
  {id:3,conclusion:'failure'},{id:2,conclusion:'failure',jobs:preSourceFailureJobs(2)},{id:1,artifacts:[{}]}]);
await assert.rejects(()=>readFixture(unknownMiddle,{purpose:'restore'}),/safety/);
assert(!unknownMiddle.calls.some(url=>url.includes('/runs/2/artifacts')),'restore cannot jump across an unverified middle run to the successful baseline');
const longFailureChain=deliveryFixture([...Array.from({length:11},(_,index)=>({id:12-index,conclusion:'failure',jobs:preSourceFailureJobs(12-index)})),{id:1,artifacts:[{}]}]);
assert.equal((await readFixture(longFailureChain,{purpose:'restore'})).source.collectorRunId,1,'eleven pre-source failures must not deadlock the next collection');
const exhaustedRestore=deliveryFixture([...Array.from({length:501},(_,index)=>({id:502-index,conclusion:'failure',jobs:preSourceFailureJobs(502-index)})),{id:1,artifacts:[{}]}]);
await assert.rejects(()=>readFixture(exhaustedRestore,{purpose:'restore'}),/bounded recovery budget/);
assert.equal(exhaustedRestore.calls.filter(url=>url.includes('/attempts/1/jobs')).length,500,'a degraded provider cannot cause unbounded proof requests');

// Authenticated job evidence from the 8 September incident: collection and packaging
// succeeded, but GitHub's finalization service returned 403 after the head was published.
const incidentJobs=JSON.parse(readFileSync('scripts/fixtures/telegram-upload-failure-jobs.json','utf8'));
function uploadFailureJobs(id) {
  const value=structuredClone(incidentJobs);
  value.jobs[0].run_id=id;
  return value;
}
const publicHead={...capture,route:'embed+permalink',apiSafety:{paused:true,reason:'account-attention',failures:1,nextAttemptAt:null},
  publicSafety:{reason:'rate-limit',nextAttemptAt:'2099-01-01T00:00:00Z'},historyNextId:400,catchupRanges:[{from:501,to:550}]};
const incidentChain=deliveryFixture([...Array.from({length:205},(_,index)=>({id:207-index,conclusion:'failure',jobs:preSourceFailureJobs(207-index)})),
  {id:2,conclusion:'failure',jobs:uploadFailureJobs(2),artifacts:[{phase:'head',capture:publicHead}]},{id:1,artifacts:[{}]}]);
const incidentRecovery=await readFixture(incidentChain,{purpose:'restore'});
assert.equal(incidentRecovery.source.collectorRunId,2);
assert.equal(incidentRecovery.source.collectorRecovery,'public-upload-failure');
assert.equal(incidentRecovery.source.degraded,true,'restoring a checkpoint does not certify fresh collection');
assert.equal(incidentRecovery.capture.lastCheckedAt,publicHead.lastCheckedAt,'recovery cannot fabricate a source check');
assert.deepEqual(incidentRecovery.capture.publicSafety,publicHead.publicSafety);
assert.deepEqual(incidentRecovery.capture.apiSafety,publicHead.apiSafety,'head recovery cannot clear a retained account pause');
assert.equal(incidentRecovery.capture.historyNextId,400,'unpublished historical work is replayed from the retained cursor');
assert.deepEqual(incidentRecovery.capture.catchupRanges,publicHead.catchupRanges);
assert.equal(incidentChain.calls.filter(url=>url.includes('/runs?')).length,3,'restore audits every intervening page');
assert(!incidentChain.calls.some(url=>url.includes('/runs/1/artifacts')),'a successful baseline cannot bypass the newer head');
const modernUploadJobs=uploadFailureJobs(2);
const uploadIndex=modernUploadJobs.jobs[0].steps.findIndex(step=>step.name==='Run actions/upload-artifact@v7');
modernUploadJobs.jobs[0].steps.splice(uploadIndex,1,...[
  ['Deliver final Telegram checkpoint','failure'],['Prepare final checkpoint retry','success'],
  ['Retry final Telegram checkpoint','failure'],['Prepare second final checkpoint retry','success'],
  ['Retry final Telegram checkpoint once more','failure'],['Checkpoint delivery health','failure'],
].map(([name,conclusion])=>({name,conclusion,status:'completed'})));
modernUploadJobs.jobs[0].steps.forEach((step,index)=>{step.number=index+1;});
const modernRecovery=await readFixture(deliveryFixture([{id:2,conclusion:'failure',jobs:modernUploadJobs,artifacts:[{phase:'head',capture:publicHead}]}]),{purpose:'restore'});
assert.equal(modernRecovery.source.collectorRecovery,'public-upload-failure','exhausted immutable retries can recover on the next scheduled run');
for (const [name,conclusion] of [
  ['Collect recent public posts before historical work','failure'],
  ['Collect channel through official API or public fallback','failure'],
  ['Preserve a failed source check explicitly','success'],
  ['Preserve a failed recent source check','success'],
  ['Run actions/setup-python@v6','success'],
  ['Install official API client outside the repository','success'],
  ['Validate and package only public channel data','failure'],
  ['Collection health','failure'],
]) {
  const evidence=uploadFailureJobs(2);
  evidence.jobs[0].steps.find(step=>step.name===name).conclusion=conclusion;
  const fixture=deliveryFixture([{id:2,conclusion:'failure',jobs:evidence,artifacts:[{phase:'head',capture:publicHead}]},{id:1,artifacts:[{}]}]);
  await assert.rejects(()=>readFixture(fixture,{purpose:'restore'}),/safety/,`${name} cannot authorize replay after unknown source safety`);
  assert(!fixture.calls.some(url=>url.includes('/runs/1/artifacts')));
}
for(const variant of ['account-head','rerun','cancelled','unknown-work','wrong-order','duplicate-step']) {
  const evidence=uploadFailureJobs(2);
  if(variant==='unknown-work')evidence.jobs[0].steps.push({name:'Unrecognised collection after packaging',number:40,status:'completed',conclusion:'success'});
  if(variant==='duplicate-step')evidence.jobs[0].steps.push({...evidence.jobs[0].steps[0],number:40});
  if(variant==='wrong-order')evidence.jobs[0].steps.find(step=>step.name==='Collect channel through official API or public fallback').number=39;
  const fixture=deliveryFixture([{id:2,conclusion:variant==='cancelled'?'cancelled':'failure',run_attempt:variant==='rerun'?2:1,jobs:evidence,
    artifacts:[{phase:'head',capture:variant==='account-head'?capture:publicHead}]},{id:1,artifacts:[{}]}]);
  await assert.rejects(()=>readFixture(fixture,{purpose:'restore'}),/safety/,variant);
}
for(const name of ['telegram-posts-retry-1.json.gz','telegram-posts-retry-2.json.gz']) {
  const fixture=deliveryFixture([{id:2,artifacts:[{name,capture:publicHead}]}]);
  for(const purpose of ['delivery','restore']) {
    const result=await readFixture(fixture,{purpose});
    assert.equal(result.source.collectorArtifactPhase,'final','a verified publication retry carries final safety state');
    assert.deepEqual(result.capture.apiSafety,publicHead.apiSafety);
  }
  assert(readFileSync('.github/workflows/telegram-refresh.yml','utf8').includes(name),'workflow and reader agree on immutable retry names');
}
const recoveredPublication=await readFixture(deliveryFixture([{id:2,artifacts:[{corrupt:true},{name:'telegram-posts-retry-1.json.gz'}]}]));
assert.equal(recoveredPublication.source.degraded,false,'a complete verified final retry resolves the upload failure');
const cancelled=new AbortController();cancelled.abort();
const untouched=deliveryFixture([{id:1,artifacts:[{}]}]);
await assert.rejects(()=>readFixture(untouched,{signal:cancelled.signal}));
assert.equal(untouched.calls.length,0,'a cancelled read makes no additional requests');
console.log('PASS Telegram artifacts: trusted checkpoints, pending publication, bounded fallback, failed-final delivery, proven pre-source recovery, fail-closed restoration, pause preservation, catch-up ranges, read-only backups and integrity');
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
