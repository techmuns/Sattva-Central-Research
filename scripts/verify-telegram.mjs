#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, collect } from './scrape-telegram.mjs';
import { decodeEntities, parseEmbed, permalinkText } from './lib/telegram.mjs';
const channel = 'researchreportss';
const published = '2026-05-13T10:57:05.000Z';
const embed = (id, body = '') => `<div class="tgme_widget_message" data-post="${channel}/${id}">${body}<a><time datetime="${published}">May 13</time></a></div>`;
const missing = '<div class="tgme_widget_message_error" dir="auto">Post not found</div>';
const landing = '<meta property="og:title" content="Research Reports"><meta property="og:description" content="Channel bio">';
const old = (id) => ({ id, text: `Old ${id}`, url: `https://t.me/${channel}/${id}`, publishedAt: null, firstSeenAt: '2026-09-01T00:00:00Z' });
const settings = { ...config({ TELEGRAM_BUDGET_MS: '20000', TELEGRAM_DELAY_MS: '0', TELEGRAM_JUMP_SPAN: '100', TELEGRAM_JUMP_SAMPLES: '4', TELEGRAM_JUMP_SHARE: '0.1' }), channel, history: 2, forward: 2, discovery: 0, headHint: 0 };
assert.equal(decodeEntities('&amp;#33; &lt;b&gt; &#128512; &#x110000;'), '&#33; <b> 😀 �');
assert.equal(permalinkText(landing, { title: 'Research Reports', desc: 'Channel bio' }), null);
const html = embed(7, '<div class="tgme_widget_message_text js-message_text">First &amp; second<br><b>Bold</b><div>Nested</div>end</div>');
const parsed = parseEmbed(html, channel, 7);
assert.equal(parsed.state, 'post');
assert.equal(parsed.post.text, 'First & second\nBoldNested\nend');
assert.equal(parsed.post.publishedAt, published);
assert.equal(parseEmbed(html, channel, 8).state, 'error', 'wrong-message embeds cannot fabricate a post');
assert.equal(parseEmbed(missing, channel, 8).state, 'missing');
assert.equal(parseEmbed(landing, channel, 8).state, 'error', 'a 200 landing page is not absence');
assert.equal(parseEmbed(embed(8), channel, 8).post.contentStatus, 'telegram-only');
assert.equal(parseEmbed(embed(8).replace(published, 'nonsense'), channel, 8).state, 'error');
const doc = parseEmbed(embed(9, '<a><div class="tgme_widget_message_document_title">Report &amp; Co.pdf</div><div class="tgme_widget_message_document_extra">2 MB</div></a>'), channel, 9);
assert.deepEqual(doc.post.attachments, [{ type: 'document', name: 'Report & Co.pdf', size: '2 MB' }]);
assert.throws(() => config({ TELEGRAM_CHANNEL: '../no' }));
assert.throws(() => config({ TELEGRAM_BUDGET_MS: 'NaN' }));
assert.throws(() => config({ TELEGRAM_JUMP_SHARE: 'NaN' }));
assert.throws(() => config({ TELEGRAM_PHASE: 'anything' }));

