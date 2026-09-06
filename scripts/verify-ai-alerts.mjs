#!/usr/bin/env node
import assert from 'node:assert/strict';
import { currentDay, relativeAge, formatDay, latestSignal, latestAlertSignal, latestAlertEvent, sortAlertCards, matchesSearch } from '../public/js/ui/ai-alert-utils.js';

assert.equal(currentDay(Date.parse('2026-09-04T18:29:59Z')), '2026-09-04');
assert.equal(currentDay(Date.parse('2026-09-04T18:30:00Z')), '2026-09-05');
assert.equal(currentDay(Date.parse('2026-12-31T18:30:00Z')), '2027-01-01');
for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
  process.env.TZ = zone;
  assert.equal(relativeAge('2026-09-04', '2026-09-04'), 'today');
  assert.equal(relativeAge('2026-09-04', '2026-09-05'), '1d');
  assert.equal(relativeAge('2026-08-31', '2026-09-04'), '4d');
  assert.equal(relativeAge('2026-12-31', '2027-01-01'), '1d');
  assert.equal(relativeAge('2024-02-28', '2024-03-01'), '2d');
  assert.equal(relativeAge('2026-09-05', '2026-09-04'), 'in 1d');
  assert.equal(formatDay('2026-09-04'), '04 Sept 2026');
}
for (const day of [null, undefined, '', '2026-02-29', '2026-09-31', 'garbage']) {
  assert.equal(relativeAge(day, '2026-09-04'), '—');
  assert.equal(formatDay(day), 'Date unavailable');
}
assert.equal(relativeAge('2026-09-04', 'bad date'), '—');
assert.equal(latestSignal([]), null);
assert.equal(latestSignal([{ day: '2026-02-29' }]), null);
const events = [
  { day: '2026-09-03', time: '16:30', headline: 'Strongest but older signal' },
  { day: '2026-09-04', time: '09:15', headline: 'Routine filing' },
  { day: '2026-09-04', time: '14:42', headline: 'Hidden fourth event: lithium supply agreement', feedLabel: 'Corporate Announcements' },
];
assert.deepEqual(latestSignal(events), { day: '2026-09-04', time: '14:42', datetime: '2026-09-04T14:42:00+05:30' });
assert.deepEqual(latestSignal([...events, { day: '2026-09-04', time: null }]), { day: '2026-09-04', time: null, datetime: '2026-09-04' });
assert.equal(latestSignal([...events, { day: '2026-09-05', time: '26:00' }]).time, null);
const card = { company: 'Mahindra & Mahindra', ticker: 'M&M', sector: 'Automobiles', insight: 'Heavy trading with selling', confluence: [{ short: 'News behind it' }], events };
for (const q of ['', '  ', 'MAHINDRA', 'm&m', 'lithium SUPPLY', 'mahindra agreement', 'corporate announcements', 'selling', 'news behind', '2026-09-04', 'automobiles']) {
  assert(matchesSearch(card, q), `matches ${q}`);
}
assert(!matchesSearch(card, 'unrelated bank'));
assert(!matchesSearch(card, 'mahindra missing-keyword'));
console.log('PASS: AI alert search, source date precision, IST rollover, invalid dates and calendar ages across timezones.');

const sorting = [
  { key: 'OLDER', score: 98, holdingWeightPct: 50, events: [{ day: '2026-09-03', time: '14:00', importance: 'high' }, { day: '2026-09-06', importance: 'low' }] },
  { key: 'NEW', score: 65, holdingWeightPct: 10, events: [{ day: '2026-09-05', time: '14:00', importance: 'high' }] },
  { key: 'NEWER', score: 64, holdingWeightPct: 2, events: [{ day: '2026-09-05', time: '15:00', importance: 'high' }] },
  { key: 'UNKNOWN', score: 99, holdingWeightPct: null, events: [{ day: 'invalid', importance: 'high' }] },
];
assert.equal(latestAlertSignal(sorting[0]).day, '2026-09-03', 'routine newer data cannot resurface an older noteworthy alert');
assert.equal(latestAlertEvent(sorting[0]).day, '2026-09-03');
const related = { day: '2026-09-06', feed: 'news', importance: 'high', aiEligible: false,
  attribution: { version: 1, status: 'related', relationships: [{ relationship: 'subsidiary of a related entity', evidenceUrl: 'https://example.test/relationship' }] } };
