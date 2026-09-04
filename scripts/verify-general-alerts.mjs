#!/usr/bin/env node
// Real adapters and shipped captures, with every fetch replaced. No egress or production writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const read = (path) => JSON.parse(readFileSync(resolve(root, path)));
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
} });
Date.now = () => Date.parse('2026-09-04T08:00:00Z');
const calls = [];
const broken = new Set();
let revision = 1;
let nseGate = null;
const undated = { company: 'Unresolved issuer', ticker: null, publishedAt: null, subject: 'Undated filing', url: 'https://example.test/undated.pdf' };
const nseRow = { company: 'Sterlite Technologies', ticker: 'STLTECH', publishedAt: '2026-09-03T20:00:00Z', subject: 'Analyst day', url: 'https://example.test/analyst.pdf', description: 'Entire source description' };
globalThis.fetch = async (input) => {
  const url = String(input); calls.push(url);
  if (/^https?:/.test(url)) return new Response('{}', { status: 503 });
  const path = url.split('?')[0];
  if (broken.has(path)) return new Response('{}', { status: 503 });
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (path === 'api/nse-announcements') { if (nseGate) await nseGate; return json({ rows: [nseRow, nseRow, undated, ...(revision > 1 ? [{ ...nseRow, url: 'https://example.test/new.pdf' }] : [])], capturedAt: '2026-09-04T07:00:00Z' }); }
  if (path === 'data/twitter-posts.json') return json({ capturedAt: '2026-09-04T07:00:00Z', handles: ['moneycontrolcom'], failed: [], posts: [
    { tweet_id: '1', handle: 'moneycontrolcom', text: 'IPO discussion, original words', created_at: '2026-09-03T20:10:00Z' },
    { tweet_id: '2', handle: 'moneycontrolcom', text: 'Undated original post', created_at: null },
  ] });
  const mapped = { 'api/earnings': 'data/earnings-live.json', 'api/concalls': 'data/concall-scans.json' }[path] || path;
  const file = resolve(root, mapped);
  assert(file.startsWith(root + sep), 'fixture path must stay in public');
  try { return json(read(mapped)); } catch { return new Response('{}', { status: 404 }); }
};

const alerts = await import('../public/js/data/daily-alerts.js');
const records = await import('../public/js/data/alert-records.js');
const { nseRecords, ipoRecords } = await import('../public/js/data/alert-sources.js');
const coverage = await import('../public/js/data/coverage.js');
const watchlist = await import('../public/js/core/watchlist.js');
const ai = await import('../public/js/data/ai-alerts.js');
coverage.prime({ holdings: [{ ticker: 'STLTECH', name: 'Sterlite Technologies' }, { ticker: 'RELIANCE', name: 'Reliance Industries' }] });

const expected = ['technicals', 'earnings', 'concalls', 'chatter', 'investors', 'announcements', 'insider', 'news', 'market-news',
  'nse-filings', 'twitter', 'ipos', 'earnings-calendar', 'scheduled-concalls', 'investor-positions', 'institutions', 'chatter-posts', 'company-documents', 'drhp-documents'];
assert.deepEqual(alerts.FEEDS.map((f) => f.id), expected, 'explicit registry parity: adding a tab/source must update the pool contract');
assert.equal(nseRecords([nseRow])[0].day, '2026-09-04', 'timestamps use IST, not their UTC date prefix');
assert.equal(nseRecords([undated])[0].day, null, 'no invented date');
const snap = read('data/ipo-monitor/latest.json');
assert.equal(ipoRecords([snap, snap]).length, ipoRecords([snap]).length, 'IPO captures deduplicate identical filings/observations');

const options = { day: '2026-09-04', includeHistory: true };
const universe = await alerts.collect({ ...options, scope: 'universe' });
console.log('Collected initial pool');
assert.equal(universe.pending, 0);
assert(universe.events.length > 1000, 'real retained records loaded');
assert.equal(new Set(universe.events.map((e) => e.id)).size, universe.events.length);
assert(universe.events.every((e) => e.sourceRecord), 'every event preserves the full normalized source record');
assert(universe.events.every((e) => e.signalReason && e.importanceReason));
assert(universe.events.some((e) => e.url === nseRow.url && e.day === '2026-09-04'));
assert.equal(universe.events.filter((e) => e.url === nseRow.url).length, 1, 'identical source copies are not duplicated');
assert(universe.events.some((e) => e.url === undated.url && !e.day && !e.ticker));
assert.equal((await import('../public/js/data/nse-filings.js')).meta().windowDays, 7, 'pool history loading does not change the NSE tab date window');
assert(universe.events.some((e) => e.id === 'tw:1' && e.day === '2026-09-04'));
assert(universe.events.some((e) => e.id === 'tw:2' && !e.day));
assert(universe.events.some((e) => e.kind === 'scheduled' && e.day > options.day));
assert(universe.events.some((e) => e.feed === 'technicals' && e.kind === 'price-reading' && e.importance === 'low'));
assert(universe.events.some((e) => e.feed === 'investor-positions' && /Filing due/.test(e.detail) && e.direction === 'neutral'));
assert(universe.events.some((e) => e.feed === 'institutions'));
assert(universe.events.some((e) => e.feed === 'ipos'));
assert(universe.events.some((e) => e.feed === 'ipos' && e.company === 'EAAA India Alternatives Limited' && e.headline.includes('supplement')),
  'EAAA tracked-issuer evidence must join the pool, not just the weekly snapshots');
assert.equal(universe.feeds.find((f) => f.id === 'chatter').status, 'failed', 'outage does not look like zero chatter');
for (const id of ['chatter-posts', 'company-documents', 'drhp-documents'])
  assert.equal(universe.feeds.find((f) => f.id === id).status, 'on-demand');

