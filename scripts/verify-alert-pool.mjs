#!/usr/bin/env node
// THE PRECOMPUTED ALERT POOL IS EXACT, OR IT IS NOT USED. Built here from one full collection over
// the shipped captures (no egress), served back through the same routes the browser reads, and
// compared with the collection the browser performs without it: the same events, the same feed
// rows, the same ranking. Then every reason the pool must stand aside, one at a time.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
const now = Date.now();
Date.now = () => now;

const { offlineFetch, captureIdentities, captureStatusFor, writePoolMembers, verifyPoolMembers, jsonForm } = await import('./lib/alert-pool-build.mjs');
const { POOL_FEEDS, POOL_FEED_CAPTURES } = await import('../public/js/data/alert-pool-shared.js');
const { validateShard } = await import('../public/js/data/alert-pool-format.js');

// THE ROUTES THE BROWSER READS, answered from the pool this test builds. `served` is what a test
// step changes to make the pool disagree with the deployment in one particular way.
const outDir = mkdtempSync(join(tmpdir(), 'alert-pool-'));
const exchange = { text: readFileSync(resolve(root, 'data/exchange-deals.json'), 'utf8'), id: 4242 };
// `artifact` is what the index names; `memberArtifact` is the build the member route can still
// answer for — they part in section 5, where the index names a build whose members are gone.
const served = { index: null, status: null, artifact: 4242001, memberArtifact: 4242001, requests: [], liveNews: null };
const captureFetch = offlineFetch({ root, exchange, onRequest: (path) => served.requests.push(path) });
globalThis.fetch = async (input, init) => {
  const path = String(input).split('?')[0];
  if (path === 'api/alert-pool/index') {
    if (!served.index) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(JSON.stringify({ ...served.index, artifact: served.artifact }), { headers: { 'content-type': 'application/json' } });
  }
  const member = /^api\/alert-pool\/(\d+)\/(.+)$/.exec(path);
  if (member) {
    served.requests.push(path);
    if (Number(member[1]) !== served.memberArtifact) return new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } });
    try { return new Response(gunzipSync(readFileSync(join(outDir, member[2]))), { headers: { 'content-type': 'application/json' } }); }
    catch { return new Response('{"ok":false}', { status: 404, headers: { 'content-type': 'application/json' } }); }
  }
  if (path.startsWith('api/news') && served.liveNews) {
    return new Response(JSON.stringify(served.liveNews), { headers: { 'content-type': 'application/json' } });
  }
  if (path === 'api/capture-status') {
    if (!served.status) return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(served.status), { headers: { 'content-type': 'application/json' } });
  }
  return captureFetch(input, init);
};

