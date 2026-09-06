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
const outsideNseRow = { ...nseRow, company: 'Hexaware Technologies', ticker: 'HEXT', subject: 'Chief executive transition', url: 'https://example.test/hexaware-ceo.pdf' };
const portfolioUpcomingFixture = [
  { id: 'STLTECH|2026-09-10|AGM|day', companyKey: 'STLTECH', ticker: 'STLTECH', name: 'Sterlite Technologies', date: '2026-09-10', time: null, eventType: 'AGM', companyUrl: 'https://www.screener.in/company/STLTECH/', sourceUrl: 'https://www.screener.in/company/STLTECH/', observedAt: '2026-09-04T07:00:00Z' },
  { id: '500001|2026-09-12|Postal ballot|day', companyKey: '500001', ticker: null, name: 'BSE-only portfolio company', date: '2026-09-12', time: null, eventType: 'Postal ballot', companyUrl: 'https://www.screener.in/company/500001/', sourceUrl: 'https://www.screener.in/company/500001/', observedAt: '2026-09-04T07:00:00Z' },
];
globalThis.fetch = async (input) => {
  const url = String(input); calls.push(url);
  if (/^https?:/.test(url)) return new Response('{}', { status: 503 });
  const path = url.split('?')[0];
  if (broken.has(path)) return new Response('{}', { status: 503 });
  const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (path === 'api/nse-announcements') { if (nseGate) await nseGate; return json({ rows: [nseRow, nseRow, undated, outsideNseRow,
    ...(revision > 1 ? [{ ...nseRow, url: 'https://example.test/new.pdf' }] : []),
    ...(revision > 2 ? [{ ...nseRow, url: 'https://example.test/other-tab.pdf' }] : [])], capturedAt: '2026-09-04T07:00:00Z' }); }
  if (path === 'data/twitter-posts.json') return json({ capturedAt: '2026-09-04T07:00:00Z', handles: ['moneycontrolcom'], failed: [], posts: [
    { tweet_id: '1', handle: 'moneycontrolcom', text: 'IPO discussion, original words', created_at: '2026-09-03T20:10:00Z' },
    { tweet_id: '2', handle: 'moneycontrolcom', text: 'Undated original post', created_at: null },
  ] });
  if (path === 'api/concalls') return json({ ...read('data/concall-scans.json'), portfolioUpcoming: portfolioUpcomingFixture,
    meta: { ...read('data/concall-scans.json').meta, screener: { status: 'ok', checkedAt: '2026-09-04T07:00:00Z', portfolioUpcomingAvailable: true } } });
  const mapped = { 'api/earnings': 'data/earnings-live.json' }[path] || path;
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
  'nse-filings', 'twitter', 'ipos', 'earnings-calendar', 'scheduled-concalls', 'screener-portfolio-upcoming', 'investor-positions', 'institutions', 'chatter-posts', 'company-documents', 'drhp-documents'];
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
assert(!universe.events.some((e) => e.feed === 'screener-portfolio-upcoming'), 'portfolio-only calendar never leaks into Universe');
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
let cachedPartials = 0;
const portfolio = await alerts.collect({ ...options, scope: 'portfolio', load: false, onPartial: () => cachedPartials++ });
assert.equal(cachedPartials, 0, 'cached scope changes assemble one completed report, not twenty full intermediate reports');
const firstTechnical = (report) => report.feeds.find((f) => f.id === 'technicals').events[0];
const cachedUniverse = await alerts.collect({ ...options, scope: 'universe', load: false });
assert.equal(firstTechnical(cachedUniverse), firstTechnical(universe), 'unchanged feeds reuse normalized evidence, not only their network payload');
const originalNow = Date.now;
Date.now = () => originalNow() + 5 * 60_000;
const afterIdle = await alerts.collect({ ...options, scope: 'universe', load: false });
assert.equal(firstTechnical(afterIdle), firstTechnical(universe), 'returning after idle does not rebuild unchanged evidence on a timer');
Date.now = originalNow;
const singleDay = await alerts.collect({ ...options, includeHistory: false, scope: 'universe', load: false });
assert(singleDay.events.every((e) => e.day === options.day), 'history cache cannot leak other dates into a daily report');
const nextDay = await alerts.collect({ ...options, day: '2026-09-05', scope: 'universe', load: false });
assert.equal(nextDay.feeds.find((f) => f.id === 'nse-filings').reachesToday, false, 'cached freshness re-ages when the requested IST day changes');
const scope = await import('../public/js/data/scope.js');
let membershipReads = 0;
const book = Array.from({ length: 118 }, (_, i) => ({ get ticker() { membershipReads++; return `COMP${i}`; } }));
const manyRows = Array.from({ length: 55000 }, (_, i) => ({ ticker: `COMP${i % 118}` }));
assert.equal(scope.filterByScope(manyRows, 'portfolio', book).length, manyRows.length);
assert(membershipReads <= book.length * 2, 'one holdings lookup per pass, independent of the number of records');
const emptyWatchlist = await alerts.collect({ ...options, scope: 'watchlist', load: false });
assert.equal(emptyWatchlist.events.length, 0, 'empty Watchlist never becomes Universe');
const poolSubset = universe.events.filter((e) => ['STLTECH', 'RELIANCE'].includes(e.ticker));
assert.deepEqual(portfolio.events.filter((e) => !e.portfolioOnly).map((e) => e.id).sort(), poolSubset.map((e) => e.id).sort(), 'Portfolio is an exact view of every market-wide source');
assert.equal(portfolio.events.filter((e) => e.feed === 'screener-portfolio-upcoming').length, 2, 'the exact S Screen calendar includes tickered and BSE-only portfolio companies');
assert.equal(portfolio.feeds.find((f) => f.id === 'screener-portfolio-upcoming').scopable, true);
watchlist.toggle('STLTECH', 'Sterlite Technologies');
const watched = await alerts.collect({ ...options, scope: 'watchlist', load: false });
assert.deepEqual(watched.events.map((e) => e.id).sort(), universe.events.filter((e) => e.ticker === 'STLTECH').map((e) => e.id).sort());
assert.equal(calls.length, previousCalls, 'scope/filter changes require no extra fetch');
assert.equal(portfolio.feeds.find((f) => f.id === 'twitter').scopable, true, 'reviewed company mentions can now be scoped; unresolved posts still stay in Universe');
assert(portfolio.feeds.find((f) => f.id === 'nse-filings').unresolvedCount > 0, 'unresolved omissions are counted');

