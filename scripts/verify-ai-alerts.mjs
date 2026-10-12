#!/usr/bin/env node
import assert from 'node:assert/strict';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
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
  attribution: { version: ATTRIBUTION_VERSION, status: 'related', relationships: [{ relationship: 'subsidiary of a related entity', evidenceUrl: 'https://example.test/relationship' }] } };
assert.equal(latestAlertSignal({ events: [...sorting[0].events, related] }).day, related.day, 'reviewed relationship evidence retains its actual event date');
assert.deepEqual(sortAlertCards(sorting).map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'holdings').map(c => c.key), ['OLDER', 'NEW', 'NEWER', 'UNKNOWN']);
assert.deepEqual(sortAlertCards(sorting, 'priority').map(c => c.key), ['UNKNOWN', 'OLDER', 'NEW', 'NEWER']);
assert.equal(sorting[0].key, 'OLDER', 'sorting is a view and does not mutate source ranking');
assert.deepEqual(sortAlertCards(sorting.map(c => ({ ...c, holdingWeightPct: null })), 'holdings').map(c => c.key), ['NEWER', 'NEW', 'OLDER', 'UNKNOWN']);

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { rankReport, mergePartialReport, withPositionSnapshot, clearRankingCache } = await import('../public/js/data/ai-alerts.js');
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
const arrivingSameCompany = rankReport({ ...report, pending: 1, events: [{ ...report.events[0],
  id: 'same-company-new', headline: 'New material export contract', feed: 'announcements' }] }, { holdings: sizeHoldings });
const mergedSameCompany = mergePartialReport(byPriority, arrivingSameCompany);
const mergedLarge = mergedSameCompany.cards.find(card => card.ticker === 'LARGE');
assert(mergedLarge.events.some(e => e.id === 'same-company-new'), 'new evidence is not hidden while an older source is pending');
assert(mergedLarge.events.some(e => e.id === report.events[0].id), 'old evidence remains alongside the new arrival');
const corrected = rankReport({ ...report, pending: 1, events: [{ ...report.events[0], headline: 'Corrected original event' }] }, { holdings: sizeHoldings });
assert.equal(mergePartialReport(byPriority, corrected).cards.find(c => c.ticker === 'LARGE').events.find(e => e.id === report.events[0].id).headline,
  'Corrected original event', 'a correction updates its old stable identity during partial progress');
const retractedEligibility = rankReport({ ...report, pending: 1,
  events: report.events.map(event => ({ ...event, aiEligible: false })) }, { holdings: sizeHoldings });
assert.equal(mergePartialReport(byPriority, retractedEligibility).cards.length, 0,
  'a source correction removing AI eligibility cannot resurrect old material evidence during a partial refresh');

const publisherCopy = { ...report.events[0], id: 'publisher-overlap', feed: 'market-news',
  direction: 'neutral', url: 'https://example.test/publisher-overlap', time: '09:15',
  headline: 'Large holding announces a material contract', storyText: 'The same captured report.',
  attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed' } };
const companyCopy = { ...publisherCopy, id: 'company-overlap', feed: 'news',
  newsProvenance: [{ feed: 'market-news', eventId: publisherCopy.id }, { feed: 'news', eventId: 'company-overlap' }] };
const overlapFeeds = [{ id: 'market-news', status: 'ok', reachesToday: true },
  { id: 'news', status: 'failed', reachesToday: false }];
const earlyPublisher = rankReport({ ...report, pending: 1, feeds: overlapFeeds, events: [publisherCopy] }, { holdings: sizeHoldings });
const chosenCompany = rankReport({ ...report, pending: 0, feeds: overlapFeeds, events: [companyCopy] }, { holdings: sizeHoldings });
const mergedPublisher = mergePartialReport(earlyPublisher, chosenCompany);
assert.equal(mergedPublisher.allCards[0].score, chosenCompany.allCards[0].score,
  'a partial publisher copy cannot change the completed lead source and its health penalty');
assert.deepEqual(mergedPublisher.allCards[0].sourceEvents.map(event => event.id), [companyCopy.id],
  'the chosen report retains the other route as provenance instead of restoring duplicate evidence');
const withOlderEvidence = mergePartialReport(byPriority, earlyPublisher);
assert(!mergePartialReport(withOlderEvidence, chosenCompany).allCards.flatMap(card => card.sourceEvents).some(event => event.id === publisherCopy.id),
  'the superseded copy stays excluded when other unfinished evidence still needs merging');

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
const vocabularyTrigger = { ...context, id: 'vocabulary-trigger', ticker: 'ALPHA', company: 'Alpha Cement',
  headline: 'Cement concrete operations', detail: '', keywordIds: [] };
const vocabularyCandidate = { ...context, id: 'vocabulary-context', ticker: 'ALPHA', company: 'Alpha Concrete',
  headline: 'Concrete cement disclosure', detail: '', keywordIds: [] };
const vocabularyReport = { day: '2026-09-04', feeds: [{ id: 'announcements', status: 'ok' }], events: [vocabularyCandidate] };
const vocabularyCard = { ticker: 'ALPHA', events: [vocabularyTrigger] };
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents.length, 0,
  'all trigger and candidate company names are excluded from topic overlap');