assert.equal(latestAlertSignal({ events: [...sorting[0].events, related] }).day, related.day, 'reviewed relationship evidence retains its actual event date');
assert.deepEqual(sortAlertCards(sorting).map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'holdings').map(c => c.key), ['OLDER', 'NEW', 'NEWER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'priority').map(c => c.key), ['UNKNOWN', 'OLDER', 'NEW', 'NEWER']);
assert.equal(sorting[0].key, 'OLDER', 'sorting is a view and does not mutate source ranking');
assert.deepEqual(sortAlertCards(sorting.map(c => ({ ...c, holdingWeightPct: null })), 'holdings').map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { rankReport, mergePartialReport, withPositionSnapshot } = await import('../public/js/data/ai-alerts.js');
const { enrichCardFromAllAlerts, indexAlertContext } = await import('../public/js/data/intelligence-graph.js');
const sizeHoldings = [
  { ticker: 'LARGE', name: 'Large holding', weightPct: 20 },
  { ticker: 'SMALL', name: 'Small holding', weightPct: 5 },
  { ticker: null, name: 'Fund with no research symbol', weightPct: 75 },
];
const feeds = ['earnings', 'announcements', 'insider'].map(id => ({ id, status: 'ok', reachesToday: true }));
const report = { day: '2026-09-04', scope: 'portfolio', feeds, events: ['LARGE', 'SMALL'].flatMap(ticker => feeds.map(({ id }) => ({
  id: `${ticker}-${id}`, ticker, company: ticker, feed: id, day: '2026-09-04', headline: `${ticker} ${id} signal`,
  importance: 'high', direction: ticker === 'SMALL' ? 'negative' : 'positive',
}))) };
const sizes = { sizes: { complete: true, basis: 'listed-market-value' }, holdings: sizeHoldings };
const bySize = rankReport(report, { holdings: sizeHoldings, positionSizes: sizes });
assert.equal(bySize.cards[0].ticker, 'LARGE');
assert.equal(bySize.cards[0].holdingWeightPct, 20, 'unmatched funds stay in the percentage denominator');
assert(bySize.cards[0].score < bySize.cards[1].score, 'size ordering leaves evidence priority intact');
const byPriority = rankReport(report, { holdings: sizeHoldings });
assert.equal(byPriority.cards[0].ticker, 'SMALL', 'public identities cannot activate size ordering');
assert(byPriority.cards.every(c => c.holdingWeightPct === null));
assert.equal(rankReport({ ...report, scope: 'universe' }, { holdings: sizeHoldings, positionSizes: sizes }).cards[0].ticker, 'SMALL');
assert.equal(rankReport(report, { holdings: sizeHoldings, positionSizes: { sizes: { complete: false } } }).cards[0].ticker, 'SMALL');
const publicIdentities = sizeHoldings.map(({ weightPct: _weightPct, ...holding }) => holding);
const byAuthenticatedPayload = rankReport(report, { holdings: publicIdentities, positionSizes: sizes });
assert.equal(byAuthenticatedPayload.cards[0].ticker, 'LARGE', 'production reads weights from the authenticated positions payload, not the public identity list');
assert.equal(byAuthenticatedPayload.cards[0].holdingWeightPct, 20);
const immediateSizes = withPositionSnapshot(byPriority, sizes);
assert.equal(immediateSizes.cards.find(c => c.ticker === 'LARGE').holdingWeightPct, 20);
assert.equal(immediateSizes.cards[0].ticker, byPriority.cards[0].ticker, 'size arrival cannot reorder the existing queue');
const exited = withPositionSnapshot(byPriority, { ...sizes, holdings: sizes.holdings.filter(h => h.ticker !== 'SMALL') });
assert(!exited.allCards.some(c => c.ticker === 'SMALL'), 'a verified exit is removed before slow feeds finish');
const identityCard = { ...byPriority.cards[0], key: 'RESOLVED', ticker: 'RESOLVED', entityId: 'isin:INE000009999' };
const identityReport = { ...byPriority, cards: [identityCard], allCards: [identityCard] };
const tickerlessSizes = { sizes: { complete: true }, holdings: [{ ticker: null, isin: 'INE000009999', name: 'Unresolved workbook symbol', weightPct: 100 }] };
assert.equal(withPositionSnapshot(identityReport, tickerlessSizes).cards[0].holdingWeightPct, 100, 'verified ISIN matching retains a held company even when Family has no ticker');
assert.equal(withPositionSnapshot(identityReport, { ...tickerlessSizes, sizes: { complete: false } }).cards[0].holdingWeightPct, null);
const resolvedEvent = { ...report.events[0], ticker: 'RESOLVED', entityId: identityCard.entityId };
assert.equal(rankReport({ ...report, events: [resolvedEvent] }, { holdings: tickerlessSizes.holdings, positionSizes: tickerlessSizes }).allCards[0].holdingWeightPct, 100, 'completed ranking uses the same ISIN aliases');
const arriving = rankReport({ ...report, events: report.events.map(e => ({ ...e, id: `new-${e.id}`, ticker: 'NEW', company: 'New signal' })) }, { holdings: [{ ticker: 'NEW' }] });
const progress = mergePartialReport(byPriority, arriving);
assert(progress.cards.some(c => c.ticker === 'NEW'), 'a new noteworthy company arrives before the slowest source settles');
assert(progress.cards.some(c => c.ticker === 'LARGE'), 'partial progress does not erase previously loaded companies');
assert.equal(mergePartialReport(byPriority, { ...byPriority, cards: [], allCards: [] }).cards.length, byPriority.cards.length);

const context = {
  id: 'LARGE-raw-filing', ticker: 'LARGE', company: 'Large holding', feed: 'announcements',
  day: '2026-09-04', headline: 'LARGE signal source document', detail: 'Underlying source record',
  kind: 'document', aiEligible: false, importance: 'low', direction: 'neutral',
};
const contextOnly = {
  id: 'CONTEXT-only', ticker: 'CONTEXT', company: 'Context only company', feed: 'announcements',
  day: '2026-09-04', headline: 'Routine source document', kind: 'document', aiEligible: false,
  importance: 'low', direction: 'neutral',
};
const routineSnapshot = {
  ...context, id: 'LARGE-routine-snapshot', feed: 'investor-positions', feedLabel: 'Investor holdings',
  headline: 'Quarterly holding disclosure snapshot', kind: 'snapshot',
};
const contextual = rankReport({ ...report, events: [...report.events, context, contextOnly, routineSnapshot], feeds: [...report.feeds, { id: 'investor-positions', status: 'ok', reachesToday: true }] }, { holdings: publicIdentities, positionSizes: sizes });
const largeBefore = byAuthenticatedPayload.cards.find((card) => card.ticker === 'LARGE');
const largeAfter = contextual.cards.find((card) => card.ticker === 'LARGE');
assert.equal(largeAfter.score, largeBefore.score, 'context contributes zero priority points');
assert.equal(largeAfter.contextEvents[0].id, context.id, 'the raw top-of-funnel record still enriches the card');
assert.equal(largeAfter.contextEvents.some((event) => event.id === routineSnapshot.id), false, 'an unrelated routine snapshot does not clutter the alert');
assert.equal(contextual.allCards.some((card) => card.ticker === 'CONTEXT'), false, 'context-only data cannot manufacture an AI alert');
assert.equal(contextual.meta.topFunnelEvents, report.events.length + 3);
const indexedReport = { ...report, events: [...report.events, context, contextOnly, routineSnapshot] };
const contextIndex = indexAlertContext(indexedReport);
for (const candidate of byAuthenticatedPayload.cards) {
  assert.deepEqual(enrichCardFromAllAlerts(candidate, indexedReport, { contextIndex }),
    enrichCardFromAllAlerts(candidate, indexedReport), 'shared ticker index preserves every selected context record and score');
}
console.log('PASS: authenticated size ordering, evidence priority preservation, full-pool zero-score context and missing-size fallback.');
