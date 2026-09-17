#!/usr/bin/env node
// The per-row and per-string caches added to the alert/filings hot paths must be invisible:
// same answers as a fresh computation, live reads of an edited value where the cache promises
// one, and shared results that stay correct. Pure Node, no egress, no browser.
import assert from 'node:assert/strict';
import { pickField } from '../public/js/data/filings-shared.js';
import { insiderTradeIdentity, mergeInsiderTrades, withTradeCategory, INSIDER_TRADE_CATEGORY } from '../public/js/data/insider-history.js';
import { newsDay, newsPublicationDay, newsPeriodBounds, matchesNewsPeriod } from '../public/js/data/news-window.js';
import { attributionFor, companyNewsAttribution, attributeNewsRow } from '../public/js/data/company-news-attribution.js';
import { classifyStory } from '../public/js/data/news-keywords.js';
import { newsEventTopics } from '../public/js/data/portfolio-news-matching.js';
import { createAlertWindowCache, utf8Length } from '../public/js/data/alert-window-cache.js';
import { articleUrlKey, canonicalArticleUrl, dedupeArticles } from '../public/js/data/filings-shared.js';
import { announcementEvent, insiderEvent, warmRows, mapPortfolioDiscoveryEvents } from '../public/js/data/daily-alerts.js';
import { nseRecord } from '../public/js/data/alert-sources.js';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';

// --- pickField: the object's shape is cached, its values are read live -------------------------
const cells = { 'Trade Shares': '1,20,000', Exchange: 'NSE', trade_shares: '5', Mode: '-', Price: '' };
const reference = (obj, names) => { // the pre-cache implementation, kept here as the oracle
  const flat = new Map();
  for (const [k, v] of Object.entries(obj)) flat.set(String(k).toLowerCase().replace(/[^a-z0-9]/g, ''), v);
  for (const n of names) { const v = flat.get(String(n).toLowerCase().replace(/[^a-z0-9]/g, '')); if (v != null && v !== '' && v !== '-' && v !== 'N/A') return v; }
  return null;
};
const NAMES = ['trade shares', 'shares'];
for (const names of [NAMES, ['mode', 'exchange'], ['price', 'exchange'], ['missing'], ['TRADE-SHARES']]) {
  assert.equal(pickField(cells, names), reference(cells, names), `pickField ${names.join(',')}`);
  assert.equal(pickField(cells, names), reference(cells, names), 'second read hits the shape cache and agrees');
}
assert.equal(pickField(cells, NAMES), '5', 'a later key spelling the same normalised name still wins, as before');
cells.Exchange = 'BSE';
assert.equal(pickField(cells, ['exchange']), 'BSE', 'a value edited in place is read live through the cached shape');
assert.equal(pickField(null, NAMES), null); assert.equal(pickField('text', NAMES), null);
assert.equal(pickField({ a: 1 }, new Set(['a'])), 1, 'iterable candidate lists still work');

// --- insider identity: same content, same key; cached per object; category rows are shared ------
const trade = (name, extra = {}) => ({ ticker: 'TEST', date: '2026-09-10', cells: { Insider: name, Transaction: 'Acquisition', 'Trade Shares': '100', Source: 'NSE', ...extra } });
const a = trade('Alice'), a2 = trade('Alice'), b = trade('Bob');
assert.equal(insiderTradeIdentity(a), insiderTradeIdentity(a2), 'structurally equal rows share an identity');
assert.notEqual(insiderTradeIdentity(a), insiderTradeIdentity(b));
assert.equal(insiderTradeIdentity(a), insiderTradeIdentity(a), 'a repeated read of the same object is stable');
assert.equal(insiderTradeIdentity({ ...a, cells: { ...a.cells, 'Trade Category': INSIDER_TRADE_CATEGORY } }), insiderTradeIdentity(a),
  'the implicit category and an explicit one are the same event');