// A named public issuer is researchable even when the current view excludes it.
// The optional research request must not mutate the view or broaden private calendar access.
const scopeLists = await import('../public/js/core/scope-lists.js');
const outsideCompany = { ticker: 'HEXT', name: 'Hexaware Technologies' };
const beforeRequestedCalls = calls.length;
scopeLists.remove('universe', outsideCompany, [outsideCompany]);
try {
  for (const view of ['portfolio', 'watchlist', 'universe']) {
    const ordinary = await alerts.collect({ ...options, scope: view, load: false });
    assert(!ordinary.events.some(event => event.url === outsideNseRow.url), `${view}: ordinary display exclusions remain in effect`);
    const requested = await alerts.collect({ ...options, scope: view, load: false, requestedCompanies: [outsideCompany] });
    assert(requested.events.some(event => event.url === outsideNseRow.url && event.ticker === 'HEXT'), `${view}: explicit research includes retained public evidence outside the view`);
    if (view !== 'portfolio') assert(!requested.events.some(event => event.portfolioOnly), `${view}: requested public identity cannot admit the private portfolio calendar`);
    const restored = await alerts.collect({ ...options, scope: view, load: false });
    assert.deepEqual(restored.events.map(event => event.id).sort(), ordinary.events.map(event => event.id).sort(), 'a question does not persistently add its issuer to the active list');
  }
} finally { scopeLists.reset('universe'); }
assert.equal(calls.length, beforeRequestedCalls, 'explicit public identity expansion reuses the retained pool without starting a scrape');

const privateRow = { key: 'private-1', ticker: 'STLTECH', date: null, title: 'Private annual report', url: 'https://example.test/annual.pdf', isRead: true };
records.recordDocuments('company-documents', { rows: [privateRow, privateRow] }, { ticker: 'STLTECH', name: 'Sterlite Technologies' });
const privateReport = await alerts.collect({ ...options, scope: 'portfolio', load: false });
assert.equal(privateReport.events.filter((e) => e.private).length, 1);
assert.equal(privateReport.events.find((e) => e.private).sourceRecord.isRead, true);
assert([...storage.values()].every((value) => !String(value).includes('Private annual report')), 'private data never persists');
const durableWindow = alerts.materializePublicAlertWindow({
  day: options.day,
  feeds: [{ id: 'earnings', events: [{}], count: 1, todayCount: 1 },
    { id: 'company-documents', count: 1 }, { id: 'drhp-documents', count: 1 }],
  events: [
    { id: 'private', ticker: 'STLTECH', day: options.day, feed: 'company-documents', private: true },
    { id: 'public', ticker: 'STLTECH', day: options.day, feed: 'earnings', headline: 'Public result',
      sourceRecord: { privatePayload: true }, weightPct: 40, holdingWeightPct: 40 },
  ],
});
assert.deepEqual(durableWindow.feeds.map((feed) => feed.id), ['earnings']);
assert.deepEqual(durableWindow.events.map((event) => event.id), ['public']);
assert.doesNotMatch(JSON.stringify(durableWindow), /privatePayload|sourceRecord|weightPct|company-documents|drhp-documents/,
  'the actual durable alert serializer strips private events, source records, document feeds and holding weights');