function upstream(messages, { fail = new Set(), status = 503 } = {}) {
  const calls = [];
  let clock = Date.parse('2026-09-07T00:00:00Z');
  return { calls, fetcher: async (url) => {
    clock += 10;
    const u = new URL(url), id = Number(u.pathname.split('/')[2]);
    calls.push(u.pathname + u.search);
    if (!id) return new Response(landing);
    if (fail.has(id)) return new Response('retry later', { status });
    if (!u.search) return new Response(messages.get(id)?.permalink || landing);
    return new Response(messages.has(id) ? embed(id, messages.get(id).body || '') : missing);
  }, sleep: async (ms) => { clock += ms; }, now: () => clock };
}
const messages = new Map([[10, { permalink: '<meta property="og:title" content="Research Reports"><meta property="og:description" content="Edited text">' }], [9, {}], [8, {}], [7, {}], [6, {}]]);
const source = upstream(messages);
const first = await collect({ channel, headId: 10, capturedAt: '2026-09-01T00:00:00Z', posts: [old(10)] }, settings, source);
assert.deepEqual(first.posts.map((p) => p.id), [10, 9]);
assert.equal(first.posts[0].text, 'Edited text');
assert.equal(first.posts[0].firstSeenAt, old(10).firstSeenAt);
assert.equal(first.posts[1].text, null, 'a document-only/restricted post remains without invented text');
assert.equal(first.posts[1].publishedAt, published);
assert.equal(first.historyNextId, 8);
assert.equal(first.lastRun.status, 'ok');
assert(first.lastCheckedAt);
const second = await collect(first, settings, source);
assert.deepEqual(second.posts.map((p) => p.id), [10, 9, 8, 7]);
assert.equal(second.historyNextId, 6, 'quiet runs still advance history');
const failed = await collect(second, settings, upstream(messages, { fail: new Set([11, 6]), status: 503 }));
assert.equal(failed.lastRun.status, 'partial');
assert.deepEqual(failed.retryIds, [11, 6]);
assert.equal(failed.lastCheckedAt, second.lastCheckedAt, 'a partial forward check cannot move success time');
assert(failed.posts.some((p) => p.id === 10));
assert.equal(failed.historyNextId, 4, 'transport failures are retried separately from the history cursor');
const recovered = await collect(failed, { ...settings, history: 0 }, source);
assert(recovered.posts.some((p) => p.id === 6), 'a later run recovers a failed ID after the history cursor moved on');
assert.deepEqual(recovered.retryIds, []);
for (const status of [429, 403]) {
  let calls = 0;
  const refused = await collect(second, settings, { ...source, fetcher: async () => {
    calls++; return new Response('Please wait', { status, headers: { 'retry-after': '7200' } });
  } });
  assert.equal(calls, 1, 'stop all public requests immediately on throttling or refusal');
  assert.equal(refused.lastRun.status, 'failed');
  assert.equal(Date.parse(refused.publicSafety.nextAttemptAt), source.now() + 7260000);
  assert.equal(refused.lastCheckedAt, second.lastCheckedAt);
  assert.deepEqual(refused.posts, second.posts);
  const held = await collect(refused, settings, { ...source, fetcher: async () => { throw Error('must not connect'); } });
  assert.equal(held.lastRun.status, 'partial');
  assert.equal(held.publicSafety.nextAttemptAt, refused.publicSafety.nextAttemptAt);
  const resumed = await collect(held, { ...settings, history: 0 }, { ...source, now: () => source.now() + 7260001 });
  assert.equal(resumed.publicSafety, null);
  assert.equal(resumed.lastRun.status, 'ok');
}
const down = await collect(second, settings, { ...source, fetcher: async () => new Response('outage', { status: 503 }) });
assert.equal(down.lastRun.status, 'failed');
assert.deepEqual(down.posts, second.posts);
assert.equal(down.capturedAt, second.capturedAt);
assert.equal(down.lastCheckedAt, second.lastCheckedAt);

// A deleted/restricted head is not a channel-wide outage. Reproduce the retained
// September head: its three captionless controls disappeared, while the older
// Hexaware caption and a September 7 publication remain publicly readable.
const previousCheck = '2026-09-06T08:00:00Z';
const nextCheck = '2026-09-07T02:00:00.000Z';
const knownHead = { channel, schemaVersion: 2, headId: 102828, historyNextId: 101000, discoveryNextId: 102900,
  capturedAt: previousCheck, lastCheckedAt: previousCheck,
  posts: [102828, 102827, 102826].map(id => ({ ...old(id), text: null, publishedAt: published, contentStatus: 'telegram-only' }))
    .concat({ ...old(102825), text: 'Hexaware Technologies: Vivek Jetley to take over as CEO', publishedAt: published }) };
