#!/usr/bin/env node
// Synthetic reads only: no production requests or collection dispatches.
import assert from 'node:assert/strict';
import { withPortfolioPublisherNews, publisherNewsDate } from '../public/js/data/portfolio-publisher-news.js';
import { createFeed } from '../public/js/data/filings.js';
import * as marketNews from '../public/js/data/market-news.js';
import { withTradingViewNews, NEWS_SNAPSHOT_POLL_MS } from '../public/js/data/tradingview-news.js';
import { portfolioNewsEntities, filterCompanyNewsByScope } from '../public/js/data/company-news-identity.js';
import { mapPortfolioDiscoveryEvents, newsSignal, dedupePublisherAlertFeeds } from '../public/js/data/daily-alerts.js';

for (const [publishedAt, expected] of [
  ['2026-09-03T18:29:59Z', '2026-09-03'], ['2026-09-03T18:30:00Z', '2026-09-04'],
  ['2026-09-30T20:00:00Z', '2026-10-01'], ['2026-12-31T18:30:00Z', '2027-01-01'],
  ['2026-09-04T00:00:00+05:30', '2026-09-04'],
]) assert.equal(publisherNewsDate({ publishedAt }), expected, `publisher fallback uses the IST calendar: ${publishedAt}`);
assert.equal(publisherNewsDate({ date: '2026-09-03', publishedAt: '2026-09-03T20:00:00Z' }), '2026-09-03', 'explicit valid source day is not rewritten');
assert.equal(publisherNewsDate({ date: '2026-02-30', publishedAt: '2026-09-03T20:00:00Z' }), '2026-09-04', 'invalid calendar date falls back to the source instant');
assert.equal(publisherNewsDate({ date: '2024-02-29' }), '2024-02-29', 'valid leap day is respected');
assert.equal(publisherNewsDate({ publishedAt: 'invalid' }), null);
assert.equal(publisherNewsDate({}), null, 'missing source date stays undated');

const unionDay = '2026-09-04', unionSource = { title: 'Company A and B enter an agreement', publisher: 'Economic Times' };
const unionRow = { id: 'company-a', ticker: 'AAA', entityId: 'isin:AAA', day: unionDay,
  url: 'https://www.example.test/story/', sourceRecord: unionSource, attribution: { status: 'confirmed' } };
const unionFeed = (id, events) => ({ id, events, count: events.length, todayCount: events.length, sourceCount: events.length });
const unionInput = [unionFeed('news', [unionRow, { ...unionRow, id: 'company-b', ticker: 'BBB', entityId: 'isin:BBB' }]),
  unionFeed('market-news', [{ ...unionRow, id: 'publisher-a', entityId: 'ticker:AAA', url: 'https://example.test/story' },
    { ...unionRow, id: 'publisher-b', ticker: 'BBB', entityId: 'isin:BBB' },
    { ...unionRow, id: 'unmatched', ticker: null, entityId: null },
    { ...unionRow, id: 'other-publisher', url: 'https://other.test/story' },
    { ...unionRow, id: 'history', url: 'https://example.test/history', day: '2026-08-01' }]),
  unionFeed('announcements', [{ ...unionRow, id: 'filing' }])];
const unionOriginal = JSON.stringify(unionInput);
const union = dedupePublisherAlertFeeds(unionInput, { day: unionDay, entities: [{ ticker: 'AAA', entityId: 'isin:AAA' }] });
assert.equal(union[0].count, 2, 'same publisher article remains attributed once to each company');
assert.equal(union[1].count, 3, 'unmatched Universe, other publisher URL and older history all survive');
assert.equal(union[1].todayCount, 2, 'display counts use the same deduplicated events as export');
assert.equal(union[1].sourceCount, 5, 'source collection count is not rewritten');
assert.equal(union[2].count, 1, 'non-news records are never collapsed with news');
assert.equal(union[0].events[0].sourceRecord, unionSource, 'preferred source evidence remains intact');
assert.deepEqual(union[0].events[0].newsProvenance.map(record => record.feed), ['news', 'market-news']);
assert.equal(JSON.stringify(unionInput), unionOriginal, 'deduplication never edits source arrays or raw records');
assert.equal(dedupePublisherAlertFeeds(union, { day: unionDay }), union, 'deduplication is idempotent');
const stronger = dedupePublisherAlertFeeds([unionFeed('news', [{ ...unionRow, attribution: { status: 'uncertain' } }]),
  unionFeed('market-news', [{ ...unionRow, id: 'confirmed-publisher' }])], { day: unionDay });