vocabularyTrigger.keywordIds = ['cement']; vocabularyCandidate.keywordIds = ['cement'];
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents[0]?.id, vocabularyCandidate.id,
  'explicit keyword IDs remain topics even when their word appears in a company name');
vocabularyTrigger.keywordIds = []; vocabularyCandidate.keywordIds = [];
assert.equal(enrichCardFromAllAlerts(vocabularyCard, vocabularyReport).contextEvents.length, 0,
  'a subsequent context build reads corrected trigger vocabulary');

// Publication envelopes and status-only progress must not derive the same cards repeatedly.
clearRankingCache();
let evidenceReads = 0;
const observedEvents = report.events.map(event => new Proxy(event, {
  get(target, key) { evidenceReads++; return target[key]; },
}));
const publication = { ...report, events: observedEvents, feeds: feeds.map(feed => ({ ...feed })) };
const cachedRank = rankReport(publication, { holdings: publicIdentities });
evidenceReads = 0;
const statusOnly = rankReport({ ...publication, events: [...observedEvents], pending: 2,
  cacheSavedAt: 1234, feeds: publication.feeds.map(feed => ({ ...feed, checkedAt: 1234 })) },
{ holdings: structuredClone(publicIdentities) });
assert.equal(evidenceReads, 0, 'unchanged record publications skip scoring and context derivation');
assert.equal(statusOnly.cards, cachedRank.cards);
assert.equal(statusOnly.allCards, cachedRank.allCards);
assert.equal(statusOnly.pending, 2);
assert.equal(statusOnly.meta.cacheSavedAt, 1234);
assert.equal(statusOnly.feeds[0].checkedAt, 1234, 'status-only envelopes still carry the latest source checks');
assert.equal(mergePartialReport(cachedRank, statusOnly).cards, cachedRank.cards,
  'cumulative partials reuse the completed derivation');
const correction = rankReport({ ...publication, events: observedEvents.map((event, i) => i === 0
  ? { ...event, headline: 'Same-count corrected evidence' } : event) }, { holdings: publicIdentities });
assert.equal(correction.allCards.find(card => card.ticker === 'LARGE').events.find(event => event.id === report.events[0].id).headline,
  'Same-count corrected evidence');
publication.feeds.forEach(feed => { feed.status = 'failed'; });
const failedRank = rankReport(publication, { holdings: publicIdentities });
assert(failedRank.allCards.find(card => card.ticker === 'LARGE').score < cachedRank.allCards.find(card => card.ticker === 'LARGE').score,
  'score-affecting source health invalidates even when the feed objects and event count are unchanged');
const notHeld = rankReport(publication, { holdings: [] });
assert.equal(notHeld.allCards.find(card => card.ticker === 'LARGE').holding, false, 'membership changes remove the held-company signal');
const nextWindow = rankReport({ ...publication, day: '2026-09-19' }, { holdings: publicIdentities });
assert.equal(nextWindow.allCards.length, 0, 'date changes re-age unchanged evidence');
const insight = { ticker: 'LARGE', companyKey: 'LARGE', name: 'Large holding', rows: [] };
const withInsight = rankReport(publication, { holdings: publicIdentities, insightCompanies: [insight] });
const failedInsight = rankReport(publication, { holdings: publicIdentities, insightCompanies: [{ ...insight, readStatus: 'failed' }] });
assert.notEqual(failedInsight.allCards, withInsight.allCards, 'changed Insights status invalidates context derivation');
const newWeights = { ...sizes, holdings: sizes.holdings.map(holding => ({ ...holding, weightPct: 10 })) };
assert.equal(rankReport(publication, { holdings: publicIdentities, positionSizes: newWeights }).allCards.find(card => card.ticker === 'LARGE').holdingWeightPct, 10);
assert.equal(withPositionSnapshot(immediateSizes, sizes), immediateSizes, 'unchanged positions reuse cards and report');
clearRankingCache();
assert.notEqual(rankReport(publication, { holdings: publicIdentities }).allCards, failedRank.allCards,
  'access invalidation discards the previous private derivation');
