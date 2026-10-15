import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dispatchWorkflow,TELEGRAM_WORKFLOW} from '../worker/github-actions.mjs';
import {TelegramSchedule,TELEGRAM_INTERVAL_MS,TELEGRAM_RUN_OVERDUE_MS,TELEGRAM_PRODUCTION_HOST} from '../worker/telegram-scheduler.mjs';
import worker from '../worker/index.js';
const env={GH_DISPATCH_TOKEN:'local-test-secret',GH_REPO:'techmuns/Sattva-Central-Research',GH_REF:'main'};
const time=Date.parse('2026-10-15T09:00:00Z');
const noStorage=new Proxy({},{get(){throw Error('GitHub schedule must not access Cloudflare storage');}});
let recent=null,posts=0,calls=0,fail=false;
const fetcher=async(raw,options)=>{
  calls++;const url=new URL(raw);assert.equal(url.origin,'https://api.github.com');
  assert(url.pathname.startsWith('/repos/techmuns/Sattva-Central-Research/actions/workflows/telegram-refresh.yml/'));
  assert.equal(options.headers.authorization,'Bearer local-test-secret');
  if(fail)return new Response('private upstream detail',{status:403});
  if(options.method==='POST'){posts++;assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{source:'auto'}});return new Response(null,{status:204});}
  const status=url.searchParams.get('status');
  const rows=recent&&(!status||recent.status===status)?[recent]:[];
  return Response.json({total_count:rows.length,workflow_runs:rows});
};
const create=(overrides={})=>new TelegramSchedule(noStorage,{...env,...overrides},{fetcher,now:()=>time});
let schedule=create();
assert.equal((await schedule.status()).runtime,'github-actions');assert.equal(posts,0,'Status never dispatches');
assert.equal((await schedule.status()).alarmAt,null);
assert((await schedule.request('auto')).dispatched);assert.equal(posts,1);
recent={id:10,status:'completed',conclusion:'success',created_at:new Date(time-1000).toISOString()};
assert.equal((await create().request('auto')).reason,'cooling-down','A new Worker instance checks GitHub instead of relying on lost local memory');
assert.equal(posts,1);
recent.conclusion='failure';assert.equal((await schedule.request('auto')).reason,'latest-run-failed');
assert.equal((await schedule.status()).lastResult,'recent-run-failed');
recent={id:11,status:'in_progress',created_at:new Date(time-TELEGRAM_RUN_OVERDUE_MS-1).toISOString()};
assert.equal((await schedule.status()).runOverdue,true);assert.equal((await schedule.request('auto')).reason,'run-overdue');assert.equal(posts,1);
const before=calls;assert.equal((await create({GH_REF:'preview'}).request()).reason,'configuration');
assert.equal((await create({GH_REPO:'other/repo'}).request()).reason,'configuration');
assert.equal((await create({GH_REPO:''}).status()).enabled,false,'Missing configuration cannot be reported as an enabled GitHub schedule');
assert.equal((await create({TELEGRAM_SCHEDULER_DISABLED:'true'}).request()).reason,'operator-disabled');assert.equal(calls,before);
fail=true;const failed=await schedule.request();assert.equal(failed.reason,'forbidden');assert(!JSON.stringify(failed).includes('private upstream'));
assert.equal(TELEGRAM_INTERVAL_MS,600000);