const coverage = await import('../public/js/data/coverage.js');
coverage.prime(JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'), 'utf8')));
const alerts = await import('../public/js/data/daily-alerts.js');
const alertPool = await import('../public/js/data/alert-pool.js');
const { news } = await import('../public/js/data/filings.js');
const { publicAlertFeed } = await import('../public/js/data/all-alerts-cache.js');
const { rankReport, clearRankingCache } = await import('../public/js/data/ai-alerts.js');
const { writeEntry, deleteEntry, KEYS } = await import('../public/js/core/store.js');

const day = alerts.today();
const window = (days) => ({ from: new Date(Date.parse(day) - (days - 1) * 86400000).toISOString().slice(0, 10), to: day, includeUndated: false });
const shortEvent = (event) => ({ id: event.id, feed: event.feed, day: event.day, headline: event.headline });

// 1. THE ORACLE: the full-history collection the browser performs without any pool.
console.log(`collecting the full history for ${day} (the oracle)`);
const full = await alerts.collect({ scope: 'universe', day, includeHistory: true });
const sourceFeeds = full.sourceFeeds.filter(publicAlertFeed);
assert(full.feeds.find((feed) => feed.id === 'news').count > 0, 'the oracle must actually load retained news');
const index = writePoolMembers({ outDir, sourceFeeds, day, now, book: coverage.holdings(), newsMeta: news.meta(), captures: captureIdentities({ root, exchange }) });
verifyPoolMembers({ outDir, sourceFeeds, index });
console.log(`PASS the pool's members carry exactly the collector's events (${index.days.length} day shards, ${index.ai.length} AI shards)`);

// WHAT DOES NOT SURVIVE JSON, AND WHERE. A pooled event is the collector's event in JSON form;
// the only difference between that and the live object must be a technicals rule function or
// the technicals source-field Set — never a field a surface reads. A key holding `undefined`
// (a filing with no date, say) is absent in JSON and reads as undefined either way.
function nonJsonPaths(value, path = '', out = []) {
  if (typeof value === 'function' || value instanceof Set || value instanceof Map || value instanceof Date) out.push(path);
  else if (Array.isArray(value)) value.forEach((item, i) => nonJsonPaths(item, `${path}[]`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) nonJsonPaths(item, `${path}.${key}`, out);
  return out;
}
const lossy = new Set();
for (const feed of sourceFeeds) if (POOL_FEEDS.includes(feed.id)) for (const event of feed.events) for (const path of nonJsonPaths(event)) lossy.add(`${feed.id}${path}`);
assert.deepEqual([...lossy].sort(), ['technicals.sourceRecord._source_tech_fields', 'technicals.sourceRecord.breakdown[].fn'].filter((p) => lossy.has(p)),
  `only the technicals rule functions and source-field set are outside JSON: ${[...lossy].join(', ')}`);
console.log('PASS every pooled field survives the pool except the technicals rule functions and field set, which no surface reads');

served.index = index;
served.status = captureStatusFor({ root, exchange });

// 2. SELECTED PERIODS FROM THE POOL EQUAL THE FULL HISTORY NARROWED TO THEM — identities, every
// field, provenance and order — and no capture file is downloaded to get there.
for (const [label, queryWindow] of [['Today', window(1)], ['Last 3 days', window(3)], ['Last 7 days', window(7)], ['Last 30 days', window(30)]]) {
  served.requests = [];
  const pooled = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow, pool: 'window' });
  const status = alertPool.status();
  assert.deepEqual(Object.fromEntries(POOL_FEEDS.map((id) => [id, status.feeds[id]?.pooled])), Object.fromEntries(POOL_FEEDS.map((id) => [id, true])), `${label}: every pooled feed came from the pool (${JSON.stringify(status.feeds)})`);
  const expected = full.events.filter((event) => alerts.inAlertQuery(event, queryWindow));
  assert.deepEqual(pooled.events.map(shortEvent), expected.map(shortEvent), `${label}: the same events in the same order`);
  assert.deepEqual(jsonForm(pooled.events), jsonForm(expected), `${label}: every field, reason and provenance`);
  const dataReads = served.requests.filter((path) => /^data\/(news|insider-trades|corp-announcements|technicals|market-news)\.json$/.test(path));
  assert.deepEqual(dataReads, [], `${label}: no pooled capture is downloaded (${dataReads.join(', ')})`);
  console.log(`PASS ${label}: ${pooled.events.length} events from the pool equal the full history narrowed to the period`);
}