assert.equal(stronger[1].events[0].id, 'confirmed-publisher', 'stronger company evidence wins over a weaker company-search copy');
assert.equal(stronger[1].events[0].newsProvenance.length, 2);

const now = Date.now(), capturedAt = new Date(now).toISOString();
const holding = { ticker: 'KISSHT', name: 'OnEMI Technology Solutions', isin: 'INE12F801023' };
const et = { id: 'economic-times:onemi', publisher: 'Economic Times',
  title: 'JM Financial initiates coverage on OnEMI Technology with Buy call, sees 28% upside',
  url: 'https://economictimes.indiatimes.com/markets/stocks/news/jm-financial-initiates-coverage-on-onemi-technology-with-buy-call-sees-28-upside/articleshow/133755070.cms',
  publishedAt: '2026-09-04T07:18:00.000Z' };
const source = { id: 'economic-times', publisher: 'Economic Times', ok: true, feeds: 3, feedsOk: 3, capturedAt };
const listeners = new Set(), publisherListeners = new Set(), bookListeners = new Set();
let held = [holding], coreRows = [], coreLoaded = false, coreDone;
const coreGate = new Promise(resolve => { coreDone = resolve; });
const core = { rows: () => coreRows, meta: () => ({ loaded: coreLoaded, capturedAt: null }),
  seed: async () => { await coreGate; coreLoaded = true; }, load: async () => {},
  refreshSnapshot: async () => ({ available: false }), refresh: async () => ({ partial: true }),
  onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  setWanted: values => values, invalidate() {}, wasAskedEmpty: () => true };
let loaded = false, articles = [], failed = false, months = 1, incoming = null, publisherChecks = 0;
const unrelated = { title: 'Unrelated global market article', url: 'https://example.test/world' };
const publishers = { rows: () => articles, isLoaded: () => loaded,
  load: async () => { loaded = true; articles = [et, unrelated]; publisherListeners.forEach(fn => fn()); },
  refresh: async () => { publisherChecks++; if (incoming) { articles = incoming; incoming = null; } publisherListeners.forEach(fn => fn()); },
  meta: () => ({ loaded, sources: [source], capturedAt, checkedAt: now, count: articles.length, lastReadFailed: failed }),
  archiveMeta: () => ({ remaining: months }),
  loadMore: async () => { months = 0; return { failed: 0, added: 0 }; },
  onChange: fn => { publisherListeners.add(fn); return () => publisherListeners.delete(fn); } };
const book = { holdings: () => held, onChange: fn => { bookListeners.add(fn); return () => bookListeners.delete(fn); } };
const feed = withPortfolioPublisherNews(core, { publishers, book, now: () => now });
let paints = 0;
feed.onChange(() => { paints++; feed.rows(); });
const loading = feed.seed();
await new Promise(resolve => setImmediate(resolve));
assert.equal(coreLoaded, false, 'company search can still be pending');
assert.equal(feed.rows().length, 1, 'Economic Times reaches Portfolio News before the core finishes');
assert.equal(feed.rows()[0].ticker, 'KISSHT');
assert.equal(feed.rows()[0].source, 'Economic Times');
assert.equal(feed.rows()[0].date, '2026-09-04');
assert.equal(feed.rows()[0].publisherSourceRecord, et, 'raw publisher evidence is preserved');
assert(!('ticker' in et), 'projection never changes the raw market record');
assert.equal(publishers.rows().length, 2, 'unmatched records remain searchable in Universe');
assert(paints > 0);
const initial = feed.rows();
assert.equal(feed.rows(), initial, 'unchanged reads reuse the complete projection');
coreDone(); await loading;
const event = mapPortfolioDiscoveryEvents('market-news', [{ id: et.id, headline: et.title, url: et.url,
  day: '2026-09-04', sourceRecord: et }], portfolioNewsEntities(held))[0];