const visible = upstream(new Map([
  [102825, { body: '<div class="tgme_widget_message_text">Hexaware Technologies: Vivek Jetley to take over as CEO</div>' }],
  [102829, { body: '<div class="tgme_widget_message_text">New September 7 research report</div>' }],
]));
const afterMissingHead = await collect(knownHead, { ...settings, history: 0 }, { ...visible, now: () => Date.parse(nextCheck) });
assert.equal(afterMissingHead.lastRun.status, 'ok', 'missing recent controls cannot permanently stop an otherwise readable public channel');
assert.equal(afterMissingHead.headId, 102829);
assert(afterMissingHead.posts.some(post => post.id === 102829 && post.text === 'New September 7 research report'));
assert(knownHead.posts.every(post => afterMissingHead.posts.some(retained => retained.id === post.id)), 'now-missing captured posts remain in history');
assert.equal(afterMissingHead.lastCheckedAt, nextCheck);
assert.equal(afterMissingHead.historyNextId, knownHead.historyNextId, 'a control recovery does not reset completed backfill progress');

const controlArchive = { channel, schemaVersion: 2, headId: 5000, historyNextId: 3900, discoveryNextId: 5200,
  capturedAt: previousCheck, lastCheckedAt: previousCheck, posts: Array.from({ length: 1000 }, (_, index) => old(5000 - index)) };
const oldestReadable = upstream(new Map([[4001, { body: '<div class="tgme_widget_message_text">Older public report</div>' }],
  [5001, { body: '<div class="tgme_widget_message_text">Newest public report</div>' }]]));
const distantControl = await collect(controlArchive, { ...settings, history: 0 }, oldestReadable);
assert(distantControl.posts.some(post => post.id === 5001), 'control diversity must reach retained history beyond the newest cluster');
assert.equal(distantControl.lastRun.status, 'ok');

const missingControls = upstream(new Map());
const noneReadable = await collect(controlArchive, settings, { ...missingControls, now: () => Date.parse(nextCheck) });
const probedIds = new Set(missingControls.calls.map(path => Number(path.match(/\/(\d+)\?/)?.[1])).filter(Boolean));
const archivedProbes = [...probedIds].filter(id => id <= controlArchive.headId);
assert(archivedProbes.length > 3 && archivedProbes.length <= 8, 'a failed control check probes diverse history with at most eight known-message candidates');
assert(missingControls.calls.length <= 17 + settings.forward * 2, 'missing controls allow only a bounded recent recovery window');
assert([...probedIds].every(id => controlArchive.posts.some(post => post.id === id) || (id > controlArchive.headId && id <= controlArchive.headId + settings.forward)), 'unverified controls cannot unlock sparse discovery or old history');
assert.equal(noneReadable.lastRun.status, 'failed');
assert.deepEqual(noneReadable.posts, controlArchive.posts);
for (const key of ['capturedAt', 'lastCheckedAt', 'headId', 'historyNextId', 'discoveryNextId']) {
  assert.equal(noneReadable[key], controlArchive[key], `failed diverse controls preserve ${key}`);
}

// A fallback control may be the first request that encounters a refusal. The
// collector must stop there, not continue through its other control candidates.
for (const status of [403, 429]) {
  const paths = [];
  let refusedAt = null;
  const fallbackRefused = await collect(knownHead, settings, { now: () => Date.parse(nextCheck), sleep: async () => {}, fetcher: async url => {
    const u = new URL(url), id = Number(u.pathname.split('/')[2]);
    paths.push(u.pathname + u.search);
    if (!id) return new Response(landing);
    if ([102828, 102827, 102826].includes(id)) return new Response(missing);
    assert.equal(refusedAt, null, 'no request may follow an explicit source refusal');
    refusedAt = paths.length;
    return new Response('Please wait', { status, headers: { 'retry-after': '7200' } });
  } });
  assert(refusedAt !== null, 'the fixture reaches an older fallback control');
  assert.equal(paths.length, refusedAt, 'a fallback refusal stops all remaining public requests immediately');
  assert.equal(fallbackRefused.lastRun.status, 'failed');
  assert.equal(fallbackRefused.publicSafety.reason, status === 403 ? 'source-refused' : 'rate-limit');
  assert.equal(Date.parse(fallbackRefused.publicSafety.nextAttemptAt), Date.parse(nextCheck) + 7260000);
  assert.deepEqual(fallbackRefused.posts, knownHead.posts);
  assert.equal(fallbackRefused.lastCheckedAt, knownHead.lastCheckedAt);
  assert.equal(fallbackRefused.historyNextId, knownHead.historyNextId);
}
await assert.rejects(() => collect({ channel: 'different', posts: [] }, settings, source), /another channel/);

