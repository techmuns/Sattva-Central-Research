import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runInsightCollection } from './lib/screener-insights-run.mjs';
import { collectInsightBatch } from './lib/screener-insights-batch.mjs';
import { beginInsightState, finishInsightState, insightError, insightFailureCode, insightResponseError,
  parseInsightRetryAfter, selectDueInsightTargets } from './lib/screener-insights-control.mjs';
import { insightCoolingDown, INSIGHTS_STATE_ARTIFACT, validateInsightState } from '../public/js/data/screener-insights-state.js';
import { SCREENER_INSIGHTS_ARTIFACT, validateScreenerInsightsCapture } from '../public/js/data/screener-insights-shared.js';
import { readScreenerInsightsCollector } from '../worker/screener-insights-collector.mjs';

const HOUR = 3600_000;
let clock = Date.parse('2026-09-06T08:00:00.000Z');
const start = clock;
const targets = ['A', 'B', 'C'].map(companyKey => ({ companyKey, ticker: companyKey, name: companyKey,
  companyUrl: `https://www.screener.in/company/${companyKey}/`, inPortfolio: true, inUniverse: true }));
const company = (target, checkedAt = new Date(clock).toISOString()) => ({ ...target, checkedAt, readStatus: 'ok', rows: [] });

assert.equal(parseInsightRetryAfter('120', clock), clock + 120_000);
assert.equal(parseInsightRetryAfter(new Date(clock + 12 * HOUR).toUTCString(), clock), clock + 12 * HOUR);
assert.equal(parseInsightRetryAfter('Sun, 06 Sep 2026 07:00:00 GMT', clock), clock);
for (const value of [null, '', '0.5', '-1', '2026', 'secret=test']) {
  if (value !== '2026') assert.equal(parseInsightRetryAfter(value, clock), null);
}
assert.equal(parseInsightRetryAfter('999999999999999999999999999999', clock), 8.64e15, 'large valid delays never wrap or trigger an early retry');
for (const [status, code] of [[429, 'rate-limited'], [403, 'access-denied'], [401, 'session-expired'], [503, 'source-unavailable'], [404, 'navigation']]) assert.equal(insightResponseError(status, '900', clock).insightCode, code);
assert.equal(insightFailureCode(Error('password=must-never-be-recorded')), 'internal');

let memory = { capture: null, state: null };
let opens = 0;
let reads = [];
const checkpoints = [];
let fail = true;
const options = {
  now: () => clock, restore: async () => structuredClone(memory), openSession: async () => { opens++; return {}; },
  inventory: async () => targets,
  readCompany: async (_session, target, checkedAt) => {
    reads.push(target.companyKey);
    if (fail && target.companyKey === 'B') throw insightError('rate-limited', '43200', clock);
    return company(target, checkedAt);
  },
  publishCapture: capture => { validateScreenerInsightsCapture(capture, clock); memory.capture = structuredClone(capture); checkpoints.push(structuredClone(capture)); },
  publishState: state => { validateInsightState(state, clock); memory.state = structuredClone(state); },
  batchOptions: { delayMs: 0 },
};
const first = await runInsightCollection(options);
assert.deepEqual(reads, ['A', 'B'], 'first access block stops all later requests');
assert.equal(first.state.reason, 'rate-limited');
assert.equal(Date.parse(first.state.cooldownUntil), clock + 12 * HOUR, 'provider Retry-After wins over the shorter default');
assert.equal(first.capture.companies.length, 1);
assert.equal(checkpoints[0].companies.length, 1, 'a checkpoint exists before a later company fails');
assert.deepEqual(first.capture.failedKeys, ['B']);
assert.deepEqual(first.capture.deferredKeys, ['C']);
assert.equal(first.capture.fullCoverage, false);
const firstCheck = memory.capture.checkedAt;
clock += HOUR;
const before = structuredClone(memory);
await runInsightCollection(options);
assert.equal(opens, 1, 'cooldown-only run makes zero login, inventory or company requests');
assert.deepEqual(memory, before, 'a cooldown read does not move timestamps or extend its own pause');
fail = false;
clock = start + 12 * HOUR + 1;
reads = [];
const resumed = await runInsightCollection(options);
assert.deepEqual(reads, ['C', 'B'], 'never-read company leads prior failed company; fresh A is not read again');
assert.equal(resumed.capture.companies.length, 3);
assert.equal(resumed.capture.companies.find(c => c.ticker === 'A').checkedAt, firstCheck);
assert.equal(resumed.capture.fullCoverage, true);
assert.deepEqual(resumed.state.failures, [], 'successful replacement clears the individual failure');
assert.equal(resumed.state.cooldownUntil, null);