// THE FEED ROWS AND EVERY COUNT, against the full history narrowed by the assembly itself — the
// same code path a period takes over settled sources — in both scopes. The bounded live read is
// the reference for the fields that describe the sources (status, capture time, note, freshness);
// its own row counts can differ by a companion at a window edge, which is its behaviour, not the
// pool's, and verify-news-working-set.mjs owns that comparison.
const week = window(7);
const COUNTS = ['count', 'todayCount', 'sourceCount', 'unresolvedCount', 'oldestDay', 'newestDay'];
const describe = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'events' && !COUNTS.includes(key)));
const figures = (row) => Object.fromEntries(COUNTS.filter((key) => key in row).map((key) => [key, row[key]]));
alertPool.resetForTest();
let live = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week });
for (const scope of ['universe', 'portfolio']) {
  const holdings = coverage.holdings();
  const fromPool = await alerts.collect({ scope, day, holdings, includeHistory: true, queryWindow: week, pool: 'window' });
  const narrowed = alerts.assemble({ day, scope, holdings, includeHistory: true, queryWindow: week, settledFeeds: new Map(full.sourceFeeds.map((feed) => [feed.id, feed])) });
  assert.deepEqual(jsonForm(fromPool.events), jsonForm(narrowed.events), `${scope}: the period's events`);
  assert.deepEqual(jsonForm(fromPool.feeds.map(describe)), jsonForm(narrowed.feeds.map(describe)), `${scope}: the feed rows describe their sources as the full read does`);
  assert.deepEqual(jsonForm(fromPool.feeds.map(figures)).map((f) => ({ count: f.count, todayCount: f.todayCount, sourceCount: f.sourceCount, unresolvedCount: f.unresolvedCount })),
    jsonForm(narrowed.feeds.map(figures)).map((f) => ({ count: f.count, todayCount: f.todayCount, sourceCount: f.sourceCount, unresolvedCount: f.unresolvedCount })), `${scope}: every count`);
  for (const row of fromPool.sourceFeeds.filter((feed) => POOL_FEEDS.includes(feed.id))) {
    const days = row.events.map((event) => event.day).filter(Boolean).sort();
    assert.equal(row.oldestDay, days[0] || null, `${scope}: ${row.id} oldestDay is the oldest day it carries`);
    assert.equal(row.newestDay, days.at(-1) || null, `${scope}: ${row.id} newestDay is the newest day it carries`);
    assert.equal(row.count, row.events.length, `${scope}: ${row.id} counts what it carries`);
  }
  const liveRows = scope === 'universe' ? live : await alerts.collect({ scope, day, holdings, includeHistory: true, queryWindow: week });
  assert.deepEqual(jsonForm(fromPool.feeds.map(describe)), jsonForm(liveRows.feeds.map(describe)), `${scope}: status, capture time, note and freshness are the live read's`);
  const { sourceRecords, unresolvedRecords, ...meta } = fromPool.meta;
  const { sourceRecords: s2, unresolvedRecords: u2, ...expectedMeta } = narrowed.meta;
  assert.deepEqual(meta, expectedMeta, `${scope}: the counts and freshness figures`);
  assert.equal(sourceRecords, s2, `${scope}: source records counted`);
}
console.log('PASS Last 7 days from the pool: the full history narrowed, every row, count and figure, in both scopes');
// The bounded live read has served its purpose; the narrowed full history is the reference below.
live = null;
alertPool.resetForTest();

// 3. THE RANKING FROM THE AI POOL IS THE RANKING FROM THE FULL HISTORY. `topFunnelEvents` is the
// count of events read, and the AI pool deliberately reads fewer; every card, score, evidence row,
// context row and market-wide count is the same. Two things are compared on purpose rather than
// whole: the report's feed rows count what the ranking READ (the AI tab reads `status` off them
// and prints no count), so they are compared on the fields that describe the source, as the
// period's rows are above — and under a narrowed scope `build()` ends the note with how many
// of those events carry no ticker, a count of the same kind, so that clause is set aside too;
// and a pooled
// event travels without its `sourceRecord` unless the ranking reads it (`compactAiEvent`), with a
// notebook snapshot fetching the record from the day shard — section 7 — so the records are
// stripped from both sides and every other field on every card is compared. Cards are compared
// one at a time: the JSON form of a whole ranking, every event on it, is what does not fit in
// memory beside the full history it is being compared with.
const withoutRecords = (value) => JSON.parse(JSON.stringify(value, (key, held) => (key === 'sourceRecord' ? undefined : held)));
const UNRESOLVED_CLAUSE = /\s*\d+ records have no resolved ticker and are available in Universe only\./g;
const describeRanked = (row) => { const out = describe(row); if (typeof out.note === 'string') out.note = out.note.replace(UNRESOLVED_CLAUSE, '') || null; return out; };
const cardName = (card) => card.ticker || card.entityId || card.key || card.company;
for (const scope of ['universe', 'portfolio']) {
  const holdings = coverage.holdings();
  const ai = await alerts.collect({ scope, day, holdings, includeHistory: true, pool: 'ai' });
  const status = alertPool.status();
  assert(POOL_FEEDS.every((id) => status.feeds[id]?.pooled), `${scope}: every pooled feed came from the AI pool (${JSON.stringify(status.feeds)})`);
  const reference = scope === 'universe' ? full : alerts.assemble({ day, scope, holdings, includeHistory: true, settledFeeds: new Map(full.sourceFeeds.map((feed) => [feed.id, feed])) });
  const rankedPool = rankReport(ai, { holdings, insightCompanies: [] });
  const rankedFull = rankReport(reference, { holdings, insightCompanies: [] });
  assert(rankedFull.cards.length > 0, `${scope}: the reference ranking surfaces cards`);
  const { topFunnelEvents: readFromPool, ...metaPool } = rankedPool.meta;
  const { topFunnelEvents: readFromFull, ...metaFull } = rankedFull.meta;
  assert.deepEqual(jsonForm(metaPool), jsonForm(metaFull), `${scope}: every figure of the ranking but the count of events read`);
  assert.deepEqual([rankedPool.day, rankedPool.scope, rankedPool.pending], [rankedFull.day, rankedFull.scope, rankedFull.pending], `${scope}: the same day, scope and pending count`);
  assert.deepEqual(jsonForm(rankedPool.feeds.map(describeRanked)), jsonForm(rankedFull.feeds.map(describeRanked)), `${scope}: the feed rows describe their sources as the full read does`);
  assert.deepEqual(rankedPool.cards.map(cardName), rankedFull.cards.map(cardName), `${scope}: the surfaced companies, in the same order`);
  assert.deepEqual(rankedPool.allCards.map(cardName), rankedFull.allCards.map(cardName), `${scope}: every ranked company, in the same order`);
  for (let i = 0; i < rankedFull.allCards.length; i++) {
    assert.deepEqual(withoutRecords(rankedPool.allCards[i]), withoutRecords(rankedFull.allCards[i]), `${scope}: card ${i + 1} (${cardName(rankedFull.allCards[i])}) — score, evidence, context, drivers and figures`);
  }
  assert(readFromPool < readFromFull, `${scope}: the AI pool reads fewer events than the full history (${readFromPool} vs ${readFromFull})`);
  assert(ai.events.some((event) => POOL_FEEDS.includes(event.feed) && event.feed !== 'market-news' && event.sourceRecord == null), `${scope}: pooled AI events travel compact`);
  console.log(`PASS ${scope}: ${rankedPool.cards.length} cards ranked identically from ${readFromPool} pooled events instead of ${readFromFull}`);
  clearRankingCache();
}
alertPool.resetForTest();
// THE NARROWED WEEK is the reference for the fallbacks below — the full history assembled to the
// period, the same code path a period takes over settled sources. It is built here, after the
// ranking, so that it is not held beside two rankings and the AI pool.
const narrowedWeek = alerts.assemble({ day, scope: 'universe', holdings: coverage.holdings(), includeHistory: true, queryWindow: week, settledFeeds: new Map(full.sourceFeeds.map((feed) => [feed.id, feed])) });