const many = Array.from({ length: 650 }, (_, i) => old(1000 - i));
const large = await collect({ channel, posts: many, headId: 1000 }, { ...settings, history: 1 }, upstream(new Map([[1000, {}]])));
assert.equal(large.posts.length, 650, 'no 600-post retention cap');
const cold = await collect({}, { ...settings, headHint: 10 }, source);
assert(cold.posts.length && cold.historyNextId === 8, 'cold capture from a verified head hint');
const badHint = await collect(second, { ...settings, headHint: 100 }, source);
assert.equal(badHint.lastRun.status, 'failed');
assert.deepEqual(badHint.posts, second.posts);
// A forward sweep resumes beyond the first blank window and finds a post after a long gap.
const gap = await collect(second, { ...settings, history: 0, discovery: 2 }, upstream(new Map([...messages, [14, {}]])));
assert.equal(gap.headId, 14);
assert(gap.posts.some((p) => p.id === 14));

// Every old control can disappear without blocking a newly matching public message.
const newControl = upstream(new Map([[5001, { body: '<div class="tgme_widget_message_text">Fresh report after all old controls disappeared</div>' }]]));
const allControlsGone = await collect(controlArchive, { ...settings, phase: 'recent' }, newControl);
assert.equal(allControlsGone.lastRun.status, 'ok');
assert.equal(allControlsGone.headId, 5001);
assert.equal(allControlsGone.posts.length, controlArchive.posts.length + 1);
assert.equal(allControlsGone.historyNextId, controlArchive.historyNextId);
assert(newControl.calls.every(path => !Number(path.match(/\/(\d+)\?/)?.[1]) || Number(path.match(/\/(\d+)\?/)?.[1]) <= 5002), 'recovery remains within the bounded recent window');

let slowClock = Date.parse(nextCheck);
const slowPaths = [];
const slowControls = await collect({ ...knownHead, headId: 10, posts: [old(10), old(9), old(8)] },
  { ...settings, phase: 'recent', budget: 10000 }, {
    now: () => slowClock, sleep: async ms => { slowClock += ms; }, fetcher: async url => {
      const id = Number(new URL(url).pathname.split('/')[2]);
      slowPaths.push(id); slowClock += 500;
      return new Response(!id ? landing : id === 10 ? 'temporary outage' : id === 11 ? embed(11, '<div class="tgme_widget_message_text">New report</div>') : missing,
        { status: id === 10 ? 503 : 200 });
    } });
assert(slowControls.posts.some(post => post.id === 11), 'slow obsolete controls cannot consume the entire recent window budget');
assert(!slowPaths.includes(9) && !slowPaths.includes(8), 'the fallback control time allowance leaves time for recent arrivals');
assert.equal(slowControls.lastRun.status, 'partial', 'the failed historical control remains visible even when a new report recovers');

const freshPrior = { channel, schemaVersion: 2, headId: 10, historyNextId: 5,
  lastCheckedAt: previousCheck, posts: [old(10)] };
const freshMessages = new Map([[10, { body: '<div class="tgme_widget_message_text">Known report</div>' }],
  [11, { body: '<div class="tgme_widget_message_text">New report</div>' }], [5, {}], [4, {}]]);
const freshSource = upstream(freshMessages, { fail: new Set([36]) });
const checkpoints = [];
const searchFailure = await collect(freshPrior, settings, { ...freshSource,
  checkpoint: async snapshot => checkpoints.push({ snapshot, paths: [...freshSource.calls] }) });
const freshCheckpoint = checkpoints.find(item => item.snapshot.posts.some(post => post.id === 11));
assert(freshCheckpoint, 'new rows are checkpointed before optional head search');
assert(freshCheckpoint.paths.every(path => !Number(path.match(/\/(\d+)\?/)?.[1]) || Number(path.match(/\/(\d+)\?/)?.[1]) <= 12));
assert(freshSource.calls.some(path => path.startsWith(`/${channel}/36?`)), 'the fixture really executes sparse head search');
assert.equal(searchFailure.lastRun.status, 'partial', 'search transport failures cannot masquerade as confirmed absence');
assert.equal(searchFailure.lastCheckedAt, previousCheck, 'an incomplete full search cannot certify a quiet check');
assert(searchFailure.retryIds.includes(36));
assert(searchFailure.posts.some(post => post.id === 11), 'later search failure retains the already captured fresh report');
const malformedSource = upstream(freshMessages);
const malformedSearch = await collect(freshPrior, settings, { ...malformedSource,
  fetcher: async url => new URL(url).pathname.endsWith('/36') ? new Response(landing) : malformedSource.fetcher(url) });