assert.equal(event.ticker, feed.rows()[0].ticker, 'News and All Alerts use the same reviewed matcher');
assert.equal(newsSignal(feed.rows()[0]).attribution.status, 'confirmed');
coreRows = [{ ...feed.rows()[0], discoverySource: 'global-news-search', source: 'The Economic Times' }];
assert.equal(feed.rows().length, 1, 'same company URL is not doubled across source routes');
failed = true; await feed.refreshSnapshot();
assert.equal(feed.rows().length, 1);
assert.equal(feed.meta().newsDelivery.publishers.status, 'partial', 'last-good rows cannot conceal a failed source read');
failed = false;
const arrival = { title: 'Sterlite Technologies analyst day', publisher: 'Mint', url: 'https://example.test/stl', publishedAt: capturedAt };
articles = [...articles, arrival];
held = [{ ticker: 'STLTECH', name: 'Sterlite Technologies', isin: 'INE089C01029' }];
bookListeners.forEach(fn => fn());
assert.equal(filterCompanyNewsByScope(feed.rows(), 'portfolio', held).length, 1, 'new holdings match already retained publisher news automatically');
assert.equal(filterCompanyNewsByScope(feed.rows(), 'portfolio', held)[0].ticker, 'STLTECH');
assert.equal(publishers.rows().length, 3, 'portfolio exits do not alter captured source history');

// The exact production composition has one visibility-aware timer. A News-only reader must
// receive a later publisher head without All Alerts, a manual refresh, or a second poll loop.
held = [holding];
let clock = now, timerId = 0;
const timers = new Map(), visibleListeners = new Map();
const doc = { hidden: false, addEventListener: (event, fn) => visibleListeners.set(event, fn),
  removeEventListener: event => visibleListeners.delete(event) };
const composed = withTradingViewNews(withPortfolioPublisherNews(core, { publishers, book, now: () => clock }), {
  doc, now: () => clock, schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  cancel: id => timers.delete(id), read: async () => ({ value: { capturedAt, byTicker: {}, entities: [holding],
    tradingViewCoverage: { checkedAt: capturedAt, oldestSuccessAt: capturedAt, activeCompanies: 1, plannedSymbols: 1, staleOrFailedSymbols: 0 } } }),
});
let latePaints = 0;
const unsubscribe = composed.onChange(() => { latePaints++; });
await composed.seed();
assert.equal(timers.size, 1, 'publisher delivery reuses the TradingView bulk poller');
const later = { ...et, id: 'et:later', url: 'https://example.test/later-onemi', title: 'Kissht announces new lending agreement' };
incoming = [...articles, later];
const checksBefore = publisherChecks, paintsBefore = latePaints;
const [scheduledId, tick] = [...timers][0]; timers.delete(scheduledId); clock += NEWS_SNAPSHOT_POLL_MS;
await tick.fn();
assert.equal(publisherChecks, checksBefore + 1, 'scheduled News-only check includes the publisher head');
assert(composed.rows().some(row => row.url === later.url));
assert(latePaints > paintsBefore, 'new publisher evidence notifies the mounted News view');
assert.equal(timers.size, 1, 'refresh does not multiply loops');
doc.hidden = true; visibleListeners.get('visibilitychange')();
assert.equal(timers.size, 0, 'hidden News pauses its checks');
clock += NEWS_SNAPSHOT_POLL_MS; doc.hidden = false; visibleListeners.get('visibilitychange')();
assert.equal(timers.size, 1, 'returning to News re-arms one overdue check');
unsubscribe();
assert.equal(timers.size, 0, 'unmounting the final consumer releases the timer');