console.log('PASS: unchanged publications reuse derivations; corrections, source health, membership, dates, Insights and positions invalidate them.');

// ---------------------------------------------------------------------------------------
// THE DRIVER LAYER — "earnings assumption, valuation or thesis?"
//
// Fixtures rather than a capture, for the reason every rule block here uses them: the branches
// depend on which topic fields a collector happened to write, and no single day can be relied on to
// hold a dilution filing, a related-entity report and a market-wide story on one company.
const { driversOf, driversFromEvent, QUESTIONS } = await import('../public/js/data/alert-drivers.js');
const { announcementSignal } = await import('../public/js/data/filing-signals.js');

const drv = (o) => ({ day: '2026-09-03', ticker: 'ZZTEST', url: 'https://example.test/a', ...o });
const driverText = (events) => driversOf({ events }).buckets.flatMap((b) => b.drivers.map((x) => `${b.id}:${x.text}`));

assert.deepEqual(QUESTIONS.map((q) => q.id), ['earnings', 'valuation', 'thesis'], 'the three investor questions, in the order a card states them');
assert.deepEqual(QUESTIONS.map((q) => q.label), ['the earnings assumption', 'the valuation', 'the thesis']);

// The matched rule travels as a FIELD. Recovering it from `signalReason` would be regexing a value
// we had in hand back out of our own prose, and would empty the mapping silently on a reword.
assert.equal(announcementSignal({ title: 'Record date for Final Dividend' }).filingRule, 'shareholder distribution');
assert.equal(announcementSignal({ title: 'Notice of 25th Annual General Meeting' }).filingRule, null);

const mixed = [
  drv({ feed: 'announcements', keywordIds: ['order'], filingRule: 'shareholder distribution' }),
  drv({ feed: 'news', keywordIds: ['partnership'] }),
  drv({ feed: 'news', keywordIds: ['stake-sale'] }),
  drv({ feed: 'nse-filings', keywordIds: ['fraud'] }),
];
for (const expected of ['earnings:Order in a filing', 'earnings:Partnership in the news',
  'valuation:shareholder distribution in a filing', 'valuation:Stake sale in the news', 'thesis:Fraud in a filing']) {
  assert(driverText(mixed).includes(expected), `bucketed: ${expected}`);
}
assert.deepEqual(driversOf({ events: mixed }).silent, [], 'every question answered leaves nothing silent');

// A question with nothing behind it is STATED; only the whole section drops, and only when no
// question has an answer at all.
assert.deepEqual(driversOf({ events: [drv({ feed: 'news', keywordIds: ['order'] })] }).silent.map((q) => q.id), ['valuation', 'thesis']);
assert.equal(driversOf({ events: [drv({ feed: 'technicals', kind: 'volume', volumeX: 3.1 })] }).buckets.length, 0);

// The same topic in two sources is two drivers — separate records, separate links. Twice in one
// source is one.
assert.equal(driverText([drv({ feed: 'announcements', keywordIds: ['order'] }), drv({ feed: 'news', keywordIds: ['order'] })]).length, 2);
assert.equal(driverText([drv({ feed: 'news', keywordIds: ['order'] }), drv({ feed: 'news', keywordIds: ['order'], url: 'https://example.test/b' })]).length, 1);

// A FEED THAT CARRIES NO TOPIC SUPPLIES NO DRIVER. A volume ratio is not about orders or about
// governance, and bucketing one would be this dashboard asserting why somebody traded.
for (const feed of ['technicals', 'investors', 'insider', 'chatter', 'earnings', 'concalls']) {
  assert.deepEqual(driversFromEvent(drv({ feed, keywordIds: ['order'] })), [], `${feed} supplies no driver`);
}
// Market-wide news carries no company, so it can never become a company's driver — the same
// exclusion All Alerts already applies to the same feed.
assert.deepEqual(driverText([drv({ feed: 'market-news', keywordIds: ['fraud'] })]), []);
// ...and a reviewed report about a DIFFERENT company is not this company either.
assert.deepEqual(driverText([drv({ feed: 'news', keywordIds: ['fraud'],
  attribution: { version: ATTRIBUTION_VERSION, status: 'related', relationships: [{ relationship: 'subsidiary', evidenceUrl: 'https://example.test/e' }] } })]), []);
// An analyst's published view is a view OF the company, not an event AT it.
assert.deepEqual(driverText([drv({ feed: 'news', keywordIds: ['brokerage-research'] })]), []);

