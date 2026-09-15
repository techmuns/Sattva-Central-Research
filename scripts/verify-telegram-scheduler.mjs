import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchWorkflow, TELEGRAM_WORKFLOW } from '../worker/github-actions.mjs';
import { TelegramSchedule, TELEGRAM_INTERVAL_MS, TELEGRAM_RUN_OVERDUE_MS, TELEGRAM_SCHEDULER_NAME, TELEGRAM_PRODUCTION_HOST } from '../worker/telegram-scheduler.mjs';
import worker from '../worker/index.js';

class Store {
  data = new Map(); alarm = null; tail = Promise.resolve();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  transaction(fn) {
    const result = this.tail.then(() => fn(this));
    this.tail = result.catch(() => {});
    return result;
  }
}
const env = { GH_DISPATCH_TOKEN: 'local-test-secret', GH_REPO: 'techmuns/Sattva-Central-Research', GH_REF: 'main' };
let time = Date.parse('2026-09-06T09:00:00Z'), posts = 0, calls = 0, scenario = 'ok', recentAt = null;
const fetcher = async (input, init) => {
  calls++;
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.github.com');
  assert(url.pathname.startsWith('/repos/techmuns/Sattva-Central-Research/actions/workflows/telegram-refresh.yml/'));
  assert.equal(init.headers.Authorization || init.headers.authorization, 'Bearer local-test-secret');
  if (scenario === 'read-error') return new Response('private upstream response', { status: 401 });
  if (init.method === 'POST') {
    posts++;
    assert.deepEqual(JSON.parse(init.body), { ref: 'main', inputs: { source: 'auto' } });
    if (scenario === 'lost-response') throw Error('private upstream response');
    return new Response(null, { status: 204 });
  }
  let runs = [];
  if (['running', 'stalled'].includes(scenario) && url.searchParams.get('status') === 'queued') runs = [{ id: 1, status: 'queued',
    ...(scenario === 'stalled' ? { created_at: new Date(time - TELEGRAM_RUN_OVERDUE_MS - 1).toISOString() } : {}) }];
  if (recentAt && !url.searchParams.has('status')) runs = [{ id: 2, status: 'completed',
    conclusion: scenario === 'recent-failed' ? 'failure' : 'success', created_at: recentAt }];
  return Response.json({ total_count: runs.length, workflow_runs: runs });
};
const storage = new Store();
const create = (overrides = {}) => new TelegramSchedule(storage, { ...env, ...overrides }, { fetcher, now: () => time });
let schedule = create();
assert.equal((await schedule.status()).enabled, false);
assert.equal(await storage.getAlarm(), null, 'reading status must not create an alarm or collect');
const simultaneous = await Promise.all(Array.from({ length: 15 }, () => schedule.request('auto')));
assert.equal(posts, 1, 'concurrent requests share one durable claim');
assert.equal(simultaneous.filter(r => r.dispatched).length, 1);
const firstAlarm = await storage.getAlarm();
schedule = create(); // Simulate eviction: nothing important lives only in memory.
assert.equal((await schedule.request('auto')).reason, 'cooling-down');
assert.equal(await storage.getAlarm(), firstAlarm, 'visits do not push the timer into the future');
storage.alarm = null;
assert.equal((await schedule.status()).alarmAt, null, 'a status read reports the lost alarm without repairing it');
assert.equal(await storage.getAlarm(), null);
await schedule.request('auto');
assert.equal(await storage.getAlarm(), firstAlarm, 'recover the timer without bypassing its claim');
time += TELEGRAM_INTERVAL_MS;
scenario = 'running';
assert.equal((await schedule.request('auto')).reason, 'already-running');
assert.equal(posts, 1, 'an older active run blocks collection');
assert.equal((await schedule.status()).activeRun.status, 'queued');
assert.equal((await schedule.status()).runOverdue, false);
time += TELEGRAM_RUN_OVERDUE_MS + 1;
assert.equal((await schedule.request('auto')).reason, 'run-overdue', 'an undated queued run cannot hide forever behind success');
assert.equal((await schedule.status()).lastResult, 'blocked');
assert.equal((await schedule.status()).runOverdue, true);
assert.equal(posts, 1, 'overdue diagnostics never cancel or duplicate an active job');
time = await storage.getAlarm();
scenario = 'stalled';
assert.equal((await schedule.request('auto')).ok, false, 'a dated stalled run is also an explicit failure');
assert.equal(posts, 1);
time += TELEGRAM_INTERVAL_MS;
scenario = 'ok'; recentAt = new Date(time - 60000).toISOString();
assert.equal((await schedule.request('auto')).reason, 'cooling-down');
assert.equal(posts, 1, 'a recent GitHub scheduled run prevents an extra timer run');
time = await storage.getAlarm(); scenario = 'recent-failed'; recentAt = new Date(time - 60000).toISOString();
assert.equal((await schedule.request('auto')).reason, 'latest-run-failed');
assert.equal((await schedule.status()).lastResult, 'recent-run-failed', 'a recent failed workflow is not a healthy cooldown');
time = await storage.getAlarm(); recentAt = null; scenario = 'lost-response';
assert.equal((await schedule.request('auto')).ok, false);
assert.equal(posts, 2);
assert.equal((await create().request('auto')).reason, 'cooling-down');
assert.equal(posts, 2, 'ambiguous POST is not retried on replay or restart');
time = await storage.getAlarm(); scenario = 'read-error';
await schedule.request('auto');
const failed = await schedule.status();
assert.equal(failed.reason, 'unauthorised');
assert.equal(Date.parse(failed.nextAttemptAt) - time, TELEGRAM_INTERVAL_MS * 2);
assert(!JSON.stringify(failed).includes('private'));
assert(!JSON.stringify([...storage.data.values()]).includes('secret'), 'credentials never enter durable storage');
time = await storage.getAlarm(); scenario = 'ok';
assert.equal((await schedule.request('auto')).dispatched, true);
assert.equal((await schedule.status()).failures, 0, 'recover automatically after upstream service recovers');
const beforeInvalid = calls;
time = await storage.getAlarm();
assert.equal((await create({ GH_REF: 'preview' }).request()).reason, 'configuration');
assert.equal(calls, beforeInvalid, 'a misconfigured scheduler must never contact GitHub');
await create({ TELEGRAM_SCHEDULER_DISABLED: 'true' }).request();
assert.equal((await schedule.status()).enabled, false);
assert.equal(await storage.getAlarm(), null);

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
const recoveringStore = new Store(), recoveringAPI = queuedAPI();
const recoveringSchedule = new TelegramSchedule(recoveringStore, env, { fetcher: recoveringAPI.fetcher, now: () => queueTime });
assert.equal((await recoveringSchedule.request('auto')).dispatched, true);
const recoveredStatus = await recoveringSchedule.status();
assert.equal(recoveredStatus.runOverdue, false);
assert.deepEqual(recoveredStatus.queueRecovery.runIds, [queueFixture.id]);
assert.equal((await recoveringSchedule.request('auto')).reason, 'cooling-down');
assert.equal(recoveringAPI.dispatches.length, 1, 'orphan recovery still obeys the durable claim');
assert(!JSON.stringify([...recoveringStore.data.values()]).includes('secret'));
assert.match(readFileSync(new URL('../.github/workflows/telegram-refresh.yml', import.meta.url), 'utf8'),
  /concurrency:\s*\n\s*group: telegram-account-collection\s*\n\s*cancel-in-progress: false/, 'workflow mutex remains the execution guard');

let starts = 0, reads = 0;
const routeEnv = { TELEGRAM_SCHEDULER: { getByName(name) {
  assert.equal(name, TELEGRAM_SCHEDULER_NAME);
  return { async status() { reads++; return { enabled: true }; }, async request(source) { starts++; assert.equal(source, 'auto'); return { ok: true }; } };
} } };
const request = (path, method = 'GET', host = TELEGRAM_PRODUCTION_HOST) => new Request(`https://${host}${path}`, { method });
assert.equal((await worker.fetch(request('/api/telegram/schedule'), routeEnv, {})).status, 200);
assert.equal(reads, 1); assert.equal(starts, 0);
assert.equal((await worker.fetch(request('/api/telegram/refresh'), routeEnv, {})).status, 405);
assert.equal((await worker.fetch(request('/api/telegram/refresh?source=auto', 'POST', 'preview.example'), routeEnv, {})).status, 403);
assert.equal(starts, 0);
assert.equal((await worker.fetch(request('/api/telegram/refresh?source=auto', 'POST'), routeEnv, {})).status, 200);
assert.equal(starts, 1);
console.log('PASS Telegram timer: durable single claim, restart/replay protection, recent/active runs, recovery/backoff, secret isolation, read-only status and preview boundaries');