assert.equal(malformedSearch.lastRun.status, 'partial', 'a successful HTTP response with an invalid embed is a search failure');
assert(malformedSearch.retryIds.includes(36));

for (const status of [403, 429]) {
  const safeSource = upstream(freshMessages), savedPauses = [];
  let refused = false;
  const pausedSearch = await collect(freshPrior, settings, { ...safeSource,
    checkpoint: async capture => { if (capture.publicSafety) savedPauses.push(capture); },
    fetcher: async url => {
      assert(!refused, 'a refusal in optional discovery stops every subsequent source request');
      if (new URL(url).pathname.endsWith('/36')) { refused = true; return new Response('wait', { status, headers: { 'retry-after': '7200' } }); }
      return safeSource.fetcher(url);
    } });
  assert(refused);
  assert.equal(pausedSearch.lastRun.status, 'failed');
  assert(savedPauses.length > 0, 'the source wait is checkpointed immediately when encountered');
  assert.equal(savedPauses[0].publicSafety.nextAttemptAt, pausedSearch.publicSafety.nextAttemptAt);
  assert(savedPauses[0].posts.some(post => post.id === 11), 'fresh arrivals survive a later source refusal');
}

const recentSource = upstream(freshMessages);
const recentOnly = await collect({ ...freshPrior, retryIds: [4], catchupRanges: [{ from: 6, to: 7 }] },
  { ...settings, phase: 'recent', discovery: 10, history: 20 }, recentSource);
assert.equal(recentOnly.lastRun.status, 'ok');
assert.equal(recentOnly.historyNextId, freshPrior.historyNextId);
assert.deepEqual(recentOnly.catchupRanges, [{ from: 6, to: 7 }]);
assert.deepEqual(recentOnly.retryIds, [4], 'recent publication does not wait for old retries');
assert(recentSource.calls.every(path => !/\/(?:4|5|6|7|35|36)\?/.test(path)), 'recent-only phase skips sparse discovery and older history');
const historySource = upstream(freshMessages);
const historyOnly = await collect(recentOnly, { ...settings, phase: 'history', jumpShare: 0 }, historySource);
assert.equal(historyOnly.lastRun.status, 'ok', 'successful historical progress need not repeat a fresh-window check');
assert.equal(historyOnly.lastCheckedAt, recentOnly.lastCheckedAt);
assert(!historySource.calls.some(path => path.startsWith(`/${channel}/12?`)), 'history-only phase skips the already published recent forward pass');
assert.equal(historyOnly.historyNextId, 4);
const unfinishedRecent = await collect(freshPrior, { ...settings, phase: 'recent', forward: 5, budget: 1050 }, upstream(freshMessages));
assert.equal(unfinishedRecent.lastRun.status, 'partial');
assert(unfinishedRecent.posts.some(post => post.id === 11), 'the budget can end after useful arrivals but before the recent window finishes');
const historyAfterPartial = await collect(unfinishedRecent,
  { ...settings, phase: 'history', jumpShare: 0, history: 2 }, upstream(freshMessages));
assert.equal(historyAfterPartial.lastRun.status, 'partial', 'successful optional history cannot clear an unfinished recent check');
assert.equal(historyAfterPartial.lastCheckedAt, freshPrior.lastCheckedAt);

// Repeated jumps advance an independent catch-up queue and keep moving old history.
const firstJump = await collect(freshPrior, { ...settings, phase: 'history', history: 4 },
  upstream(new Map([[10, { body: '<div class="tgme_widget_message_text">Known</div>' }], [83, {}], [5, {}], [4, {}]])));
