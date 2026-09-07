#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { config, collect } from './scrape-telegram.mjs';
import { decodeEntities, parseEmbed, permalinkText } from './lib/telegram.mjs';
const channel = 'researchreportss';
const published = '2026-05-13T10:57:05.000Z';
const embed = (id, body = '') => `<div class="tgme_widget_message" data-post="${channel}/${id}">${body}<a><time datetime="${published}">May 13</time></a></div>`;
const missing = '<div class="tgme_widget_message_error" dir="auto">Post not found</div>';
const landing = '<meta property="og:title" content="Research Reports"><meta property="og:description" content="Channel bio">';
const old = (id) => ({ id, text: `Old ${id}`, url: `https://t.me/${channel}/${id}`, publishedAt: null, firstSeenAt: '2026-09-01T00:00:00Z' });
const settings = { channel, history: 2, forward: 2, discovery: 0, delay: 0, budget: 20000, headHint: 0 };
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

function upstream(messages, { fail = new Set(), status = 503 } = {}) {
  const calls = [];
  return { calls, fetcher: async (url) => {
    const u = new URL(url), id = Number(u.pathname.split('/')[2]);
    calls.push(u.pathname + u.search);
    if (!id) return new Response(landing);
    if (fail.has(id)) return new Response('retry later', { status });
    if (!u.search) return new Response(messages.get(id)?.permalink || landing);
    return new Response(messages.has(id) ? embed(id, messages.get(id).body || '') : missing);
  }, sleep: async () => {}, now: () => Date.parse('2026-09-06T00:00:00Z') };
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
assert(probedIds.size > 3 && probedIds.size <= 8, 'a failed control check probes diverse history with at most eight known-message candidates');
assert(missingControls.calls.length <= 17, 'confirmed missing controls need at most two reads per candidate plus the landing page');
assert([...probedIds].every(id => controlArchive.posts.some(post => post.id === id)), 'an unverified channel must not enter forward or backfill scans');
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

const archive = JSON.parse(await readFile('public/data/telegram-posts.json', 'utf8'));
assert(Array.isArray(archive.posts) && archive.posts.length > 0);
assert.equal(new Set(archive.posts.map((p) => p.id)).size, archive.posts.length);
assert(archive.posts.every((p) => Number.isSafeInteger(p.id) && p.id > 0 && (p.text || p.publishedAt)));
const workflow = await readFile('.github/workflows/telegram-refresh.yml', 'utf8');
assert(!/HEAD:main|Commit.*main/.test(workflow), 'archive writes go through PRs');
assert(workflow.includes('actions/upload-artifact@v7'));
assert(!workflow.includes('merge-telegram-capture.mjs'), 'source collection cannot wait for repository publication');
const archiveWorkflow = await readFile('.github/workflows/telegram-archive.yml', 'utf8');
assert(archiveWorkflow.includes('merge-telegram-capture.mjs'));
assert(!/HEAD:main|Commit.*main/.test(archiveWorkflow));
console.log('PASS Telegram: verified identities/dates, hidden posts, caption edits, history resume, uncapped retention, retry recovery, bounded diverse controls, missing-head recovery, fallback refusal stops, source failure, gap discovery and PR publishing contract');