// A collector branch that wrote labels and no ids still resolves; an unknown label invents nothing.
assert.deepEqual(driverText([drv({ feed: 'news', keywords: ['Stake sale'] })]), ['valuation:Stake sale in the news']);
assert.deepEqual(driverText([drv({ feed: 'news', keywords: ['Not A Tracked Topic'] })]), []);

// A capped bucket COUNTS what it did not print: a truncation nobody can see is the card claiming
// fewer things bear on the company than its own evidence holds.
const many = ['order', 'capex', 'commissioning', 'product-launch', 'patent'].map((id) => drv({ feed: 'news', keywordIds: [id] }));
assert.equal(driversOf({ events: many }).buckets[0].drivers.length, 3);
assert.equal(driversOf({ events: many }).buckets[0].overflow, 2);
assert.equal(driversOf({ events: many }).total, 5);

// Every driver carries the event it was read off, so the card can link it to the same record the
// evidence row uses — and says it matched a topic rather than verifying an event.
for (const driver of driversOf({ events: mixed }).buckets.flatMap((b) => b.drivers)) {
  assert(mixed.includes(driver.event), 'a driver carries its own source event');
  assert(/does not verify|not confirmation/.test(driver.why), 'a driver disclaims verification');
}

// IT ADDS NO SCORE. It explains a card that was surfaced anyway; it is not a second materiality
// gate, which is the pattern this codebase keeps having to un-write.
const scored = (event) => {
  clearRankingCache();
  return rankReport({ scope: 'universe', day: '2026-09-03', feeds: [{ id: 'announcements', status: 'ok', reachesToday: true }], events: [event] }, { holdings: [] });
};
const topicEvent = { id: 'd1', day: '2026-09-03', ticker: 'ZZTEST', company: 'ZZ Test Ltd', feed: 'announcements', feedLabel: 'Announcements',
  direction: 'positive', importance: 'high', headline: 'Record date for Final Dividend', filingRule: 'shareholder distribution', keywordIds: ['buyback'], url: 'https://example.test/a' };
assert.equal(scored(topicEvent).allCards[0].score, scored({ ...topicEvent, filingRule: null, keywordIds: [] }).allCards[0].score,
  'topics change no score');
// The reading now rides the ROW rather than the card object, so what has to be true is that the
// event the card surfaced still answers `driversFromEvent` — that is what the row chip reads.
assert(scored(topicEvent).allCards[0].events.flatMap((event) => driversFromEvent(event)).length > 0,
  '...while still reaching the evidence the card surfaced');

console.log('PASS: driver buckets, source phrases, excluded feeds, capped overflow and score neutrality.');


// --- WHICH ROWS A CARD SHOWS: one per SOURCE, in rounds, capped per source -----------------------
//
// The rule exists so a card never answers "what do the other sources say?" with one source said
// four times. It is asserted on fixtures because a day's capture decides which shapes exist, and
// the shape that matters most — one board meeting filed to both exchanges under four subjects —
// only shows up when a company happens to have filed one.
const { topEvidence, MAX_PER_SOURCE } = await import('../public/js/data/ai-alerts.js');
const row = (feed, id, importance = 'high') => ({ feed, id, headline: id, day: '2026-09-18', direction: 'neutral', importance });
const ids = (card, limit) => topEvidence(card, limit).map((event) => event.id).join(',');

// ONE SOURCE, FOUR SLOTS, THREE ROWS. `announcements` and `nse-filings` are one family, so keying
// this on `event.feed` spent two slots before filling and printed the same event four times under
// a header reading "1 source" — measured on Sky Gold's 18 September approval.
const oneSource = { events: [row('announcements', 'a1'), row('nse-filings', 'a2'), row('announcements', 'a3'), row('nse-filings', 'a4')] };
assert.equal(ids(oneSource, 4), 'a1,a2,a3', 'one source stops at the cap rather than filling every slot');
assert.equal(MAX_PER_SOURCE, 3);

// TWO SOURCES SHARE FOUR SLOTS TWO AND TWO, rather than three and one.
assert.equal(ids({ events: [row('announcements', 'a1'), row('news', 'n1'), row('announcements', 'a2'), row('news', 'n2'), row('announcements', 'a3')] }, 4),
  'a1,n1,a2,n2', 'slots go one per source in rounds');
// AND EVERY SOURCE IS REPRESENTED BEFORE ANY SECOND ROW IS SPENT.
assert.equal(ids({ events: [row('announcements', 'a1'), row('news', 'n1'), row('investors', 'f1'), row('announcements', 'a2')] }, 4),
  'a1,n1,f1,a2', 'breadth first, then depth');