assert.equal(firstJump.headId, 83);
assert.equal(firstJump.historyNextId, 3);
assert.deepEqual(firstJump.catchupRanges, [{ from: 11, to: 81 }]);
const secondJump = await collect(firstJump, { ...settings, phase: 'history', history: 4 },
  upstream(new Map([[83, {}], [156, {}], [3, {}], [2, {}]])));
assert.equal(secondJump.headId, 156);
assert.equal(secondJump.historyNextId, 1, 'another new head cannot reset older progress');
assert.deepEqual(secondJump.catchupRanges, [{ from: 84, to: 154 }, { from: 11, to: 81 }], 'both interrupted catch-up intervals survive another jump');
assert.equal(secondJump.lastCheckedAt, previousCheck, 'historical discovery never advances the successful recent-check time');

// Deterministic request timers distinguish the overall collection deadline from the
// normal 15-second upstream timeout. No real waits or Telegram requests are involved.
function deadlineSource({ target = 5, kind = 'confirm', budget = 4000 } = {}) {
  let clock = Date.parse(nextCheck);
  let targetRequests = 0;
  const deadline = clock + budget, timers = new WeakMap(), calls = [];
  return { calls, budget, now: () => clock, sleep: async ms => { clock += ms; },
    timeoutSignal(ms) { const controller = new AbortController(); timers.set(controller.signal, { controller, ms }); return controller.signal; },
    async fetcher(url, { signal }) {
      const u = new URL(url), id = Number(u.pathname.split('/')[2]); calls.push(u.pathname + u.search);
      if (id !== target) { clock += 10; return new Response(!id ? landing : embed(id, '<div class="tgme_widget_message_text">Available report</div>')); }
      targetRequests++;
      if (kind === 'http-then-signal' && targetRequests === 1) { clock += 10; return new Response('Unavailable', { status: 503 }); }
      if (kind === 'confirm') { clock = deadline - 500; return new Response(missing); }
      if (kind === 'permalink') { clock = deadline - 500; return new Response(embed(id)); }
      if (['permalink-signal', 'permalink-http'].includes(kind) && u.search) { clock += 10; return new Response(embed(id)); }
      if (kind === 'http' || kind === 'permalink-http') { clock = deadline - 500; return new Response('Unavailable', { status: 503 }); }
      // The request remains pending until its supplied timer aborts it. A shortened
      // timer ends at the local deadline; a normal 15-second timer is a source failure.
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        queueMicrotask(() => { const { controller, ms } = timers.get(signal); clock += ms;
          controller.abort(new DOMException('Request timed out', 'TimeoutError')); });
      });
    } };
}
for (const kind of ['confirm', 'signal']) {
  const historyDeadline = deadlineSource({ kind });
  const stoppedHistory = await collect(freshPrior, { ...settings, phase: 'history', jumpShare: 0, budget: historyDeadline.budget }, historyDeadline);
  assert.equal(stoppedHistory.lastRun.status, 'ok', 'a local historical time budget is a resumable stop, not an upstream failure');
  assert.equal(stoppedHistory.lastRun.errors, 0);
  assert.deepEqual(stoppedHistory.retryIds, []);
  assert.equal(stoppedHistory.historyNextId, 5, 'the unfinished ID remains the next historical lookup');
  assert.equal(stoppedHistory.lastCheckedAt, previousCheck);
  assert.equal(historyDeadline.calls.filter(path => path.startsWith(`/${channel}/5?`)).length, 1, 'budget exhaustion does not retry an unfinished request');
  const recoveredHistory = await collect(stoppedHistory, { ...settings, phase: 'history', jumpShare: 0, history: 1 }, upstream(freshMessages));
  assert.equal(recoveredHistory.historyNextId, 4);
  assert(recoveredHistory.posts.some(post => post.id === 5), 'the next run resumes and captures the exact deferred ID');
}
for (const [kind, target, prior, extra, field, expected] of [
  ['confirm', 7, { ...freshPrior, catchupRanges: [{ from: 6, to: 7 }] }, {}, 'catchupRanges', [{ from: 6, to: 7 }]],
  ['signal', 15, { ...freshPrior, discoveryNextId: 15 }, { discovery: 2 }, 'discoveryNextId', 15],
  ['permalink', 8, { ...freshPrior, retryIds: [8] }, {}, 'retryIds', [8]],
]) {
  const source = deadlineSource({ kind, target });
  const stopped = await collect(prior, { ...settings, phase: 'history', jumpShare: 0, budget: source.budget, ...extra }, source);
  assert.equal(stopped.lastRun.status, 'ok');
  assert.equal(stopped.lastRun.errors, 0);
  assert.deepEqual(stopped[field], expected, 'a local deadline preserves the active pending cursor or pre-existing retry');
  assert.equal(stopped.historyNextId, prior.historyNextId);
}
for (const kind of ['confirm', 'signal', 'permalink', 'permalink-signal']) {
  const source = deadlineSource({ target: 11, kind });
  const stopped = await collect(freshPrior, { ...settings, phase: 'recent', budget: source.budget }, source);
  assert.equal(stopped.lastRun.status, 'partial', 'an unfinished recent window cannot be certified by a local deadline');
  assert.equal(stopped.lastRun.errors, 0);
  assert.equal(stopped.lastCheckedAt, previousCheck);
  assert.deepEqual(stopped.retryIds, []);
  assert.equal(stopped.historyNextId, freshPrior.historyNextId);
  if (kind.startsWith('permalink')) {
    assert(stopped.posts.some(post => post.id === 11 && post.publishedAt === published), 'a verified embed survives an unfinished text lookup');
    assert.deepEqual(stopped.catchupRanges, [{ from: 11, to: 11 }], 'unfinished new text remains reachable after the head advances');
    const recovered = await collect(stopped, { ...settings, phase: 'history', jumpShare: 0, history: 1 },
      upstream(new Map([[11, { permalink: '<meta property="og:description" content="Recovered report text">' }]])));
    assert.equal(recovered.posts.find(post => post.id === 11).text, 'Recovered report text');
    assert.deepEqual(recovered.catchupRanges, []);
  }
}
for (const source of [deadlineSource({ kind: 'http' }), deadlineSource({ kind: 'http-then-signal' }), deadlineSource({ kind: 'signal', budget: 60000 })]) {
  const failedSource = await collect(freshPrior, { ...settings, phase: 'history', jumpShare: 0, budget: source.budget, history: 1 }, source);
  assert.equal(failedSource.lastRun.status, 'partial', 'a real503 or normal15-second timeout remains a failed lookup');
  assert.equal(failedSource.lastRun.errors, 1);
  assert.deepEqual(failedSource.retryIds, [5]);
  assert.equal(failedSource.historyNextId, 4, 'genuine failures retain the existing retry-queue recovery behavior');
}
const failedTextSource = deadlineSource({ target: 11, kind: 'permalink-http' });
const failedText = await collect(freshPrior, { ...settings, phase: 'recent', budget: failedTextSource.budget }, failedTextSource);
assert.equal(failedText.lastRun.status, 'partial');
assert.equal(failedText.lastRun.errors, 1, 'a real permalink failure must not be hidden by a following budget stop');
assert.deepEqual(failedText.retryIds, [11]);
assert(failedText.posts.some(post => post.id === 11), 'verified identity survives a genuine text-source failure too');
assert.equal(failedText.lastCheckedAt, previousCheck);