// Actual shared publisher reader: concurrent archive consumers, corrected revisions, failed
// months, source-head rollover, and verified empty results retain the complete previous history.
const originalFetch = globalThis.fetch;
marketNews.invalidate();
let stamp = now, head = [unrelated], older = [et, { ...arrival, id: 'mint:stl' }], archiveBad = false;
let monthReads = 0;
const month = { month: '2026-09', file: 'market-news/2026-09.json', count: 2, inHead: 0 };
globalThis.fetch = async url => {
  if (String(url) === 'data/market-news.json') return Response.json({ capturedAt: new Date(stamp).toISOString(), sources: [source], articles: head, archive: [month], archivedCount: 2 });
  if (String(url) === 'data/market-news/2026-09.json') {
    monthReads++;
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ articles: archiveBad ? [older[0]] : older });
  }
  if (String(url) === 'data/news.json') return Response.json(corePayload);
  throw Error(`Unexpected network request: ${url}`);
};
let corePayload;
try {
  await marketNews.load();
  const archivedFeed = withPortfolioPublisherNews({ ...core, rows: () => [] }, { publishers: marketNews, book, now: () => now });
  assert.equal(archivedFeed.rows().length, 0, 'the exact OnEMI report has left the current publisher head');
  const reads = await Promise.all([marketNews.loadMore(), marketNews.loadMore()]);
  assert.equal(monthReads, 1, 'parallel consumers share one archive request');
  assert(reads.every(r => r.failed === 0));
  assert.equal(marketNews.rows().length, 3);
  assert.equal(archivedFeed.rows()[0].url, et.url, 'the retained publisher month restores the report to Portfolio News');
  stamp++; head = [];
  older = [et, { ...arrival, id: 'mint:stl', title: 'Sterlite Technologies corrected analyst day' }];
  await marketNews.refresh();
  assert.equal(marketNews.meta().lastReadFailed, false, 'a verified empty head is not a failure');
  assert.equal(marketNews.rows().length, 3, 'empty/rolling head does not retract retained stories');
  archiveBad = true;
  assert.equal((await marketNews.loadMore()).failed, 1, 'partial month cannot be mistaken for complete history');
  assert.equal(marketNews.archiveMeta().remaining, 1);
  assert.equal(marketNews.rows().length, 3);
  archiveBad = false;
  await marketNews.loadMore();
  assert(marketNews.rows().some(row => row.title === older[1].title), 'same-count monthly corrections are revalidated');
  corePayload = { capturedAt, byTicker: { KISSHT: [{ ...et, ticker: 'KISSHT', source: et.publisher }] },
    queryCoverage: { planned: 1, succeeded: 1, failed: 0 } };
  const actual = createFeed('news');
  await actual.seed();
  corePayload = { ...corePayload, capturedAt: new Date(now + 1000).toISOString(), byTicker: {}, empty: ['KISSHT'] };
  await actual.refreshSnapshot();
  assert.equal(actual.rows().length, 1, 'new empty company search cannot erase the earlier article');
  assert.equal(actual.wasAskedEmpty('KISSHT'), false, 'retained evidence is not described as no news');
  const valid = corePayload;
  corePayload = { ...valid, capturedAt: new Date(now + 24 * 3600000).toISOString(), queryCoverage: {} };
  await actual.refreshSnapshot();
  assert.equal(actual.meta().capturedAt, valid.capturedAt, 'future snapshots cannot poison the retained revision');
  assert.equal(actual.meta().newsDelivery.core.status, 'partial');
  corePayload = { ...valid, capturedAt: new Date(now + 2000).toISOString() };
  await actual.refreshSnapshot();
  assert.equal(actual.meta().newsDelivery.core.status, 'ok', 'next valid source read recovers after a rejected future revision');
  corePayload = { ...valid, queryCoverage: {} };
  await actual.refreshSnapshot();
  assert.equal(actual.meta().capturedAt, new Date(now + 2000).toISOString());
  assert.equal(actual.meta().queryCoverage.planned, 1, 'rollback metadata cannot overwrite the newer accepted source coverage');
  assert.equal(actual.meta().newsDelivery.core.status, 'partial');
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  await actual.refreshSnapshot();
  assert.equal(actual.meta().newsDelivery.core.status, 'partial');
  assert.equal(actual.rows().length, 1, 'failed core refresh preserves last-good evidence');
} finally { globalThis.fetch = originalFetch; marketNews.invalidate(); }
console.log('PASS publisher delivery: independent ET head, exact shared attribution, raw retention, company URL dedupe, portfolio changes, concurrent archives, corrections, empty/failing refreshes and truthful status.');