// A source's own rows stay in score order, so the cap never promotes a weaker row over a stronger.
assert.equal(ids({ events: [row('news', 'n1'), row('news', 'n2'), row('news', 'n3', 'low'), row('news', 'n4')] }, 4),
  'n1,n2,n3', 'within one source the order is the score order it arrived in');
// A card with fewer events than slots is unchanged by any of this.
assert.equal(ids({ events: [row('news', 'n1')] }, 4), 'n1');
assert.deepEqual(topEvidence({ events: [] }, 4), []);
console.log('PASS: evidence rows go one per source in rounds, capped per source, counting NSE and BSE as one.');


// --- WHAT THE CARD SAYS HAPPENED: one claim, the source's own -----------------------------------
//
// The sentence used to lead with the PATTERN and append the two figures a phrase had been written
// for, so a card whose strongest event was a ten-year supply contract said "An insider and a big
// holder moved the same way" and never mentioned the contract. It is now one claim — the strongest
// event's own statement — and these are asserted on fixtures because which shapes a day contains
// (a sign-flip result, a pointer subject, a block deal with a rupee value) is a property of the
// capture and not of the rule.
const { plainHeadline, plainInsight, leadEvent, filingClaim, sourceStatement, CLAIM_MAX } =
  await import('../public/js/data/ai-alerts.js');

// OUR OWN LINES ARE COMPLETED, because the figure a row was graded on is the specific a reader
// opens the card for. Every one is read from a collector's field, never parsed out of a sentence.
assert.equal(
  plainHeadline({ feed: 'insider', headline: 'ACTIV PINE LLP — Sell', tradeValue: 491645000, tradeCategory: 'Block deal' }),
  'ACTIV PINE LLP — Sell · ₹49.2 crore block deal');
assert.equal(
  plainHeadline({ feed: 'insider', headline: 'A PROMOTER — Sell', tradePct: 15 }),
  'A PROMOTER — Sell · 15.00% of the company', 'a percentage of the company stands in for an absent value');
assert.equal(
  plainHeadline({ feed: 'insider', headline: 'A PROMOTER — Sell', tradeShares: 1277000 }),
  'A PROMOTER — Sell · 12,77,000 shares', 'a share count is the last resort and is formatted, not summed');
assert.equal(plainHeadline({ feed: 'insider', headline: 'A PROMOTER — Sell' }), 'A PROMOTER — Sell',
  'a disclosure that carried no size gets no size — never a zero');
// "SAST" and "Insider" are filing regimes rather than kinds of trade, so only a deal reads as one.
assert.equal(
  plainHeadline({ feed: 'insider', headline: 'X — Buy', tradeValue: 200000000, tradeCategory: 'SAST' }),
  'X — Buy · ₹20.0 crore');

// A RESULT SAYS WHAT WAS REPORTED, and a period that crossed zero is words rather than a rate —
// the same rule as `classifyChange`, read off the same `kind`.
const result = (netProfit, revenue) => plainHeadline({ feed: 'earnings', resultBasis: 'YOY', headline: 'YOY quarterly result filed', sourceRecord: { netProfit, revenue } });
assert.equal(result({ label: 'Net Profit', kind: 'normal', pct: 95 }, { label: 'Revenue', kind: 'normal', pct: 55 }),
  'Result filed (YOY) · net profit +95.0%, revenue +55.0%');
assert.equal(result({ label: 'Net Profit', kind: 'turnaround', pct: null }, { label: 'Revenue', kind: 'normal', pct: 35 }),
  'Result filed (YOY) · net profit swung to profit, revenue +35.0%');
assert.equal(result({ label: 'Net Profit', kind: 'loss-widened', pct: -208 }, { label: 'Revenue', kind: 'normal', pct: -4 }),
  'Result filed (YOY) · net profit loss widened 208.0%, revenue −4.0%');
assert.equal(result({ label: 'Net Profit', kind: 'normal', pct: null }, null), 'YOY quarterly result filed',
  'a comparison the source did not carry contributes nothing and the collector line stands');

// SOMEBODY ELSE'S WORDS TRAVEL UNTOUCHED. A publisher's headline is the reference case.
const story = 'Sona BLW Precision Forgings Ltd Downgraded to Hold Amid Mixed Technical Signals';
assert.equal(plainHeadline({ feed: 'news', headline: story }), story);

// A FILING'S SUBJECT IS NEVER REPLACED WHERE IT NAMES AN EVENT.
assert.equal(filingClaim({ filingSubject: 'Resignation of Statutory Auditor', filingSubCategory: 'Resignation' }),
  'Resignation of Statutory Auditor');
