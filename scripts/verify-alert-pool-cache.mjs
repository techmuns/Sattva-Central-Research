#!/usr/bin/env node
// Deterministic pool refresh/cancellation checks; no network, production data or clock sleeps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ALERT_POOL_CONTRACT, ALERT_POOL_POLICY, POOL_CAPTURES, POOL_FEEDS, captureRevision, shiftDay } from '../public/js/data/alert-pool-shared.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const pool = await import('../public/js/data/alert-pool.js');
const day = '2026-09-20';
const days = Array.from({ length: 7 }, (_, i) => shiftDay(day, -i));
const captures = Object.fromEntries(Object.keys(POOL_CAPTURES).map(name => [name, name === 'exchangeDeals' ? { artifactId: 42 } : { revision: 'fixture-v1' }]));
const feeds = Object.fromEntries(POOL_FEEDS.map(id => [id, { row: { id, status: 'ok', asOf: day }, newsMeta: {} }]));
let served, requests, failedMember, gate, onRequest, indexGate, statusGate;
const members = new Map();
function descriptor(kind, date, suffix = '') {
  const member = `${kind}/${date}.json.gz`;
  const shard = { version: 1, contract: ALERT_POOL_CONTRACT, ...(kind === 'days' ? { day: date } : { span: date }),
    feeds: Object.fromEntries(POOL_FEEDS.map(feed => [feed, {
      events: [{ id: `${feed}:${date}${suffix}`, feed, day: date, headline: `Captured ${feed} ${date}${suffix}` }],
      order: [days.indexOf(date)], companions: { events: [], order: [] },
    }])) };
  const json = JSON.stringify(shard), bytes = gzipSync(json);
  const entry = { member, ...(kind === 'days' ? { day: date } : { span: date }), bytes: bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex') };
  members.set(member, json);
  return entry;
}
function reset() {
  pool.resetForTest(); requests = []; failedMember = null; gate = null; onRequest = null; indexGate = null; statusGate = null;
  served = { version: 1, contract: ALERT_POOL_CONTRACT, policy: ALERT_POOL_POLICY, artifact: 1, day, captures: structuredClone(captures), feeds: structuredClone(feeds),
    days: days.map(date => descriptor('days', date)), ai: days.map(date => descriptor('ai', date)) };
}
globalThis.fetch = async input => {
  const path = String(input);
  requests.push(path);
  if (path === pool.INDEX_ROUTE) { if (indexGate) await indexGate; return Response.json(structuredClone(served)); }
  if (path === pool.STATUS_ROUTE) { if (statusGate) await statusGate; return Response.json({ captures }); }
  const match = /^api\/alert-pool\/\d+\/(.+)$/.exec(path);
  assert(match, `unexpected request: ${path}`);
  onRequest?.(path);
  if (gate) await gate;
  if (match[1] === failedMember) return Response.json({ ok: false }, { status: 503 });
  return new Response(members.get(match[1]), { headers: { 'content-type': 'application/json' } });
};
const read = options => pool.read({ mode: 'ai', day, ...options });
const downloads = () => requests.filter(path => /^api\/alert-pool\/\d+\//.test(path));
const window = length => ({ mode: 'window', queryWindow: { from: shiftDay(day, 1 - length), to: day, includeUndated: false } });
const ids = result => [...result.feeds].map(([id, feed]) => [id, feed.events.map(event => event.id)]);

reset();
const failureNote = 'Read failed: Filings coverage is incomplete. Retained records remain visible.';
served.feeds.news.row = { ...served.feeds.news.row, status: 'failed', reachesToday: false, note: failureNote };
const failedNews = await read({ newsState: () => ({ status: 'ok', reachesToday: true, note: 'Derived clock status' }) });
assert.equal(failedNews.feeds.get('news').status, 'failed');
assert.equal(failedNews.feeds.get('news').reachesToday, false);
assert.equal(failedNews.feeds.get('news').note, failureNote, 'the saved failed-read explanation survives age revalidation');
assert.equal(failedNews.feeds.get('news').events.length, 7, 'failed health retains every eligible event');
console.log('PASS news age revalidation preserves failed collection health, its explanation and retained events');

reset();
const first = await read();
assert.equal(downloads().length, 7);
const initialBytes = served.ai.reduce((total, entry) => total + entry.bytes, 0);
requests = []; served.artifact++;
served.feeds.technicals.row.status = 'partial';
const unchanged = await read({ refresh: true });
assert.deepEqual(ids(unchanged), ids(first));
assert.equal(unchanged.feeds.get('technicals').status, 'partial', 'new source status is never cached with shard contents');
assert(requests.includes(pool.STATUS_ROUTE), 'capture revisions are rechecked on every refresh');
assert.deepEqual(downloads(), [], 'a new artifact with identical hashes downloads no shards');
assert.equal(unchanged.feeds.get('news').events[0], first.feeds.get('news').events[0], 'unchanged decoded events keep their per-row caches');
console.log(`PASS unchanged build: 7 → 0 shard requests, ${initialBytes} → 0 compressed bytes`);

requests = []; served.artifact++;
served.ai[0] = descriptor('ai', day, ':new');
const changed = await read({ refresh: true });
assert.equal(downloads().length, 1, 'only the changed shard downloads');
assert(changed.feeds.get('news').events.some(event => event.id.endsWith(':new')), 'new rows reach the reader');
assert(!changed.feeds.get('news').events.some(event => event.id === `news:${day}`), 'the changed shard replaces its predecessor');
assert.equal(pool.current({ mode: 'ai', day }), changed);
console.log(`PASS changed build: 7 → 1 shard requests, ${initialBytes} → ${served.ai[0].bytes} compressed bytes`);

served.artifact++; served.captures.insider.revision = 'newer-capture';
requests = [];
const declined = await read({ refresh: true });
assert.equal(declined.feeds.has('insider'), false, 'matching hashes cannot override changed capture revisions');
assert.equal(declined.declined.get('insider'), 'insider: moved');
assert(declined.feeds.has('news'));
assert.equal(downloads().length, 0);
console.log('PASS capture revisions and source health stay authoritative during reuse');

reset();
await read();
served.captures.announcementRecovery.revision = 'new-recovery-head';
const recovered = await read({ refresh: true });
assert.equal(recovered.feeds.has('announcements'), false, 'new backup filings cannot be hidden behind an older pool');
assert.equal(recovered.declined.get('announcements'), 'announcementRecovery: moved');
assert(recovered.feeds.has('news'), 'unrelated feeds retain their fast prepared path');
const lastGood = { capturedAt: `${day}T09:00:00Z`, rowCount: 100, lastAttemptAt: `${day}T09:00:00Z` };
assert.notEqual(captureRevision(lastGood), captureRevision({ ...lastGood, lastAttemptAt: `${day}T10:00:00Z` }),
  'a newer failed BSE check invalidates its old pool status even when last-good rows and capture time stay unchanged');
assert.notEqual(captureRevision({ rowCount: 100, lastPageAt: `${day}T09:00:00Z`, pendingCount: 0 }),
  captureRevision({ rowCount: 100, lastPageAt: `${day}T10:00:00Z`, pendingCount: 1 }), 'unfinished recovery changes are part of the revision');
console.log('PASS announcement recovery arrivals and newer failed attempts invalidate only their prepared feed');

reset();
let releaseIndex;
indexGate = new Promise(resolve => { releaseIndex = resolve; });
const parallel = read();
await Promise.resolve();
assert(requests.includes(pool.STATUS_ROUTE), 'source verification starts while artifact discovery is still pending');
assert.equal(downloads().length, 0, 'no member is requested before index and source verification complete');
releaseIndex();
assert(await parallel);
console.log('PASS independent index and source checks overlap without skipping verification');

reset();
served.contract = 'unavailable';
let releaseStatus;
statusGate = new Promise(resolve => { releaseStatus = resolve; });
try {
  assert.equal(await Promise.race([read(), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]), null,
    'an unusable pool falls back immediately without waiting for its slower source checks');
} finally { releaseStatus(); }

// A newly adopted index cannot retain a result from the other mode's previous artifact.
reset(); await read(); await read(window(1)); served.artifact++;
await read({ refresh: true, ...window(1) });
assert.equal(pool.current({ mode: 'ai', day }), null);
assert.equal(pool.status().artifact, served.artifact);

for (const hash of [undefined, 'not-a-digest']) {
  reset(); for (const entry of served.ai) entry.hash = hash;
  await read(); served.artifact++; requests = [];
  await read({ refresh: true });
  assert.equal(downloads().length, 7, 'absent/invalid hashes keep artifact-local cache identities');
}
console.log('PASS older indexes keep the safe artifact-local cache fallback');

// Going back to Today releases the six unselected days; another expansion must read them again.
reset(); await read(window(7)); await read(window(1)); requests = [];
await read(window(7));
assert.equal(downloads().length, 6, 'only the selected window stays decoded');
console.log('PASS narrowing a period releases unselected decoded history');

reset();
const [a, b] = await Promise.all([read(), read()]);
assert.deepEqual(ids(a), ids(b));
assert.equal(downloads().length, 7, 'concurrent consumers share pending shard requests');

// Cancel after all four workers enter a blocked fetch; the next queued member sees cancellation.
reset();
let release, reached;
gate = new Promise(resolve => { release = resolve; });
const pending = new Promise(resolve => { reached = resolve; });
onRequest = () => { if (downloads().length === 4) reached(); };
let active = true;
const abandoned = read({ isCurrent: () => active });
await pending;
active = false; gate = null; release();
assert.equal(await abandoned, null, 'abandonment is not reported as a source outage');
assert(await read(), 'the next view can use the pool immediately, without forcing refresh');
console.log('PASS a cancelled view never disables the pool for the next view');

// A stale in-flight reader must not overwrite a result from a newly published artifact.
reset();
gate = new Promise(resolve => { release = resolve; });
const oldPending = new Promise(resolve => { reached = resolve; });
onRequest = () => { if (downloads().length === 4) reached(); };
const oldRead = read();
await oldPending;
served.artifact++;
served.ai = days.map(date => descriptor('ai', date, ':replacement'));
gate = null;
const newer = await read({ refresh: true });
release();
assert.equal(await oldRead, null);
assert.equal(pool.current({ mode: 'ai', day }), newer, 'older reads cannot replace the current artifact');
assert.equal(pool.status().artifact, served.artifact);
console.log('PASS superseded reads cannot overwrite newer pool results');

reset(); failedMember = served.ai[0].member;
await assert.rejects(read(), /could not be read/);
assert.equal(await read(), null, 'real failures still back off rather than retrying on every partial');
failedMember = null;
assert(await read({ refresh: true }), 'an explicit refresh can recover immediately');
console.log('PASS unavailable shards still fail honestly and recover on refresh');

reset(); served.contract = 'alert-pool-v1';
assert.equal(await read(), null, 'old pools missing company-discovery context cannot answer the new reader');
assert.equal(downloads().length, 0);
console.log('PASS the reader declines the previous pool contract until a matching build arrives');