// 4. EVERY REASON THE POOL STANDS ASIDE. Each one is checked on the read itself, and each leaves
// the collection to the live path for that feed — the same records, read the way they always were.
const { news: newsFeed, insider: insiderFeed } = await import('../public/js/data/filings.js');
const sessionRowsOf = (id) => ((id === 'news' ? newsFeed : id === 'insider' ? insiderFeed : null)?.holdsSessionRows() ? 'rows read live in this session' : null);
const declineReasons = async (options = {}) => {
  alertPool.resetForTest();
  const read = await alertPool.read({ mode: 'window', day, queryWindow: window(1), book: coverage.holdings(), newsState: (meta) => alerts.companyNewsState(day, meta), sessionRows: sessionRowsOf, ...options });
  return read ? Object.fromEntries([...read.declined]) : null;
};
assert.deepEqual(await declineReasons(), {}, 'a current pool declines nothing');
served.status = { ...served.status, captures: { ...served.status.captures, insider: { ...served.status.captures.insider, revision: 'moved' } } };
assert.deepEqual(await declineReasons(), { insider: 'insider: moved' }, 'a capture that moved sends only its feed down the live path');
{
  const pooled = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week, pool: 'window' });
  assert.deepEqual(jsonForm(pooled.events), jsonForm(narrowedWeek.events), 'a declined feed read live still yields the same period');
  assert.equal(alertPool.status().feeds.insider.pooled, false);
}
served.status = captureStatusFor({ root, exchange });
served.status.captures.exchangeDeals = { ok: true, capturedAt: null, artifactId: 4243 };
assert.deepEqual(await declineReasons(), { insider: 'exchangeDeals: moved' }, 'a newer bulk/block artifact than the pool folded in declines the insider feed');
served.status = captureStatusFor({ root, exchange });
delete served.status.captures.tradingviewNews;
assert.deepEqual(await declineReasons(), { news: 'tradingviewNews: not reported' }, 'a capture the deployment does not report cannot be verified');
served.status = captureStatusFor({ root, exchange });
served.status.captures.exchangeDeals = { ok: false, capturedAt: null, artifactId: null, reason: 'not-cached' };
assert.deepEqual(await declineReasons(), { insider: 'exchangeDeals: not reported' }, 'an exchange artifact the Worker has not served yet cannot be verified');
served.status = captureStatusFor({ root, exchange });
served.index = { ...index, day: '2020-01-01' };
assert.equal(await declineReasons(), null, 'a pool built for another day is not used at all');
served.index = index;
served.status = null;
assert.equal(await declineReasons(), null, 'without capture status nothing can be verified, so nothing is pooled');
served.status = captureStatusFor({ root, exchange });
served.index = null;
assert.equal(await declineReasons(), null, 'a deployment without a pool (no Worker, no build) is the live path');
served.index = index;
assert.equal(await declineReasons({ queryWindow: { from: '2020-01-01', to: day, includeUndated: false } }), null, 'a period before the pool is not pooled');
assert.equal(await declineReasons({ queryWindow: { ...window(1), includeUndated: true } }), null, 'undated records are never answered from the pool');
assert.equal(await declineReasons({ day: '2020-01-01' }), null, 'a reader on another day than the pool takes the live path');
// A PER-COMPANY ENTRY LEFT IN THE DEVICE STORE BY AN EARLIER VISIT DECLINES NOTHING. A reader
// seeded with no company list never reads it, so a collection made now would not see it either;
// declining on its presence is what kept a browser that had once pressed Refresh on News on the
// live news path for good. Rows this session actually holds are the last section of this file.
await writeEntry(KEYS.filingRow('news', 'RELIANCE'), { tag: null, value: { rows: [] } });
await writeEntry(KEYS.filingRow('insider', 'RELIANCE'), { tag: null, value: { rows: [] } });
assert.deepEqual(await declineReasons(), {}, 'per-company device entries from an earlier visit decline nothing');
assert.deepEqual(await declineReasons({ sessionRows: (id) => (id === 'news' ? 'rows read live in this session' : null) }), { news: 'rows read live in this session' }, 'a feed module holding session rows declines its feed');
await deleteEntry(KEYS.filingRow('news', 'RELIANCE'));
await deleteEntry(KEYS.filingRow('insider', 'RELIANCE'));
await writeEntry(KEYS.announcementLookups, { tag: null, value: { rows: [{ id: 1 }], queries: [] } });
assert.deepEqual(await declineReasons(), { announcements: 'announcement lookups on this device' });
await deleteEntry(KEYS.announcementLookups);
served.index = { ...index, feeds: { ...index.feeds, news: { ...index.feeds.news, bookDependent: true } }, bookSignature: 'another book' };
assert.deepEqual(await declineReasons(), { news: 'built under another book' }, 'a book-dependent news pool built under another book is declined');
served.index = index;
assert.deepEqual(await declineReasons(), {}, 'and the current pool is adopted again');
console.log('PASS every reason the pool stands aside is checked on the read, per feed, and leaves that feed to the live path');