const originalRanges = Array.from({ length: 128 }, (_, index) => ({ from: index * 3 + 1, to: index * 3 + 1 }));
const bounded = await collect({ ...freshPrior, headId: 1000, posts: [old(1000)], catchupRanges: originalRanges },
  { ...settings, phase: 'recent', headHint: 1002 }, upstream(new Map([[1002, {}]])));
assert(bounded.catchupRanges.length <= 128);
for (const id of [...originalRanges.map(range => range.from), 1001, 1002]) {
  assert(bounded.catchupRanges.some(range => range.from <= id && range.to >= id), 'bounding pending intervals never drops an unread ID');
}

// Kill the actual CLI after its fresh pass, before it can reach final persistence.
// The atomically written checkpoint must still contain that new report and its cursors.
const checkpointDir = await mkdtemp(join(tmpdir(), 'telegram-checkpoint-'));
try {
  const output = join(checkpointDir, 'capture.json'), fixture = join(checkpointDir, 'source.mjs');
  await writeFile(output, JSON.stringify(freshPrior));
  await writeFile(fixture, `const channel=${JSON.stringify(channel)}, landing=${JSON.stringify(landing)}, missing=${JSON.stringify(missing)};
    globalThis.fetch=async(url)=>{const u=new URL(url),id=Number(u.pathname.split('/')[2]);
      if(id>12)process.exit(37);
      if(!id)return new Response(landing);
      if(id===10||id===11)return new Response('<div class="tgme_widget_message" data-post="'+channel+'/'+id+'"><div class="tgme_widget_message_text">Report '+id+'</div><time datetime="${published}"></time></div>');
      return new Response(missing);};`);
  assert.throws(() => execFileSync(process.execPath, ['--import', fixture, 'scripts/scrape-telegram.mjs'], { env: { ...process.env,
    TELEGRAM_OUT: output, TELEGRAM_PHASE: 'full', TELEGRAM_FORWARD: '2', TELEGRAM_BACKFILL: '2', TELEGRAM_DISCOVERY: '0',
    TELEGRAM_DELAY_MS: '0', TELEGRAM_BUDGET_MS: '20000', TELEGRAM_JUMP_SPAN: '100', TELEGRAM_JUMP_SAMPLES: '4' }, stdio: 'pipe' }),
    error => error.status === 37, 'the collector is interrupted during optional sparse discovery');
  const saved = JSON.parse(await readFile(output, 'utf8'));
  assert(saved.posts.some(post => post.id === 11), 'fresh rows survive a process exiting before the final save');
  assert.equal(saved.lastRun.status, 'partial', 'unfinished work is never saved as a completed successful run');
  assert.equal(saved.historyNextId, freshPrior.historyNextId);
  const resumed = await collect(saved, { ...settings, phase: 'recent' }, upstream(freshMessages));
  assert.equal(resumed.lastRun.status, 'ok');
  assert.equal(new Set(resumed.posts.map(post => post.id)).size, resumed.posts.length);
  assert(saved.posts.every(post => resumed.posts.some(row => row.id === post.id)));
} finally { await rm(checkpointDir, { recursive: true, force: true }); }