// A greedy pointer pattern used to swallow one that does: measured on a real BSE filing.
const enclosed = 'Please find enclosed herewith the disclosure pertaining to incorporation of two Wholly-Owned Subsidiaries';
assert.equal(filingClaim({ filingSubject: enclosed, filingSubCategory: 'Acquisition' }), enclosed);
// …and a subject that is only a pointer falls through to the source's own description.
assert.equal(
  filingClaim({ filingSubject: 'Press Release', filingSubCategory: null,
    filingDescription: 'Biocon Limited has informed the Exchange regarding a press release dated September 08, 2026, titled "Biocon Secures 10-Year Supply Contract for Pertuzumab in Brazil". |SUBJECT: Press Release' }),
  'Biocon Secures 10-Year Supply Contract for Pertuzumab in Brazil',
  "their own quoted title for the filing is the claim — selected, not reworded");
// EVERY SEGMENT HAS TO BE A TYPE WORD. "Press Release / Media Release" is BSE's own sub-category
// for a press release and an exact-match list of single words let it through.
assert.equal(filingClaim({ filingSubject: 'Press Release / Media Release', filingSubCategory: 'Press Release / Media Release',
  filingDescription: 'Announcement under Regulation 30 on the commissioning of Unit II' }),
  'Announcement under Regulation 30 on the commissioning of Unit II');
// A description that only repeats the subject is not an improvement on it, and NSE sends both.
assert.equal(filingClaim({ filingSubject: 'General Updates', filingDescription: 'General Updates |SUBJECT: General Updates', filingSubCategory: null }),
  'General Updates');
assert.equal(filingClaim({ filingSubject: 'Updates', filingDescription: "''. |SUBJECT: Updates", filingSubCategory: 'Company Update' }),
  'Company Update', "the exchange's own sub-category is the floor, never our own invention");
assert.equal(filingClaim({ filingSubject: 'PFA', filingSubCategory: 'Award of Order / Receipt of Order' }),
  'Award of Order / Receipt of Order');

// THE EXCHANGE'S MECHANICAL LEAD-IN IS REMOVED AND WHAT FOLLOWS IT IS NOT. It cost half the line.
assert.equal(sourceStatement('Mazagon Dock Shipbuilders Limited has informed the Exchange regarding signing of MOU with NSHIPAP.'),
  'Signing of MOU with NSHIPAP');
assert.equal(sourceStatement('The Exchange has received Disclosure under Regulation 31(1) of SEBI (SAST) Regulations, 2011'),
  'Disclosure under Regulation 31(1) of SEBI (SAST) Regulations, 2011');
assert.equal(sourceStatement('Board Comments on fine levied by the Exchange'), 'Board Comments on fine levied by the Exchange',
  'a statement with no lead-in comes back unchanged');
// A clause the strip exposed opens as a sentence — but a word that capitalises itself is left be.
assert.equal(sourceStatement('X Ltd has informed the exchange about the approval of the Board'), 'The approval of the Board');
assert.equal(sourceStatement('X Ltd has informed the exchange about iPhone assembly beginning at Hosur'),
  'iPhone assembly beginning at Hosur', 'a brand is not recapitalised by this dashboard');
assert.equal(sourceStatement(''), '');
assert.equal(sourceStatement(null), '');

// A CLAIM TOO LONG FOR THE LINE IS CUT ON A WORD BOUNDARY, with an ellipsis that says so.
const long = plainHeadline({ feed: 'news', headline: `${'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa '.repeat(6)}end` });
assert(long.length <= CLAIM_MAX + 1 && long.endsWith('…') && !/\s…$/.test(long), `clipped: ${long.length} chars`);
assert(!long.includes('Zeta…'.slice(0, 2) + '…'), 'no word is cut in half');

// THE SENTENCE IS THE LEAD EVENT'S CLAIM AND NOTHING ELSE — no pattern name, no feed tally.
const ev = (over) => ({ feed: 'announcements', importance: 'high', direction: 'neutral', day: '2026-09-18', ...over });
const contract = ev({ headline: 'Press Release', filingSubject: 'Press Release',
  filingDescription: 'X Ltd has informed the Exchange regarding a press release titled "Ten-year supply contract signed".' });
const tape = { feed: 'technicals', kind: 'volume', volumeX: 2.04, importance: 'high', direction: 'neutral', day: '2026-09-18' };
const oneClaim = { events: [contract, tape], topEvent: contract, mixed: false, directions: { positive: 0, negative: 0, neutral: 2 },
  feedCount: 2, confluence: [{ id: 'news-behind-the-move', label: 'The move has a story behind it', short: 'News behind it' }] };