// 5. A SHARD THAT DOES NOT READ IS THE POOL FAILING, NOT A FEED'S ANSWER. The index names a build
// whose members the route no longer answers for — an artifact expired between the two reads —
// so every feed takes the live path this time and the period is still exact.
served.artifact = 9;
served.index = { ...index };
{
  alertPool.resetForTest();
  const pooled = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week, pool: 'window' });
  assert(POOL_FEEDS.every((id) => !alertPool.status().feeds[id]?.pooled), 'no feed is reported as pooled when the members could not be read');
  // The reference here is the bounded live read itself, not the full history narrowed: with no
  // feed pooled this IS a bounded live read, and that read can carry one more URL companion at a
  // window edge than the narrowing does (section 2 says so, and verify-news-working-set.mjs owns
  // that comparison). What is asserted is that nothing about the failed pool changed the answer.
  const liveWeek = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week });
  assert.deepEqual(jsonForm(pooled.events), jsonForm(liveWeek.events), 'unreadable members leave the whole period to the live path, event for event');
  assert.deepEqual(jsonForm(pooled.feeds.map(describe)), jsonForm(liveWeek.feeds.map(describe)), 'and the feed rows are the live read\'s');
}
served.artifact = 4242001;
// A shard that does not have the contract's shape is refused before any event is read.
assert.throws(() => validateShard({ version: 1, contract: 'alert-pool-v1', day, feeds: { technicals: { events: [{ id: 'x', feed: 'technicals', headline: 'h', private: true }], order: [0] } } }), /invalid technicals event/);
assert.throws(() => validateShard({ version: 1, contract: 'alert-pool-v1', day, feeds: { 'company-documents': { events: [], order: [] } } }), /invalid company-documents group/);
console.log('PASS unreadable members and invalid shards leave the collection to the live path; private feeds cannot enter a shard');