clock = start + 40 * HOUR;
reads = [];
const partial = await runInsightCollection({ ...options, batchOptions: { delayMs: 0, maxCompanies: 1 } });
assert.equal(reads.length, 1);
const justRead = reads[0];
assert.equal(partial.state.counts.deferred, 2);
clock += 60_000;
reads = [];
await runInsightCollection({ ...options, batchOptions: { delayMs: 0, maxCompanies: 1 } });
assert(!reads.includes(justRead), 'next run resumes remaining due work without revisiting the checkpointed company');

const captured = structuredClone(memory.capture);
clock += 30 * HOUR;
const loginFailure = await runInsightCollection({ ...options, openSession: async () => { throw insightError('session-expired'); } });
assert.equal(loginFailure.state.reason, 'session-expired');
assert.equal(memory.capture.checkedAt, captured.checkedAt, 'failed login cannot freshen retained data');
assert.deepEqual(memory.capture.companies, captured.companies);
let blockedOpens = 0;
await runInsightCollection({ ...options, openSession: async () => { blockedOpens++; } });
assert.equal(blockedOpens, 0);

let emptyState;
const empty = await runInsightCollection({ ...options, restore: async () => ({ capture: null, state: null }),
  openSession: async () => { throw insightError('access-denied'); },
  publishState: state => { emptyState = state; }, publishCapture: () => assert.fail('no invented capture before the first successful read') });
assert.equal(empty.capture, null);
assert.equal(emptyState.reason, 'access-denied');
assert(insightCoolingDown(emptyState, clock));
await assert.rejects(runInsightCollection({ ...options, restore: async () => { throw Error('corrupt artifact'); },
  openSession: async () => assert.fail('unreadable persisted cooldown must fail closed') }));

const twice = finishInsightState(emptyState, { stop: { code: 'access-denied' } }, clock);
assert.equal(twice.consecutiveBlocks, 2);
assert.equal(Date.parse(twice.cooldownUntil), clock + 48 * HOUR);
for (const bad of [{ ...twice, cookie: 'secret' }, { ...twice, reason: 'upstream body' },
  { ...twice, counts: { ...twice.counts, attempted: -1 } }, { ...twice, cooldownUntil: 'invalid' }]) assert.throws(() => validateInsightState(bad, clock));
assert.doesNotMatch(JSON.stringify(twice), /secret|password|companyUrl|cookie/);

const due = selectDueInsightTargets([...targets, { ...targets[0], companyKey: 'UNIVERSE', inPortfolio: false }],
  { companies: targets.map(t => company(t, new Date(clock - 2 * HOUR).toISOString())) }, null, clock);
assert.deepEqual(due.due.map(t => t.companyKey), ['UNIVERSE']);
assert.equal(due.fresh.length, 3);
const running = beginInsightState(null, clock);
assert(insightCoolingDown(running, clock), 'abrupt termination has a persisted conservative pause');
let active = 0, peak = 0;
await collectInsightBatch(targets, async target => {
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 3));
  active--;
  return company(target);
}, { delayMs: 1 });
assert.equal(peak, 1);
await assert.rejects(collectInsightBatch(targets, async () => {}, { concurrency: 3 }), /sequential/);
const broken = await collectInsightBatch([...targets, { companyKey: 'UNREACHED' }], async () => { throw insightError('structure-changed'); }, { delayMs: 0 });
assert.equal(broken.failures.length, 3);
assert.deepEqual(broken.deferredKeys, ['UNREACHED'], 'consecutive malformed pages cannot trigger a whole-inventory failed crawl');

let resolveLate;
const late = await collectInsightBatch(targets, () => new Promise(resolve => { resolveLate = resolve; }), { delayMs: 0, attemptTimeoutMs: 10 });
const lateSnapshot = JSON.stringify(late);
resolveLate(company(targets[0]));
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(JSON.stringify(late), lateSnapshot, 'late completion cannot mutate a published checkpoint');

let crashedCapture = null, crashedState = null;
const crashRun = await runInsightCollection({ ...options, restore: async () => ({ capture: null, state: null }),
  publishCapture: value => { crashedCapture = structuredClone(value); }, publishState: value => { crashedState = structuredClone(value); },
  readCompany: async (_session, target, checkedAt) => {
    if (target.companyKey === 'B') throw Error('raw credential-bearing upstream text');
    return company(target, checkedAt);
  } });