assert.equal(plainInsight(oneClaim), 'Ten-year supply contract signed.');
assert.equal(leadEvent(oneClaim), contract);
// A disagreement is still stated, because it changes what the reader does next — as an action.
assert.equal(plainInsight({ ...oneClaim, mixed: true }),
  'Ten-year supply contract signed. Sources disagree — check both directions below.');
// AND THE TALLY AND THE FILLER ARE GONE. Neither was a thing that happened.
for (const mixed of [true, false]) {
  const text = plainInsight({ ...oneClaim, mixed, directions: { positive: 8, negative: 6, neutral: 1 } });
  assert(!/\b8\b|\b6\b|good, |strongest recent|material, recent and relevant/i.test(text), `no tally or filler: ${text}`);
  assert(!/^(Heavy trading|An insider and|Unusual trading|Results are out|Bad news showing up|A big move with)/.test(text),
    `the pattern is the chip, not the sentence: ${text}`);
}

// A LEAD WHOSE CLAIM IS STILL ONLY A TYPE WORD IS SKIPPED, AND ITS ROW IS KEPT. NSE repeats the
// subject as the description on some rows and publishes no sub-category, so this survives all
// three fallbacks; the card then leads with the next fact it holds rather than with "Updates".
const typeOnly = ev({ headline: 'General Updates', filingSubject: 'General Updates', filingDescription: 'General Updates' });
const skipped = { events: [typeOnly, tape], topEvent: typeOnly, mixed: false, directions: { positive: 0, negative: 0, neutral: 2 }, feedCount: 2, confluence: [] };
assert.equal(leadEvent(skipped), tape);
assert.equal(plainInsight(skipped), 'Traded 2.0x its normal volume.');
assert.equal(skipped.events.length, 2, 'the skipped event keeps its place in the evidence');
assert.equal(topEvidence(skipped, 4)[0], typeOnly, '…and its row is still the first one shown');
// Where every claim is a type word the card still says the one it has rather than inventing one.
assert.equal(plainInsight({ events: [typeOnly], topEvent: typeOnly, mixed: false, directions: { positive: 0, negative: 0, neutral: 1 }, feedCount: 1, confluence: [] }),
  'General Updates.');
console.log('PASS: the card states one claim — the strongest event\'s own — completing our lines and reproducing theirs.');


// --- the sliced ranking is the synchronous ranking, spread over time --------------------------
// One generator, two drivers: `rankReportAsync` must resolve to exactly what `rankReport` returns,
// must yield to input between slices on a large input, and must resolve null — never a partial
// result — once nobody is waiting for it. Asserted on the fixture above and on a synthetic
// Universe of 3,000 companies, because the yield only happens where a slice has something to cut.
const { rankReportAsync, mergePartialReportAsync } = await import('../public/js/data/ai-alerts.js');
const { runSteps, runStepsInSlices, sortSteps } = await import('../public/js/core/slices.js');
clearRankingCache();
const syncFixture = rankReport(report, { holdings: sizeHoldings, positionSizes: sizes });
clearRankingCache();
assert.deepEqual(await rankReportAsync(report, { holdings: sizeHoldings, positionSizes: sizes }), syncFixture, 'sliced ranking of the fixture equals the synchronous one');
const universeFeeds = ['earnings', 'announcements', 'insider', 'technicals', 'investors'].map(id => ({ id, status: 'ok', reachesToday: true }));
const universeDay = '2026-09-04';
const universeEvents = [];
for (let i = 0; i < 3000; i++) {
  const ticker = `U${String(i).padStart(4, '0')}`;
  universeFeeds.forEach(({ id }, j) => {
    const age = (i + j) % 14;
    const day = new Date(Date.parse(`${universeDay}T00:00:00Z`) - age * 86400000).toISOString().slice(0, 10);
    universeEvents.push({ id: `${ticker}-${id}-${j}`, ticker, company: `Company ${i}`, feed: id, feedLabel: id, day, time: `${String(9 + j).padStart(2, '0')}:15`,
      headline: `${ticker} ${id} ${['order win', 'fraud probe', 'buyback', 'results', 'stake sale'][(i + j) % 5]} update`,
      detail: `Detail ${i} ${j}`, url: `https://example.test/${ticker}/${id}/${j}`, importance: (i + j) % 3 ? 'low' : 'high',
      direction: ['positive', 'negative', 'neutral'][(i + j) % 3], kind: id === 'technicals' ? 'move' : 'filing',
      ...(id === 'technicals' ? { movePct: ((i % 13) - 6) * 1.1, volumeX: 1 + (i % 4) } : {}),
      ...(id === 'investors' ? { investor: `Fund ${i % 7}`, action: ['added', 'reduced', 'new', 'exited'][i % 4], deltaPp: (i % 5) * 0.4 } : {}),
      ...(id === 'announcements' ? { keywordIds: ['order', 'fraud'].slice(0, 1 + (i % 2)) } : {}) });
  });
}
const universeReport = { day: universeDay, scope: 'universe', feeds: universeFeeds, events: universeEvents };
const universeHoldings = Array.from({ length: 140 }, (_, i) => ({ ticker: `U${String(i * 21).padStart(4, '0')}`, name: `Company ${i * 21}`, sector: `Sector ${i % 9}` }));
clearRankingCache();
const started = performance.now();
const syncUniverse = rankReport(universeReport, { holdings: universeHoldings });
const syncMs = performance.now() - started;
assert(syncUniverse.allCards.length === 3000 && syncUniverse.cards.length > 0, 'the synthetic Universe ranks every company');
clearRankingCache();
let yields = 0, longestStretch = 0, lastYield = performance.now();
const slicedUniverse = await rankReportAsync(universeReport, { holdings: universeHoldings }, { yieldForInput: async () => {
  const now = performance.now(); longestStretch = Math.max(longestStretch, now - lastYield); yields++;
  await new Promise(resolve => setTimeout(resolve, 0)); lastYield = performance.now();
} });
assert.deepEqual(slicedUniverse, syncUniverse, 'sliced Universe ranking equals the synchronous one, card for card');
assert(yields > 0, `a ${Math.round(syncMs)}ms ranking yields to input at least once (yielded ${yields} times)`);
assert(longestStretch < 250, `no stretch between yields exceeds a quarter second (longest ${Math.round(longestStretch)}ms)`);
clearRankingCache();
let asked = 0;
assert.equal(await rankReportAsync(universeReport, { holdings: universeHoldings }, { yieldForInput: async () => { asked++; }, isCurrent: () => false }), null,
  'a ranking nobody is waiting for resolves null after its first slice');