// 6. A REASSEMBLY WITHOUT LOADING REUSES THE LAST POOL READ; A REFRESH READS THE INDEX AGAIN.
alertPool.resetForTest();
await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week, pool: 'window' });
served.requests = [];
const reassembled = await alerts.collect({ scope: 'universe', day, includeHistory: true, queryWindow: week, pool: 'window', load: false });
assert.deepEqual(jsonForm(reassembled.events), jsonForm(narrowedWeek.events), 'a reassembly without loading yields the same period');
assert.deepEqual(served.requests.filter((path) => path.startsWith('api/alert-pool/')), [], 'a reassembly reads no member');
console.log('PASS a reassembly without loading reuses the pool read in memory');

// 7. A BOOKMARK TAKEN FROM A COMPACT EVENT REACHES THE FULL SOURCE RECORD IN THE DAY SHARD.
{
  const ai = await alerts.collect({ scope: 'universe', day, includeHistory: true, pool: 'ai' });
  const compact = ai.sourceFeeds.find((feed) => feed.id === 'insider').events.find((event) => event.day && index.days.some((entry) => entry.day === event.day));
  assert(compact && alertPool.needsFullRecord(compact), 'an insider event from the AI pool travels without its record');
  const record = await alertPool.fullRecord(compact);
  const original = full.sourceFeeds.find((feed) => feed.id === 'insider').events.find((event) => event.id === compact.id);
  assert.deepEqual(record, jsonForm(original.sourceRecord), 'the record comes back from the day shard exactly');
  const marketWide = ai.sourceFeeds.find((feed) => feed.id === 'market-news').events[0];
  assert(!marketWide || !alertPool.needsFullRecord(marketWide), 'a market-wide story keeps its record in the AI pool');
}
console.log('PASS a compact event resolves its full source record from the pool for a notebook snapshot');

// 8. ROWS THIS SESSION HOLDS BEYOND THE CAPTURE DO DECLINE — through the feed modules themselves,
// last because they cannot be taken back. A device copy that a tab loads for a company (a
// filings-tab `load(items)` seeds the device rows for its wanted companies) is a row the pool
// cannot carry; so is a live news search, whose rows every news reader adopts.
{
  const ticker = coverage.holdings().find((h) => h.ticker)?.ticker || 'RELIANCE';
  assert.equal(insiderFeed.holdsSessionRows(), false, 'the insider reader holds only the capture before any tab loads it');
  await writeEntry(KEYS.filingRow('insider', ticker), { tag: null, value: { rows: [] } });
  insiderFeed.invalidate(); insiderFeed.setWanted([ticker]); await insiderFeed.seed();
  assert.equal(insiderFeed.holdsSessionRows(), true, 'a device copy a tab loaded is a session row');
  assert.deepEqual(await declineReasons(), { insider: 'rows read live in this session' }, 'the collector\'s own question declines the insider feed');
  await deleteEntry(KEYS.filingRow('insider', ticker));
  // A reload puts the reader back on the capture alone; here, the same thing in place.
  insiderFeed.invalidate(); await insiderFeed.seed();
  assert.equal(insiderFeed.holdsSessionRows(), false, 'seeded again with no company list, the insider reader is back on the capture alone');
  assert.equal(newsFeed.holdsSessionRows(), false, 'the news reader holds only the capture before any live search');
  served.liveNews = { articles: [{ title: 'A story only this session searched for', url: 'https://example.com/only-here', date: day, source: 'Example', summary: 'Live search result.' }] };
  // `load()` memoises: the reader was loaded by the oracle. `loadOne(…, { force })` is the live
  // read a Refresh makes for one company, and it is answered by the fixture above.
  await newsFeed.loadOne(ticker, { force: true });
  assert.equal(newsFeed.holdsSessionRows(), true, 'a live search this session is a session row');
  assert.deepEqual(await declineReasons(), { news: 'rows read live in this session' }, 'and declines the news feed');
  console.log('PASS rows this session read live decline their feed, through the feed modules; device entries alone do not');
}
rmSync(outDir, { recursive: true, force: true });
console.log('PASS alert pool: exact selected periods, exact ranking, honest fallbacks.');