const categorised = trade('Cara', { 'Trade Category': 'Bulk deal' });
assert.equal(withTradeCategory(categorised), categorised, 'a row that already carries its category is returned as is');
const legacy = trade('Lee');
const promoted = withTradeCategory(legacy);
assert.notEqual(promoted, legacy, 'a legacy row is copied, never edited in place');
assert.equal(legacy.cells['Trade Category'], undefined);
assert.equal(promoted.cells['Trade Category'], INSIDER_TRADE_CATEGORY);
assert.equal(withTradeCategory(legacy), promoted, 'the same legacy row promotes to the same object, so a reading kept on it survives the next merge');
const frozen = Object.freeze({ ...a, cells: Object.freeze({ ...a.cells, 'Trade Category': 'Insider trade' }) });
const merged = mergeInsiderTrades([frozen], [trade('Alice', { 'Trade Category': 'Insider trade' })]);
assert.equal(merged.length, 1, 'a frozen capture row still merges with its duplicate');
assert.deepEqual(mergeInsiderTrades(merged, merged), merged, 'merging is idempotent through the identity cache');

// --- news days: exact at the IST boundary, per-minute and per-string caches -------------------
assert.equal(newsDay('2026-08-31T18:29:59Z'), '2026-08-31'); assert.equal(newsDay('2026-08-31T18:30:00Z'), '2026-09-01');
assert.equal(newsDay(Date.parse('2026-08-31T18:29:59Z')), '2026-08-31');
assert.equal(newsDay(Date.parse('2026-08-31T18:30:00Z')), '2026-09-01', 'the per-minute cache never straddles IST midnight');
assert.equal(newsDay(Date.parse('2026-08-31T18:29:01Z')), '2026-08-31', 'a second instant in an earlier minute is not served the later day');
assert.equal(newsDay('not a date'), null); assert.equal(newsDay(NaN), null);
const row = { date: '2026-09-03', publishedAt: '2026-09-03T20:00:00Z' };
assert.equal(newsPublicationDay(row), '2026-09-03');
row.date = '2026-02-30';
assert.equal(newsPublicationDay(row), '2026-09-04', 'an edited date invalidates the cached publication day');
delete row.publishedAt;
assert.equal(newsPublicationDay(row), null, 'an edited publishedAt invalidates it too');
const now = Date.parse('2026-09-08T04:30:00Z');
const bounds = newsPeriodBounds('7', now);
assert.equal(bounds, newsPeriodBounds('7', now), 'one bounds object per period and day');
assert(Object.isFrozen(bounds), 'the shared bounds object cannot be edited by a caller');
assert.deepEqual({ ...bounds }, { from: '2026-09-02', to: '2026-09-08', includeUndated: false });
assert.notEqual(newsPeriodBounds('7', now + 86400000), bounds, 'the next day gets its own bounds');
assert(matchesNewsPeriod({ date: '2026-09-02' }, '7', now) && !matchesNewsPeriod({ date: '2026-09-01' }, '7', now));

// --- story readings: memoised per row object, validated on the fields they read ---------------
const story = { title: 'Board approves buyback and a large order win', summary: 'Standfirst', url: 'https://example.com/a', queryTicker: 'TEST', company: 'Test Ltd' };
const twin = { ...story };
assert.deepEqual(attributionFor(story), companyNewsAttribution(story), 'the cached attribution equals a fresh one');
assert.deepEqual(attributionFor(twin), attributionFor(story), 'structurally equal rows read the same');
assert.equal(attributionFor(story), attributionFor(story), 'a repeated read of one row is the same object');
const reading = classifyStory(story);
assert.equal(classifyStory(story), reading, 'one story reading per row object');
assert.deepEqual(classifyStory(twin).labels, reading.labels);
assert(reading.tracked && reading.labels.length >= 1, 'the fixture matches at least one tracked keyword');
story.title = 'Quarterly results: revenue up';
assert.notEqual(classifyStory(story), reading, 'an edited headline is re-read');
assert.notDeepEqual(classifyStory(story).labels, reading.labels);
assert.deepEqual(attributionFor(story), companyNewsAttribution(story), 'attribution follows the edit as well');
const topical = { title: 'Analyst day scheduled', articleBody: { provenance: 'publisher-article-body', text: 'A profit warning followed.' } };
assert.deepEqual(newsEventTopics(topical), ['Analyst / investor day', 'Business outlook / expansion']);
assert.equal(newsEventTopics(topical), newsEventTopics(topical), 'event topics are read once per row');
topical.title = 'Clarification issued';
assert.deepEqual(newsEventTopics(topical), ['Company clarification', 'Business outlook / expansion'], 'an edited headline is re-read');