assert.equal(asked, 1, 'and stops asking for more time');
clearRankingCache();
assert.deepEqual(await mergePartialReportAsync(byPriority, arriving), mergePartialReport(byPriority, arriving), 'the sliced merge equals the synchronous merge');
assert.deepEqual(await mergePartialReportAsync(byPriority, { ...byPriority, cards: [], allCards: [] }), mergePartialReport(byPriority, { ...byPriority, cards: [], allCards: [] }), 'an empty partial merges the same way in slices');
function* counting(n) { let sum = 0; for (let i = 1; i <= n; i++) { sum += i; yield; } return sum; }
assert.equal(runSteps(counting(100)), 5050);
assert.equal(await runStepsInSlices(counting(100), { sliceMs: 0, yieldForInput: async () => {} }), 5050, 'the sliced driver returns the generator result');
assert.equal(await runStepsInSlices(counting(100), { sliceMs: 0, yieldForInput: async () => {}, keepGoing: () => false }), undefined, 'an abandoned generator resolves undefined');
// A sliced stable sort orders exactly as the native stable sort, ties included, however driven.
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const sample = Array.from({ length: 50000 }, (_, i) => ({ key: Math.floor(random() * 300), tie: Math.floor(random() * 4), i }));
const byKey = (a, b) => a.key - b.key || (a.tie === b.tie ? 0 : a.tie < b.tie ? -1 : 1);
const native = [...sample].sort(byKey);
const slicedSort = [...sample];
let sortYields = 0;
await runStepsInSlices(sortSteps(slicedSort, byKey, { run: 512, stride: 1024 }), { sliceMs: 0, yieldForInput: async () => { sortYields++; } });
assert.deepEqual(slicedSort, native, 'the sliced stable sort orders exactly as the native stable sort, ties included');
assert.deepEqual(runSteps(sortSteps([...sample], byKey)), native, 'driven synchronously it orders the same');
assert(sortYields > 10, `a large sort yields many times (${sortYields})`);
assert.deepEqual(runSteps(sortSteps([], byKey)), []);
assert.deepEqual(runSteps(sortSteps([sample[0]], byKey)), [sample[0]]);
assert.deepEqual(runSteps(sortSteps([...sample].slice(0, 3000), byKey, { run: 7, stride: 5 })), [...sample].slice(0, 3000).sort(byKey), 'odd run and stride sizes order the same');
console.log(`PASS: sliced ranking and merge equal their synchronous references (3,000-company Universe: ${Math.round(syncMs)}ms synchronous, ${yields} yields, longest stretch ${Math.round(longestStretch)}ms), and stop when nobody is waiting.`);