const previousCalls = calls.length;
console.log('Checking scope and privacy');
const portfolio = await alerts.collect({ ...options, scope: 'portfolio', load: false });
const emptyWatchlist = await alerts.collect({ ...options, scope: 'watchlist', load: false });
assert.equal(emptyWatchlist.events.length, 0, 'empty Watchlist never becomes Universe');
const poolSubset = universe.events.filter((e) => ['STLTECH', 'RELIANCE'].includes(e.ticker));
assert.deepEqual(portfolio.events.map((e) => e.id).sort(), poolSubset.map((e) => e.id).sort(), 'Portfolio is an exact view of the same pool');
watchlist.toggle('STLTECH', 'Sterlite Technologies');
const watched = await alerts.collect({ ...options, scope: 'watchlist', load: false });
assert.deepEqual(watched.events.map((e) => e.id).sort(), universe.events.filter((e) => e.ticker === 'STLTECH').map((e) => e.id).sort());
assert.equal(calls.length, previousCalls, 'scope/filter changes require no extra fetch');
assert.equal(portfolio.feeds.find((f) => f.id === 'twitter').scopable, false);
assert(portfolio.feeds.find((f) => f.id === 'nse-filings').unresolvedCount > 0, 'unresolved omissions are counted');

const privateRow = { key: 'private-1', ticker: 'STLTECH', date: null, title: 'Private annual report', url: 'https://example.test/annual.pdf', isRead: true };
records.recordDocuments('company-documents', { rows: [privateRow, privateRow] }, { ticker: 'STLTECH', name: 'Sterlite Technologies' });
const privateReport = await alerts.collect({ ...options, scope: 'portfolio', load: false });
assert.equal(privateReport.events.filter((e) => e.private).length, 1);
assert.equal(privateReport.events.find((e) => e.private).sourceRecord.isRead, true);
assert([...storage.values()].every((value) => !String(value).includes('Private annual report')), 'private data never persists');
records.clearPrivateRecords();
assert(!(await alerts.collect({ ...options, scope: 'universe', load: false })).events.some((e) => e.private));
records.recordDocuments('company-documents', { rows: [privateRow] }, { ticker: 'STLTECH' });
let releaseNse;
nseGate = new Promise((done) => { releaseNse = done; });
const partials = [];
const racing = alerts.collect({ ...options, scope: 'universe', refresh: true, onPartial: report => partials.push(report) });
await new Promise((done) => setImmediate(done));
assert(partials.length > 0, 'fast sources produce updates while NSE is still checking');
assert(partials.every(report => report.events.some(e => e.url === nseRow.url)), 'a slow refreshing source keeps its previous records in every partial');
assert(partials.every(report => report.feeds.find(f => f.id === 'nse-filings').status === 'pending'), 'retained records do not imply a finished refresh');
records.clearPrivateRecords(); releaseNse(); nseGate = null;
assert(!(await racing).events.some((e) => e.private), 'a public read finishing after logout cannot restore old private records');

revision++;
console.log('Checking refresh and recovery');
const refreshed = await alerts.collect({ ...options, scope: 'universe', refresh: true });
assert(refreshed.events.some((e) => e.url === 'https://example.test/new.pdf'), 'a newer NSE filing reaches the pool');
for (const path of ['data/technicals.json', 'data/twitter-posts.json', 'data/market-news.json', 'data/earnings-calendar.json'])
  assert(calls.filter((c) => c === path).length >= 2, `${path} really revalidates`);
broken.add('data/technicals.json');
broken.add('data/market-news.json');
broken.add('data/twitter-posts.json');
broken.add('api/concalls');
const degraded = await alerts.collect({ ...options, scope: 'universe', refresh: true });
assert.equal(degraded.feeds.find((f) => f.id === 'technicals').status, 'failed');
assert(degraded.events.some((e) => e.feed === 'technicals'), 'failed refresh retains last-good technical rows');
for (const id of ['market-news', 'twitter', 'concalls']) {
  assert.equal(degraded.feeds.find((f) => f.id === id).status, 'failed', `${id} cannot conceal a failed refresh`);
  assert(degraded.events.some((e) => e.feed === id), `${id} retains last-good records`);
}
assert.equal((await alerts.collect({ ...options, scope: 'universe', load: false })).feeds.find((f) => f.id === 'technicals').status, 'failed', 'a cached repaint cannot hide a failed refresh');
broken.clear();
const recovered = await alerts.collect({ ...options, scope: 'universe', refresh: true });
assert.equal(recovered.feeds.find((f) => f.id === 'technicals').status, 'ok');
assert(!calls.some((url) => /api\/(combined-filings|drhp-filings|super-investors\/|company-news\/|announcements\/|insider-trades\/)/.test(url)), 'no private or per-company fanout');

// Expanding the collection pool must not quietly rewrite the existing AI prioritization policy.
const legacy = { day: options.day, scope: 'portfolio', events: [{ id: 'e', ticker: 'STLTECH', day: options.day, feed: 'earnings', headline: 'Filed result', importance: 'high', direction: 'positive' }], feeds: [{ id: 'earnings', status: 'ok', reachesToday: true }] };
const raw = records.record({ id: 'snapshot', row: {}, at: options.day, ticker: 'STLTECH', headline: 'Snapshot' });
const before = ai.rankReport(legacy).cards;
assert.deepEqual(ai.rankReport({ ...legacy, events: [...legacy.events, { ...raw, feed: 'institutions' }] }).cards, before);
console.log(`PASS: 19 feed adapters; ${universe.events.length} retained records; scope parity, undated/upcoming, raw records, privacy, refresh/recovery and AI compatibility.`);