// --- decorated rows: one object per (row, identity), stable while identities alternate -------
const shared = { title: 'Alpha Ltd and Beta Ltd sign a supply order', summary: '', url: 'https://example.com/shared', query: 'Alpha Ltd' };
const alpha = { ticker: 'ALPHA', name: 'Alpha Ltd' }, beta = { ticker: 'BETA', name: 'Beta Ltd' };
const underAlpha = attributeNewsRow(shared, alpha), underBeta = attributeNewsRow(shared, beta);
assert.equal(underAlpha.ticker, 'ALPHA'); assert.equal(underBeta.ticker, 'BETA');
assert.equal(attributeNewsRow(shared, alpha), underAlpha, 'the first identity still returns its own decorated row after a second one was read');
assert.equal(attributeNewsRow(shared, beta), underBeta);
assert.equal(attributeNewsRow(shared, shared), attributeNewsRow(shared, shared), 'the row-as-identity fallback is stable too');
assert.notEqual(attributeNewsRow(shared, { ...alpha }), underAlpha, 'a different identity object is a different reading');

// --- a row's canonical address: remembered on the row, read live if the url is edited ----------
const article = { url: 'https://www.example.com/story/amp/', title: 'One', source: 'Pub', date: '2026-09-10' };
assert.equal(articleUrlKey(article), canonicalArticleUrl(article.url));
assert.equal(articleUrlKey(article), 'example.com/story');
article.url = 'https://m.example.com/other';
assert.equal(articleUrlKey(article), 'example.com/other', 'an edited url is re-read');
assert.equal(articleUrlKey({}), null); assert.equal(articleUrlKey(null), null);
const dupes = [article, { ...article, url: 'https://example.com/other' }, { ...article, title: 'Third', url: 'https://example.com/third' }];
assert.deepEqual(dedupeArticles(dupes).map(r => r.url), [article.url, 'https://example.com/third'], 'dedupe still folds mobile and desktop addresses');

// --- alert cache bytes: no byte array per event, same numbers as the encoder --------------------
const encoder = new TextEncoder();
for (const text of ['plain', 'rupee ₹ and dash —', 'emoji 📈📉 pair', 'ñ ü é', JSON.stringify({ h: 'Sûrrogate 😀 pair', d: '“quoted”' }), '']) {
  assert.equal(utf8Length(text), encoder.encode(text).byteLength, `utf8Length(${JSON.stringify(text)})`);
}
assert.equal(utf8Length(JSON.stringify('lone \ud83d surrogate')), encoder.encode(JSON.stringify('lone \ud83d surrogate')).byteLength,
  'JSON.stringify escapes a lone surrogate, so the two measures agree');
const disk = new Map();
const cache = createAlertWindowCache({ cacheKey: 'fixture', partBytes: 64, read: async key => disk.get(key),
  write: async (entries, deletes = []) => { for (const k of deletes) disk.delete(k); for (const [k, v] of entries) disk.set(k, v); return { persistent: true }; } });
const events = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, headline: `₹ ${i} 📈 ${'x'.repeat(i % 7)}` }));
assert.equal((await cache.write({ events })).persistent, true);
const manifest = disk.get('fixture').value;
assert(manifest.parts.length > 1, 'the fixture spans several parts');
for (const part of manifest.parts) {
  assert.equal(encoder.encode(disk.get(`fixture:part:${part.hash}`).value.json).byteLength, part.bytes, 'every part declares its real encoded size');
}
assert.deepEqual((await cache.read()).value.events, events, 'multibyte events round-trip through the cache');

// --- one event per source row: filings, insider disclosures, NSE rows and market-wide stories ---
const filing = { newsId: 'n1', ticker: 'TEST', date: '2026-09-10', time: '10:15:00', title: 'Award of order worth Rs 120 crore',
  category: 'Company Update', subCategory: 'Award of Order / Receipt of Order', url: 'https://www.bseindia.com/x', source: 'BSE' };
const filingEvent = announcementEvent(filing);
assert.equal(announcementEvent(filing), filingEvent, 'one announcement event per row object');
assert.deepEqual(announcementEvent({ ...filing }), filingEvent, 'a structurally equal filing reads the same');
assert.equal(filingEvent.id, 'ann:n1');
const disclosure = { ticker: 'TEST', date: '2026-09-10', cells: { Company: 'Test Ltd', Insider: 'Alice', Category: 'Promoter',
  Transaction: 'Acquisition', Mode: 'Market Purchase', 'Trade Shares': '1,00,000', 'Trade Category': 'Insider trade' } };
