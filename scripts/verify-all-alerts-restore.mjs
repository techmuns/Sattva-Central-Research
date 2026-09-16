#!/usr/bin/env node
import assert from 'node:assert/strict';
import { FEEDS, adoptAllAlertsReport, alertContextKey, readCachedAllAlerts, saveAllAlerts } from '../public/js/data/daily-alerts.js';
import { materializeAllAlerts, restoreAllAlertSources, retainAlertSource, ALL_ALERTS_CACHE_KEY } from '../public/js/data/all-alerts-cache.js';
import { readEntry, writeEntry } from '../public/js/core/store.js';
import * as records from '../public/js/data/alert-records.js';
import * as watchlist from '../public/js/core/watchlist.js';

const day = '2026-09-15';
const context = { day, scope: 'universe', holdings: [{ ticker: 'AAA', name: 'Alpha Ltd' }] };
const event = (id, extra = {}) => ({ id, feed: 'nse-filings', day, ticker: 'AAA', company: 'Alpha Ltd',
  headline: id, detail: 'Original evidence', direction: 'neutral', importance: 'low', severity: 'update',
  sourceRecord: { id, original: 'Full source evidence' }, ...extra });
const source = (events, status = 'ok') => ({ ...FEEDS.find(f => f.id === 'nse-filings'), events,
  status, asOf: `${day}T07:00:00Z`, reachesToday: true });
const report = (events, status = 'ok') => adoptAllAlertsReport({ sourceFeeds: FEEDS.map(feed =>
  feed.id === 'nse-filings' ? source(events, status) : { ...feed, events: [], status: 'ok' }) }, null, context);
const old = event('history', { day: '2021-01-01', sourceRecord: { original: 'x'.repeat(600_000) } });
const unknown = event('undated', { day: null, ticker: null });
const future = event('future', { day: '2028-01-01', kind: 'scheduled' });
const original = event('correction', { headline: 'Original headline' });
const saved = report([old, unknown, future, original]);
const value = materializeAllAlerts(saved);
assert.deepEqual(value.events.map(row => row.id), [old.id, unknown.id, future.id, original.id]);
assert.equal(value.events[0].sourceRecord.original.length, 600_000, 'export evidence is never clipped to a cache part size');
assert(!value.feeds.some(feed => feed.portfolioOnly || /documents/.test(feed.id)));
assert.equal(restoreAllAlertSources({ ...value, contract: undefined }, FEEDS, day), null, 'AI cache is never treated as the complete timeline');
assert.equal(restoreAllAlertSources({ ...value, feeds: value.feeds.slice(1) }, FEEDS, day), null, 'missing source metadata rejects a partial manifest');
assert.equal(restoreAllAlertSources({ ...value, events: [...value.events, event('secret', { private: true })] }, FEEDS, day), null);
assert.equal(restoreAllAlertSources(value, FEEDS, '2026-09-14'), null, 'a future cache generation cannot be adopted');
assert(restoreAllAlertSources(value, FEEDS, '2027-01-01').every(feed => feed.reachesToday === false), 'history survives rollover without advancing its check time');

await saveAllAlerts(saved);
assert((await readEntry(ALL_ALERTS_CACHE_KEY)).value.parts.length > 1, 'the separate cache uses integrity-checked partitions');
const restored = await readCachedAllAlerts(context);
assert(restored.meta && restored.feeds.every(feed => Array.isArray(feed.events)), 'restoration has the exact report shape used by the table and Sources');
assert.deepEqual(restored.events.map(row => row.id).sort(), saved.events.map(row => row.id).sort());
assert.equal(restored.events.find(row => row.id === old.id).sourceRecord.original.length, 600_000);
assert((await readCachedAllAlerts({ ...context, scope: 'portfolio', holdings: [] })).events.length === 0, 'saved public data is scoped against the current book');

const queryWindow = { from: day, to: day, includeUndated: false };
const selected = adoptAllAlertsReport(saved, null, { ...context, queryWindow });
assert.deepEqual(selected.events.map(row => row.id), [original.id]);
await saveAllAlerts(selected);
assert.equal(restoreAllAlertSources(materializeAllAlerts(selected), FEEDS, day), null,
  'a selected-period cache never passes the full-history contract');
assert.deepEqual((await readCachedAllAlerts(context)).events.map(row => row.id).sort(), saved.events.map(row => row.id).sort(),
  'saving Today cannot overwrite older, undated or scheduled history');
assert.deepEqual((await readCachedAllAlerts({ ...context, queryWindow })).events, selected.events);
const expanding = adoptAllAlertsReport(selected, null, context);
assert(expanding.feeds.filter(feed => !feed.portfolioOnly && !/documents/.test(feed.id)).every(feed => feed.status === 'pending'),
  'expanding a successful narrow query still requires checking the remaining history');
assert.deepEqual(adoptAllAlertsReport(selected, restored, context).events.map(row => row.id).sort(), saved.events.map(row => row.id).sort(),
  'a narrower read cannot erase saved evidence while history loads');