assert.equal(crashedCapture.companies.length, 1);
assert.equal(crashRun.state.reason, 'internal');
assert.doesNotMatch(JSON.stringify(crashedState), /credential-bearing|raw/);

// Newest state and newest data need not belong to the same run. Failure/cancellation checkpoints
// remain valid; foreign workflows, tampering, expired artifacts and oversized data fail closed.
function artifactFixture({ wrongPath = false, expired = false, corrupt = false, emptyCapture = false } = {}) {
  const values = { [INSIGHTS_STATE_ARTIFACT]: twice, [SCREENER_INSIGHTS_ARTIFACT]: captured };
  const ids = { [INSIGHTS_STATE_ARTIFACT]: 12, [SCREENER_INSIGHTS_ARTIFACT]: 10 };
  const bytes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, gzipSync(JSON.stringify(value))]));
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.hostname !== 'api.github.com') {
      assert.equal(init.headers, undefined);
      return new Response(bytes[target.pathname.slice(1)]);
    }
    if (target.pathname.endsWith('/runs')) return Response.json({ workflow_runs: [] });
    if (target.pathname.endsWith('/artifacts')) {
      const name = target.searchParams.get('name');
      return Response.json({ artifacts: emptyCapture && name === SCREENER_INSIGHTS_ARTIFACT ? [] : [{ id: ids[name], name, expired,
        workflow_run: { id: ids[name], head_branch: 'main' }, size_in_bytes: bytes[name].length,
        digest: `sha256:${corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes[name]).digest('hex')}` }] });
    }
    if (/\/runs\/\d+$/.test(target.pathname)) return Response.json({ id: Number(target.pathname.split('/').at(-1)),
      path: wrongPath ? '.github/workflows/other.yml' : '.github/workflows/screener-insights-refresh.yml',
      head_repository: { full_name: 'techmuns/Sattva-Central-Research' }, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' });
    if (target.pathname.endsWith('/zip')) {
      const id = Number(target.pathname.split('/').at(-2));
      const name = Object.keys(ids).find(key => ids[key] === id);
      return new Response(null, { status: 302, headers: { location: `https://test.blob.core.windows.net/${name}` } });
    }
    throw Error('Unexpected fixture request');
  };
}
const restored = await readScreenerInsightsCollector({ token: 'fixture', fetcher: artifactFixture(), now: () => clock });
assert.equal(restored.source.collectorRunId, 10);
assert.equal(restored.source.collectorLatestFailed, true);
assert.equal(restored.source.collection.reason, 'access-denied');
assert.equal(restored.source.collection.coolingDown, true);
assert.equal(restored.capture.checkedAt, captured.checkedAt);
const stateOnly = await readScreenerInsightsCollector({ token: 'fixture', fetcher: artifactFixture({ emptyCapture: true }), now: () => clock, allowMissing: true });
assert.equal(stateOnly.capture, null);
assert.equal(stateOnly.state.reason, 'access-denied');
for (const failure of [{ wrongPath: true }, { expired: true }, { corrupt: true }]) await assert.rejects(readScreenerInsightsCollector({ token: 'fixture', fetcher: artifactFixture(failure), now: () => clock }));

// The real Worker route must not create repeated Actions jobs while the source is cooling down,
// including when the first source attempt failed and no company artifact exists yet.
const worker = (await import('../worker/index.js')).default;
const originalFetch = globalThis.fetch, originalCaches = globalThis.caches, originalNow = Date.now;
try {
  Date.now = () => clock;
  for (const emptyCapture of [false, true]) {
    const requests = [], pending = [];
    const fixture = artifactFixture({ emptyCapture });
    globalThis.fetch = (url, init = {}) => { requests.push({ url: String(url), method: init.method || 'GET' }); return fixture(String(url), init); };
    globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
    const response = await worker.fetch(new Request('https://fixture.invalid/api/screener-insights'), { GH_DISPATCH_TOKEN: 'fixture' }, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending);
    assert.equal(response.status, emptyCapture ? 503 : 200);
    assert(requests.every(request => request.method === 'GET' && !request.url.includes('/dispatches')), 'cooldown suppresses dashboard-triggered workflow dispatch');
  }
} finally {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
  Date.now = originalNow;
}

console.log('PASS: sequential due-only resume, no-read persistent cooldowns, Retry-After, first-read failure, checkpoint retention and secure failed-run artifact recovery.');