const disclosureEvent = insiderEvent(disclosure);
assert.equal(insiderEvent(disclosure), disclosureEvent, 'one insider event per row object');
assert.deepEqual(insiderEvent({ ...disclosure, cells: { ...disclosure.cells } }), disclosureEvent, 'a structurally equal disclosure reads the same');
assert.equal(disclosureEvent.headline, 'Alice — Acquisition');
const nseRow = { ticker: 'TEST', company: 'Test Ltd', subject: 'Credit Rating', description: 'Rating reaffirmed',
  url: 'https://nsearchives.nseindia.com/x.pdf', publishedAt: '2026-09-10T04:45:00Z', receivedAt: '2026-09-10T04:46:00Z' };
const nseEvent = nseRecord(nseRow);
assert.equal(nseRecord(nseRow), nseEvent, 'one NSE record per row object');
assert.deepEqual(nseRecord({ ...nseRow }), nseEvent, 'a structurally equal NSE row reads the same');
assert.equal(nseEvent.day, '2026-09-10');

// --- warmed in slices before the synchronous read: the read then returns what the warm-up built --
const filings = Array.from({ length: 6 }, (_, i) => ({ ...filing, newsId: `w${i}` }));
const warmed = [];
await warmRows(filings, row => warmed.push(announcementEvent(row)), async () => {});
assert.equal(warmed.length, 6);
assert(filings.every((row, i) => announcementEvent(row) === warmed[i]), 'the synchronous read returns the events the warm-up built');
let yields = 0;
const touched = new Set();
await warmRows(Array.from({ length: 40 }, (_, i) => ({ i })), row => {
  if (row.i === 7) throw new Error('bad row');
  const until = performance.now() + 1;
  while (performance.now() < until);
  touched.add(row.i);
}, async () => { yields++; });
assert.equal(touched.size, 39, 'a throwing row is skipped and the rest are still warmed');
assert(yields >= 2, `a warm-up longer than one slice yields between slices (${yields} yields)`);

// --- the portfolio discovery reading is kept on the source record, not on the copy it matched ---
const book = [{ ticker: 'ALPHA', name: 'Alpha Robotics Limited', isin: 'INE000A01010' }, { ticker: 'BETA', name: 'Beta Robotics Limited', isin: 'INE000B01010' }];
const marketStory = { id: 'm1', title: 'Alpha Robotics wins a large order', url: 'https://publisher.example/alpha', publishedAt: '2026-09-10T05:00:00Z' };
const marketEvent = { id: 'mcnews:m1', sourceRecord: marketStory, headline: marketStory.title, url: marketStory.url, at: marketStory.publishedAt,
  day: '2026-09-10', ticker: null, company: 'Market-wide', direction: 'neutral', importance: 'low' };
const discovered = mapPortfolioDiscoveryEvents('market-news', [marketEvent], portfolioNewsEntities(book));
assert.equal(discovered.length, 1); assert.equal(discovered[0].ticker, 'ALPHA');
const discoveredAgain = mapPortfolioDiscoveryEvents('market-news', [marketEvent], portfolioNewsEntities(book));
assert.notEqual(discoveredAgain, discovered, 'a new events array is a new mapping');
assert.equal(discoveredAgain[0].sourceRecord, discovered[0].sourceRecord,
  'the matched row is read once per source record, whatever identity objects and events array carry it');
assert.equal(mapPortfolioDiscoveryEvents('market-news', [marketEvent], portfolioNewsEntities(book.slice(1)))[0].ticker, null,
  'a changed book is a changed reading');
// One reading per record, validated on the book: returning to the earlier book recomputes rather
// than serving the narrowed book's reading, and reads the same company again.
assert.deepEqual([discoveredAgain[0].ticker, discoveredAgain[0].entityId],
  [mapPortfolioDiscoveryEvents('market-news', [marketEvent], portfolioNewsEntities(book))[0].ticker, discovered[0].entityId]);

console.log('PASS hot-path caches are invisible: same answers, live edits, shared results, exact byte counts, one event per source row, warmed reads.');