const crossDate = { day, sourceFeeds: FEEDS.map(feed => ({ ...feed, status: 'ok', events:
  feed.id === 'news' ? [event('company-route', { feed: 'news', url: 'https://example.test/same-story',
    attribution: { status: 'confirmed' } })] : feed.id === 'market-news' ? [event('market-route', {
      feed: 'market-news', day: '2026-08-01', url: 'https://example.test/same-story', attribution: { status: 'uncertain' } })] : [] })) };
const fullCrossDate = adoptAllAlertsReport(crossDate, null, { ...context, holdings: [] });
const selectedCrossDate = adoptAllAlertsReport(crossDate, null, { ...context, holdings: [], queryWindow });
assert.deepEqual(selectedCrossDate.events, fullCrossDate.events.filter(row => row.day === day),
  'date filtering happens after canonical selection and retains cross-date source provenance');
assert.equal(selectedCrossDate.events[0].newsProvenance.length, 2);

const emptySeed = report([], 'pending');
const seeded = adoptAllAlertsReport(emptySeed, restored, context);
assert.deepEqual(seeded.events.map(row => row.id).sort(), [old.id, unknown.id, future.id, original.id].sort(),
  'an empty seed cannot displace any saved historical, undated, future or current record');
const corrected = event(original.id, { headline: 'Corrected headline', sourceRecord: { corrected: true } });
const partial = adoptAllAlertsReport(report([corrected, event('new')], 'failed'), restored, context);
assert.equal(partial.events.length, 5, 'failed partial reads retain other saved records while adding new ones');
assert.equal(partial.events.find(row => row.id === original.id).headline, corrected.headline, 'same-count/id corrections replace the older content');
assert(partial.feeds.find(feed => feed.id === 'nse-filings').status === 'failed');
const complete = report([corrected]);
assert.deepEqual(adoptAllAlertsReport(complete, restored, context).events, complete.events, 'a late disk read cannot roll back a completed source');
assert.equal(adoptAllAlertsReport(report([]), restored, context).events.length, 0, 'an authoritative empty source clears its prior contribution');
assert.equal(retainAlertSource(source([], 'on-demand'), source([old])).events[0], old, 'an unrequested source cannot erase a previously read public record');
assert.equal(retainAlertSource({ ...source([]), asOf: '2026-01-01T00:00:00Z' }, source([old])).events[0], old, 'a readable but older capture cannot retract newer saved evidence');
const olderRead = { ...source([]), asOf: '2026-01-01T00:00:00Z' };
assert.equal(retainAlertSource(olderRead, retainAlertSource(olderRead, source([old]))).events[0], old, 'repeating the older read cannot lower the retained generation and erase it on the next pass');
assert.equal(adoptAllAlertsReport(complete, null, { ...context, day: '2026-09-16' }).feeds.find(f => f.id === 'nse-filings').reachesToday, false);
const duplicateGroup = [event('shared', { headline: 'One' }), event('shared', { headline: 'Two' })];
assert.equal(retainAlertSource(source(duplicateGroup, 'failed'), source([event('shared'), old])).events.length, 3, 'legitimate same-id source records survive retention');

records.recordDocuments('company-documents', { rows: [{ id: 'private', ticker: 'AAA', date: day, title: 'Private document' }] });
const withPrivate = report([old]);
assert(withPrivate.events.some(row => row.private));
assert(!JSON.stringify(materializeAllAlerts(withPrivate)).includes('Private document'));
records.clearPrivateRecords();
assert(!adoptAllAlertsReport(withPrivate, withPrivate, context).events.some(row => row.private), 'an old report cannot restore private evidence after logout, including while unmounted');

const initialKey = alertContextKey('watchlist', context.holdings, day);
watchlist.add('AAA', 'Alpha Ltd', 'Fixture');
assert.notEqual(alertContextKey('watchlist', context.holdings, day), initialKey);
const watched = adoptAllAlertsReport(saved, null, { ...context, scope: 'watchlist' });
assert(watched.events.every(row => row.ticker === 'AAA'));
assert.equal(adoptAllAlertsReport(saved, null, { ...context, scope: 'portfolio', holdings: [] }).meta.companies, 0);

let reads = 0;
const large = Array.from({ length: 33_568 }, (_, i) => event(`large-${i}`, { get ticker() { reads++; return 'AAA'; } }));
// Define the measured accessors after fixture construction, so they measure application work.
for (const row of large) Object.defineProperty(row, 'ticker', { get() { reads++; return 'AAA'; }, enumerable: true });
const initial = report(large);
reads = 0;
const unchanged = adoptAllAlertsReport(initial, null, context);
assert.equal(unchanged.events, initial.events, 'unchanged publications retain the complete immutable event model');
assert.equal(reads, 0, 'status-only assembly does not rescan unchanged source rows or derived counts');
assert.equal(unchanged.meta.companies, initial.meta.companies);

const entry = await readEntry(ALL_ALERTS_CACHE_KEY);
const first = entry.value.parts[0];
await writeEntry(`${ALL_ALERTS_CACHE_KEY}:part:${first.hash}`, { value: { json: '[]' } });
assert.equal(await readCachedAllAlerts(context), null, 'an incomplete saved copy falls back to live reads as a whole');
console.log('PASS All Alerts complete cache, partitions, source adoption, corrections, empty success, current membership, private revocation and unchanged-model work.');