// Actual 13 September request: GitHub kept it queued with zero jobs while newer
// collections completed. It must not permanently suppress the independent timer.
const queueFixture = JSON.parse(readFileSync(new URL('./fixtures/telegram-empty-queued-run.json', import.meta.url)));
const queueTime = Date.parse('2026-09-15T13:00:00Z');
const queueCfg = { token: 'local-test-secret', owner: 'techmuns', repo: 'Sattva-Central-Research', ref: 'main', now: () => queueTime };
function queuedAPI({ mode = 'safe', queues = 1, edit = () => {}, jobInventory = { total_count: 0, jobs: [] } } = {}) {
  const reads = new Map(), requests = [], dispatches = [];
  const queued = Array.from({ length: queues }, (_, i) => ({ ...queueFixture, id: queueFixture.id - i }));
  const fetcher = async (input, init) => {
    const url = new URL(input); requests.push({ method: init.method, path: url.pathname });
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.headers.authorization, 'Bearer local-test-secret');
    assert.equal(init.redirect, 'manual');
    if (init.method === 'POST') {
      assert.equal(url.pathname, '/repos/techmuns/Sattva-Central-Research/actions/workflows/telegram-refresh.yml/dispatches');
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    assert.equal(init.method, 'GET', 'recovery never cancels, resumes or approves a run');
    if (url.pathname.endsWith('/runs')) {
      const status = url.searchParams.get('status');
      let runs = [];
      if (status === 'queued') runs = queued;
      if (status === 'success' || status === null) runs = [{ id: queueFixture.id + 1000, status: 'completed',
        conclusion: 'success', created_at: new Date(queueTime - 60 * 60 * 1000).toISOString() }];
      if (status === 'success' && mode === 'no-success') runs = [];
      if (status === 'success' && mode === 'older-success') runs[0].id = queueFixture.id - 1;
      if (status === 'success' && mode === 'future-success') runs[0].created_at = new Date(queueTime + 120000).toISOString();
      if (status === 'waiting' && mode === 'approval') runs = [{ id: queueFixture.id + 2, status: 'waiting' }];
      if (status === 'in_progress' && mode === 'running') runs = [{ id: queueFixture.id + 2, status: 'in_progress' }];
      return Response.json({ total_count: status === 'queued' && mode === 'partial-inventory' ? runs.length + 1 : runs.length, workflow_runs: runs });
    }
    if (mode === 'read-error') return new Response('private response', { status: 403 });
    if (url.pathname.endsWith('/jobs')) return Response.json(jobInventory);
    const id = Number(url.pathname.split('/').at(-1));
    const count = (reads.get(id) || 0) + 1; reads.set(id, count);
    const detail = structuredClone(queued.find(run => run.id === id));
    assert(detail, 'only listed workflow runs may be audited');
    edit(detail, count);
    return Response.json(detail);
  };
  return { fetcher, dispatches, requests, queued };
}
const recovery = { recoverTelegramQueues: true };
const dispatch = api => dispatchWorkflow(api.fetcher, queueCfg, TELEGRAM_WORKFLOW, 'main', { source: 'auto' }, recovery);
const safe = queuedAPI();
assert.equal((await dispatch(safe)).dispatched, true);
assert.deepEqual(safe.dispatches, [{ ref: 'main', inputs: { source: 'auto' } }], 'recovery cannot resume account collection');
assert.equal(safe.requests.filter(r => r.path.endsWith(String(queueFixture.id))).length, 2, 'recheck after the empty job inventory');
for (const options of [
  { mode: 'no-success' }, { mode: 'older-success' }, { mode: 'future-success' },
  { mode: 'approval' }, { mode: 'running' }, { queues: 6 },
  { jobInventory: {} }, { jobInventory: { total_count: 1, jobs: [] } },
  { jobInventory: { total_count: 0, jobs: [{ status: 'queued' }] } },
  { jobInventory: { total_count: 1, jobs: [{ status: 'in_progress' }] } },
  { edit: run => { run.run_attempt = 2; } },
  { edit: run => { run.head_branch = 'preview'; } },
  { edit: run => { run.path = '.github/workflows/another.yml'; } },
  { edit: run => { run.head_repository.full_name = 'another/repo'; } },
  { edit: run => { run.event = 'pull_request'; } },
  { edit: run => { run.updated_at = new Date(queueTime - 60000).toISOString(); } },
  { edit: (run, count) => { if (count === 2) run.status = 'in_progress'; } },
  { edit: (run, count) => { if (count === 2) run.head_sha = 'b'.repeat(40); } },
]) {
  const api = queuedAPI(options);
  assert.equal((await dispatch(api)).dispatched, false, JSON.stringify(options));
  assert.equal(api.dispatches.length, 0);
}
const young = queuedAPI(); young.queued[0].created_at = new Date(queueTime - 60000).toISOString();
assert.equal((await dispatch(young)).dispatched, false, 'ordinary queue delay is not an orphan');
const unknownDate = queuedAPI(); delete unknownDate.queued[0].created_at;
assert.equal((await dispatch(unknownDate)).dispatched, false, 'age must be known');
const duplicate = queuedAPI({ queues: 2 }); duplicate.queued[1].id = duplicate.queued[0].id;
assert.equal((await dispatch(duplicate)).dispatched, false, 'duplicate IDs cannot establish a complete queue inventory');
const defaultPolicy = queuedAPI();
assert.equal((await dispatchWorkflow(defaultPolicy.fetcher, queueCfg, TELEGRAM_WORKFLOW, 'main', { source: 'auto' })).dispatched, false,
  'shared dispatch remains strict unless the Telegram timer enables its scoped recovery');