const archive = JSON.parse(await readFile('public/data/telegram-posts.json', 'utf8'));
assert(Array.isArray(archive.posts) && archive.posts.length > 0);
assert.equal(new Set(archive.posts.map((p) => p.id)).size, archive.posts.length);
assert(archive.posts.every((p) => Number.isSafeInteger(p.id) && p.id > 0 && (p.text || p.publishedAt)));
const workflow = await readFile('.github/workflows/telegram-refresh.yml', 'utf8');
assert(!/HEAD:main|Commit.*main/.test(workflow), 'archive writes go through PRs');
assert(workflow.includes('actions/upload-artifact@v7'));
assert(!workflow.includes('merge-telegram-capture.mjs'), 'source collection cannot wait for repository publication');
const recentPhase = workflow.indexOf('TELEGRAM_PHASE: recent');
const earlyUpload = workflow.indexOf('name: Deliver recent posts while history continues');
const historyPhase = workflow.indexOf('TELEGRAM_PHASE: history');
const finalUpload = workflow.lastIndexOf('uses: actions/upload-artifact@v7');
const healthFailure = workflow.indexOf('name: Collection health');
assert(recentPhase > 0 && recentPhase < earlyUpload && earlyUpload < historyPhase && historyPhase < finalUpload && finalUpload < healthFailure,
  'recent delivery precedes history and final source health is published before failing the job');
assert.match(workflow, /id: package\n\s+if:.*!cancelled\(\).*restore.outcome == 'success'/,
  'source failure cannot skip the final retained/safety checkpoint');
assert.match(workflow, /actions\/checkout@v5\n\s+with:\n\s+ref: main/, 'queued collection uses the current reviewed code');
const archiveWorkflow = await readFile('.github/workflows/telegram-archive.yml', 'utf8');
assert(archiveWorkflow.includes('merge-telegram-capture.mjs'));
assert(!/HEAD:main|Commit.*main/.test(archiveWorkflow));
console.log('PASS Telegram: recent-first phases, all-deleted control recovery, search error honesty, independent catch-up/history, atomic interruption recovery, immediate persisted source waits, retention, parsing and PR publishing contract');
