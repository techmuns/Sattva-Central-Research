#!/usr/bin/env node
// Offline checks for refresh ownership, duplicate protection, truthful outcomes and targeting.
import assert from 'node:assert/strict';
import * as refresh from '../public/js/core/refresh.js';
const gate = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
let calls = 0;
const slow = gate();
let off = refresh.register('news', { label: 'News', refresh: async () => { calls++; await slow.promise; return { checked: 3, added: 2 }; } });
const first = refresh.refreshOne('news');
const second = refresh.refreshOne('news');
const all = refresh.refreshAll();
await Promise.resolve();
assert.equal(calls, 1, 'local and header clicks share one source check');
assert.equal(first, second, 'callers await the same work');
slow.resolve();
assert.equal((await first).added, 2);
assert.equal((await all).announced, 2);
assert(refresh.lastRefreshAt('news'));
off();
const oldOff = refresh.register('news', { refresh: () => ({ checked: 1 }) });
off = refresh.register('news', { refresh: () => { throw Error('Source down'); } });
oldOff();
assert.equal(refresh.registered().length, 1, 'disposing a stale mount preserves its replacement');
const failure = await refresh.refreshOne('news');
assert.equal(failure.failed, 1);
assert.equal(refresh.lastRefreshAt('news'), null, 'failure does not advance confirmation time');
assert.equal(refresh.resultLabel(refresh.summarize([failure])), 'Couldn’t refresh');
assert.equal(refresh.resultLabel(refresh.summarize([{ checked: 1 }, failure])), 'Partly refreshed');
assert.equal(refresh.resultLabel(refresh.summarize([{ checked: 40, partial: true }])), 'Partly refreshed');
assert.equal(refresh.resultLabel(refresh.summarize([{ checked: 1 }])), 'Latest available');
off();

// Use the real poll engine with a tiny DOM stand-in. It never contacts a service.
globalThis.document = { hidden: false, addEventListener() {} };
const live = await import('../public/js/core/live.js');
const poll = gate(); let ticks = 0; let otherTicks = 0;
live.register('wanted', { intervalMs: 60000, fetcher: async () => { ticks++; await poll.promise; return { rows: [] }; } });
live.register('other', { intervalMs: 60000, fetcher: async () => { otherTicks++; } });
live.start('wanted', { fresh: true }); live.start('other', { fresh: true });
const a = live.refreshAll({ ids: ['wanted'] });
const b = live.refreshAll({ ids: ['wanted'] });
assert.equal(ticks, 1); assert.equal(otherTicks, 0, 'refresh leaves unrelated sources on their cadence');
poll.resolve();
assert.equal((await a)[0].checked, 1); await b;
live.register('wanted', { intervalMs: 60000, fetcher: () => { throw Error('Offline fixture'); } });
const last = live.getLastDataTick();
assert.equal((await live.refreshAll({ ids: ['wanted'] }))[0].failed, 1);
assert.equal(live.getLastDataTick(), last, 'a failed poll cannot advance freshness');
live.stop('wanted'); live.stop('other');

const { runCaptureWatchdog, captureNamesForView, resetForTest, onCaptureLanded } = await import('../public/js/data/capture-watchdog.js');
assert.deepEqual(captureNamesForView({ tab: 'news', scope: 'portfolio' }), ['companyNews']);
assert.deepEqual(captureNamesForView({ tab: 'news', scope: 'universe' }), ['marketNews']);
assert.deepEqual(captureNamesForView({ tab: 'earnings-hub', params: { view: 'filings' } }), []);
const now = Date.parse('2026-09-05T10:00:00Z');
const callsMade = [];
globalThis.fetch = async (url, options = {}) => {
  callsMade.push([url, options.method || 'GET']);
  if (url === 'api/capture-status') return Response.json({ ok: true, captures: { companyNews: { capturedAt: new Date(now - 600000).toISOString() } } });
  if (url === 'api/company-news/refresh?source=button') return Response.json({ ok: true, dispatched: false, reason: 'already-running' });
  throw Error(`Unexpected test request ${url}`);
};
const requested = await runCaptureWatchdog({ names: ['companyNews'], source: 'button', now: () => now, watchRuns: false });
assert.deepEqual(requested.started.map((r) => r.name), ['companyNews']);
assert.deepEqual(callsMade.filter(([, method]) => method === 'POST'), [['api/company-news/refresh?source=button', 'POST']], 'a News click dispatches only its fixed workflow');
resetForTest();

// A capture-status timestamp alone cannot prove its bytes reached the table.
// Fast-forward only the capture watch interval, keeping all requests mocked.
const originalTimer = globalThis.setTimeout;
let statusReads = 0, captureReads = 0;
const landedReads = [];
const offLanded = onCaptureLanded(() => landedReads.push(captureReads));
const capturedAt = new Date(now).toISOString();
globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === 30000 ? 0 : ms, ...args);
globalThis.fetch = async (url) => {
  if (url === 'api/capture-status') return Response.json({ ok: true, captures: { marketNews: {
    capturedAt: ++statusReads === 1 ? new Date(now - 600000).toISOString() : capturedAt,
  } } });
  if (url === 'api/market-news/refresh?source=button') return Response.json({ ok: true, dispatched: true });
  if (url === 'data/market-news.json') {
    if (++captureReads === 1) return new Response('unavailable', { status: 503 });
    return Response.json({ capturedAt, articles: [{ id: 'fixture-story', title: 'Fresh source story', url: 'https://example.test/story' }],
      sources: [{ id: 'moneycontrol', capturedAt }] });
  }
  throw Error(`Unexpected capture request ${url}`);
};
try {
  const job = await runCaptureWatchdog({ names: ['marketNews'], source: 'button', now: () => now });
  const completed = await job.completion;
  assert.equal(captureReads, 2, 'unavailable updated bytes are retried before reporting completion');
  assert.equal(completed[0].outcome, 'landed');
  assert.deepEqual(landedReads, [2], 'mounted reports are notified immediately after the source bytes arrive');
  assert.equal((await import('../public/js/data/market-news.js')).rows()[0].title, 'Fresh source story');
} finally { offLanded(); globalThis.setTimeout = originalTimer; resetForTest(); }

const { conditionalJson } = await import('../public/js/core/store.js');
const network = gate(); let requests = 0;
globalThis.fetch = async () => { requests++; await network.promise; return Response.json({ rows: [1] }); };
const one = conditionalJson('/fixture', { optional: true });
const two = conditionalJson('/fixture', { optional: true });
network.resolve(); await Promise.all([one, two]);
assert.equal(requests, 1, 'poll and header conditional reads share their network request');
console.log('PASS refresh ownership, shared requests, failure propagation, truthful labels and tab-specific job targeting');