const bounded = queuedAPI({ queues: 5 });
assert.equal((await dispatch(bounded)).recoveredQueuedRunIds.length, 5);
assert(bounded.requests.length <= 22, 'five queue audits and active checks have a bounded read budget');
const unreadable = queuedAPI({ mode: 'read-error' });
await assert.rejects(dispatch(unreadable), { code: 'forbidden' });
assert.equal(unreadable.dispatches.length, 0);
const incomplete = queuedAPI({ mode: 'partial-inventory' });
await assert.rejects(dispatch(incomplete), { code: 'invalid-runs' });
assert.equal(incomplete.dispatches.length, 0, 'a partial page cannot establish the absence of other queued work');
await assert.rejects(dispatchWorkflow(safe.fetcher, queueCfg, 'other.yml', 'main', null, recovery), { code: 'configuration' });
await assert.rejects(dispatchWorkflow(safe.fetcher, { ...queueCfg, base: 'https://another.example' }, TELEGRAM_WORKFLOW, 'main', null, recovery), { code: 'configuration' });
await assert.rejects(dispatchWorkflow(safe.fetcher, { ...queueCfg, ref: 'preview' }, TELEGRAM_WORKFLOW, 'main', { source: 'auto' }, recovery), { code: 'configuration' });
await assert.rejects(dispatchWorkflow(safe.fetcher, queueCfg, TELEGRAM_WORKFLOW, 'main', { source: 'auto', resume_api: true }, recovery), { code: 'configuration' });
let auditClock = queueTime;
const slowAudit = queuedAPI({ jobInventory: { get total_count() { auditClock += 21000; return 0; }, jobs: [] } });
await assert.rejects(dispatchWorkflow(slowAudit.fetcher, { ...queueCfg, now: () => auditClock }, TELEGRAM_WORKFLOW, 'main', { source: 'auto' }, recovery),
  { code: 'unreachable' });
assert.equal(slowAudit.dispatches.length, 0, 'the audit cannot run past its shared deadline');

assert.match(readFileSync('.github/workflows/telegram-refresh.yml','utf8'),/cron: '7,17,27,37,47,57/,'GitHub retains the independent schedule');
assert.match(readFileSync('.github/workflows/telegram-refresh.yml','utf8'),/group: telegram-account-collection\s+cancel-in-progress: false/,'GitHub remains the source-execution mutex');
const originalFetch=globalThis.fetch,originalCaches=globalThis.caches;
try {
  fail=false;recent=null;const cached=new Map();globalThis.fetch=fetcher;
  globalThis.caches={default:{match:async request=>cached.get(request.url)?.clone(),put:async(request,value)=>cached.set(request.url,value.clone())}};
  const pending=[],ctx={waitUntil:promise=>pending.push(promise)};
  const routeEnv={...env,TELEGRAM_SCHEDULER:{getByName(){throw Error('Routes must not call a Durable Object');}}};
  const request=(path,method='GET',host=TELEGRAM_PRODUCTION_HOST)=>new Request(`https://${host}${path}`,{method});
  const start=posts;
  assert.equal((await worker.fetch(request('/api/telegram/schedule'),routeEnv,ctx)).status,200);assert.equal(posts,start);
  assert.equal((await worker.fetch(request('/api/telegram/refresh'),routeEnv,ctx)).status,405);
  assert.equal((await worker.fetch(request('/api/telegram/refresh?source=auto','POST','preview.example'),routeEnv,ctx)).status,403);
  const result=await worker.fetch(request('/api/telegram/refresh?source=auto','POST'),routeEnv,ctx);assert((await result.json()).dispatched);await Promise.all(pending);
  const cooled=await worker.fetch(request('/api/telegram/refresh?source=auto','POST'),routeEnv,ctx);assert.equal((await cooled.json()).reason,'cooling-down');assert.equal(posts,start+1);
}finally{globalThis.fetch=originalFetch;globalThis.caches=originalCaches;}
console.log('PASS GitHub Telegram schedule: no Cloudflare state or timer, truthful run status, source cooldowns and orphan-run safety, read-only GET and production-only cached dispatch');