records.clearPrivateRecords();
assert(!(await alerts.collect({ ...options, scope: 'universe', load: false })).events.some((e) => e.private));
records.recordDocuments('company-documents', { rows: [privateRow] }, { ticker: 'STLTECH' });
let releaseNse;
nseGate = new Promise((done) => { releaseNse = done; });
const partials = [];
const racing = alerts.collect({ ...options, scope: 'universe', refresh: true, onPartial: report => partials.push(report) });
for (let i = 0; i < 200 && !partials.length; i++) await new Promise((done) => setTimeout(done, 10));
assert(partials.length > 0, 'fast sources produce updates while NSE is still checking');
assert(partials.every(report => report.events.some(e => e.url === nseRow.url)), 'a slow refreshing source keeps its previous records in every partial');
assert(partials.every(report => report.feeds.find(f => f.id === 'nse-filings').status === 'pending'), 'retained records do not imply a finished refresh');
records.clearPrivateRecords(); releaseNse(); nseGate = null;
assert(!(await racing).events.some((e) => e.private), 'a public read finishing after logout cannot restore old private records');

revision++;
console.log('Checking refresh and recovery');
const refreshed = await alerts.collect({ ...options, scope: 'universe', refresh: true });
assert(refreshed.events.some((e) => e.url === 'https://example.test/new.pdf'), 'a newer NSE filing reaches the pool');
const off = alerts.onChange(() => {}); off();
revision++;
await (await import('../public/js/data/nse-filings.js')).refresh();
const otherTabUpdate = await alerts.collect({ ...options, scope: 'universe', load: false });
assert(otherTabUpdate.events.some((e) => e.url === 'https://example.test/other-tab.pdf'),
  'source changes invalidate normalized evidence even after the alerts UI unsubscribes');
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
const cachedTomorrow = await alerts.readCachedAlertWindow({ scope: 'universe', holdings: [], day: '2026-09-05' });
assert(cachedTomorrow?.events.length > 0, 'a completed public collection leaves a ready repeat-visit window');
assert(cachedTomorrow.events.every((event) => event.day >= '2026-08-23' && event.day <= '2026-09-05'),
  'the restored 14-day window is re-aged against the current IST day');
assert(cachedTomorrow.events.every((event) => !event.private && event.sourceRecord == null &&
  event.weightPct == null && event.holdingWeightPct == null), 'the restored ready view contains public alert fields only');
assert(!calls.some((url) => /api\/(combined-filings|drhp-filings|super-investors\/|company-news\/|announcements\/|insider-trades\/)/.test(url)), 'no private or per-company fanout');

// Expanding the collection pool must not quietly rewrite the existing AI prioritization policy.
const legacy = { day: options.day, scope: 'portfolio', events: [{ id: 'e', ticker: 'STLTECH', day: options.day, feed: 'earnings', headline: 'Filed result', importance: 'high', direction: 'positive' }], feeds: [{ id: 'earnings', status: 'ok', reachesToday: true }] };
const raw = records.record({ id: 'snapshot', row: {}, at: options.day, ticker: 'STLTECH', headline: 'Snapshot' });
const before = ai.rankReport(legacy).cards;
assert.deepEqual(ai.rankReport({ ...legacy, events: [...legacy.events, { ...raw, feed: 'institutions' }] }).cards, before);
const evidenceReads = calls.length;
const evidenceRefresh = await alerts.refreshSources();
assert(calls.slice(evidenceReads).includes('api/screener-insights'), 'Ask Research refresh includes company context outside the alert feed registry');
assert(evidenceRefresh.failed > 0, 'unavailable context is reported instead of treating retained inputs as fresh');
console.log(`PASS: 20 feed adapters; ${universe.events.length} retained records; scope parity, undated/upcoming, raw records, privacy, refresh/recovery and AI compatibility.`);
