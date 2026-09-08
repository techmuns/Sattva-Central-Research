#!/usr/bin/env node
// Regression for the customer-reported OnEMI article. All reads are local fixtures; no egress.
import assert from 'node:assert/strict';
import { portfolioNewsEntities, filterCompanyNewsByScope } from '../public/js/data/company-news-identity.js';
import { attributeNewsRow, companyNewsAttribution } from '../public/js/data/company-news-attribution.js';
import { matchPortfolioNews, newsEventTopics } from '../public/js/data/portfolio-news-matching.js';
import { classifyStory } from '../public/js/data/news-keywords.js';

const store = new Map();
globalThis.localStorage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
const { newsSignal, companyNewsState, eventSearchText, mapPortfolioDiscoveryEvents, matchesAlertScope, materializePublicAlertWindow, readCachedAlertWindow, ALERT_WINDOW_CACHE_KEY } = await import('../public/js/data/daily-alerts.js');
const { enrichmentCoverageIncomplete, newsViewStatus } = await import('../public/js/core/news-view-status.js');
const { rankReport, mergePartialReport } = await import('../public/js/data/ai-alerts.js');
const { matchesSearch } = await import('../public/js/ui/ai-alert-utils.js');
const { alertCoverageState, feedState, matchesCompanyRelationship } = await import('../public/js/tabs/daily-alerts.js');
const { writeEntry } = await import('../public/js/core/store.js');
const holdings = [{ ticker: 'KISSHT', isin: 'INE12F801023', name: 'OnEMI Technology Solutions' }];
const identities = portfolioNewsEntities(holdings);
const [identity] = identities;
const title = 'JM Financial initiates coverage on OnEMI Technology with Buy call, sees 28% upside - The Economic Times';
const source = {
  title, source: 'The Economic Times', date: '2026-09-04', publishedAt: '2026-09-04T07:18:00.000Z',
  url: 'https://economictimes.indiatimes.com/markets/stocks/news/jm-financial-initiates-coverage-on-onemi-technology-with-buy-call-sees-28-upside/articleshow/133755070.cms',
  summary: 'Readers are advised to consider the company information. Trending stocks: Axis Bank.',
};
assert(identity.aliases.includes('OnEMI Technology'));
assert(identity.queries.includes('OnEMI Technology'), 'reviewed shortened name also enters scheduled discovery');
assert.equal(matchPortfolioNews(source, identities)[0].ticker, 'KISSHT');
assert.equal(companyNewsAttribution(source, { ticker: 'KISSHT', name: 'OnEMI Technology Solutions' }).status, 'confirmed', 'ticker-only cached identity can use the reviewed alias');
assert.equal(companyNewsAttribution(source, { ticker: 'AXISBANK', name: 'Axis Bank' }).status, 'uncertain', 'snippet navigation cannot confirm Axis Bank');
const row = attributeNewsRow(source, identity);
const signal = newsSignal(row);
assert.equal(signal.importance, 'high');
assert.equal(signal.direction, 'neutral', 'a reported Buy call is not this product giving a Buy signal');
assert.equal(signal.aiEligible, true);
assert(signal.keywords.includes('Brokerage research / rating change'));
assert(classifyStory(row).labels.includes('Brokerage research'), 'News topic filter agrees with the alert category');
assert.match(signal.signalReason, /does not verify/);

const event = { ...signal, id: `news:${identity.entityId}|${source.url}`, sourceRecord: row,
  ticker: identity.ticker, entityId: identity.entityId, company: identity.name,
  headline: title, day: source.date, at: source.publishedAt, time: '12:48', url: source.url, feed: 'news' };
for (const query of ['kissht', 'onemi technology', 'jm financial', 'economic times']) {
  assert(eventSearchText(event).toLowerCase().includes(query), `All Alerts remains searchable by ${query}`);
}
const mapped = mapPortfolioDiscoveryEvents('market-news', [{ ...event, ticker: null, entityId: null, sourceRecord: source }], identities)[0];
assert.equal(mapped.ticker, 'KISSHT', 'a dedicated-publisher item is mapped without waiting for search enrichment');
assert.equal(mapped.aiEligible, true);
assert.equal(mapped.importance, 'high');

for (const headline of [
  title,
  'Brokerage starts coverage on Kissht with Hold rating',
  'Analyst resumes coverage of OnEMI Technology',
  'Morgan Stanley upgrades OnEMI Technology to overweight',
  'UBS downgrades Kissht to Sell',
  'Broker raises price target for OnEMI Technology to Rs 400',
  'OnEMI Technology target price cut to Rs 300',
]) assert(newsEventTopics({ title: headline }).includes('Brokerage research / rating change'), headline);
for (const headline of [
  'Kissht upgrades its payment software',
  'Kissht expands insurance coverage',
  'Kissht sets revenue target for next year',
  'Kissht employees begin coverage of the football tournament',
  'Kissht investors await a research report',
]) assert(!newsEventTopics({ title: headline }).includes('Brokerage research / rating change'), `routine language is not brokerage research: ${headline}`);
assert(!newsEventTopics({ title: 'Kissht company profile', summary: title }).includes('Brokerage research / rating change'), 'summary/sidebar alone cannot promote the article');
for (const headline of ['Kiss band announces tour', 'Kishtwar residents face a landslide', 'Kiss reunion coverage begins']) {
  const noisy = attributeNewsRow({ ...source, title: headline, summary: '' }, identity);
  assert.equal(noisy.attribution.status, 'uncertain');
  assert.equal(newsSignal(noisy).aiEligible, false);
  assert(eventSearchText({ ...event, ...newsSignal(noisy), sourceRecord: noisy, headline }).toLowerCase().includes('kissht'), 'unverified query hits are retained and searchable, not deleted');
  assert(matchesCompanyRelationship({ ...event, ...newsSignal(noisy) }, 'uncertain'));
  assert(!matchesCompanyRelationship({ ...event, ...newsSignal(noisy) }, 'confirmed'));
}
assert(matchesCompanyRelationship(event, 'confirmed'));
assert(matchesCompanyRelationship({ feed: 'announcements', ticker: 'KISSHT' }, 'confirmed'), 'matched-company filter retains source-attributed filings');
assert(matchesCompanyRelationship({ feed: 'news', attribution: { status: 'unrelated' } }, 'all'));

const feeds = status => [{ id: 'news', status, reachesToday: status === 'ok' }];
const report = (events = [event], day = '2026-09-07', status = 'ok') => ({ day, scope: 'portfolio', includeHistory: true, events, feeds: feeds(status), pending: status === 'pending' ? 1 : 0 });
const rank = value => rankReport(value, { holdings, insightCompanies: [] });
for (const day of ['2026-09-04', '2026-09-07', '2026-09-17']) {
  for (const status of ['ok', 'pending', 'failed']) {
    const card = rank(report([event], day, status)).cards[0];
    assert.equal(card?.ticker, 'KISSHT', `retained article remains eligible on ${day} while ${status}`);
    assert.equal(card.priority, 'important', 'retention never manufactures the highest urgency');
    assert(matchesSearch(card, 'kissht'));
    assert(matchesSearch(card, 'onemi technology'));
  }
}
assert.equal(rank(report([event], '2026-09-18')).cards.length, 0, 'AI eligibility respects the disclosed 14-day window');
assert(eventSearchText(event).includes(title), 'AI aging does not delete the original All Alerts evidence');
const before = rank(report());
const laterEvent = { ...event, id: 'news:later', headline: 'Broker cuts target price for OnEMI Technology', day: '2026-09-07', url: 'https://example.test/later' };
const after = mergePartialReport(before, rank(report([laterEvent], '2026-09-07', 'pending')));
assert(after.cards[0].events.some(e => e.id === event.id));
assert(after.cards[0].events.some(e => e.id === laterEvent.id), 'new evidence for the same company joins while another source is pending');
await writeEntry(ALERT_WINDOW_CACHE_KEY, { value: materializePublicAlertWindow(report()) });
const restored = await readCachedAlertWindow({ day: '2026-09-08', scope: 'portfolio', holdings });
assert.equal(rank(restored).cards[0]?.ticker, 'KISSHT', 'next-day reload preserves the story');
assert.equal((await readCachedAlertWindow({ day: '2026-09-08', scope: 'portfolio', holdings: [] })).events.length, 0, 'portfolio exit only changes scope, never an archived source');
assert.equal((await readCachedAlertWindow({ day: '2026-09-08', scope: 'universe', holdings: [] })).events.length, 1, 'retained public evidence survives the portfolio exit');

// BSE-resolved / changed symbols cannot veto a stable held identity. Both known-company and
// uncertain query records are visible in News, All Alerts and the reload cache under one rule.
const noSymbolHoldings = [{ ticker: null, isin: holdings[0].isin, name: holdings[0].name }];
const scopeContext = { scope: 'portfolio', wanted: new Set(), entityIds: new Set([identity.entityId]) };
const remappedRows = [event, { ...event, id: 'possible-bse', ticker: '544754', attribution: { ...event.attribution, status: 'uncertain' }, aiEligible: false }];
assert.equal(filterCompanyNewsByScope(remappedRows, 'portfolio', noSymbolHoldings).length, 2);
assert.equal(remappedRows.filter(row => matchesAlertScope(row, scopeContext)).length, 2, 'All Alerts has the same identity-or-ticker semantics as Portfolio News');
assert(!matchesAlertScope({ ...event, entityId: 'isin:OTHER' }, scopeContext));
assert(!matchesAlertScope(event, { ...scopeContext, scope: 'watchlist' }), 'a stable portfolio identity does not broaden Watchlist');
assert(!matchesAlertScope({ ...event, portfolioOnly: true }, { ...scopeContext, scope: 'universe', requestedEntities: scopeContext.entityIds }), 'requested identities never broaden private portfolio-only sources');
await writeEntry(ALERT_WINDOW_CACHE_KEY, { value: materializePublicAlertWindow(report(remappedRows)) });
const identityReload = await readCachedAlertWindow({ day: '2026-09-08', scope: 'portfolio', holdings: noSymbolHoldings });
assert.equal(identityReload.events.length, 2, 'reload cannot silently remove same-ISIN records merely because they carry a source symbol');
assert.equal(rankReport(identityReload, { holdings: noSymbolHoldings, insightCompanies: [] }).cards[0]?.entityId, identity.entityId);
const gapIdentities = [
  ['ASHIKA', 'INE094B01013'], ['VISL', 'INE1CLE01013'], ['TURTLEMINT', 'INE0OC301013'],
  ['VOGL', 'INE704J01044'], ['VAML', 'INE1CDF01017'], ['SETL', 'INE0M4D01010'], ['VEDPOWER', 'INE694L01019'],
];
const gapHoldings = gapIdentities.map(([name, isin]) => ({ name, isin, ticker: null }));
const gapRows = gapIdentities.map(([ticker, isin]) => ({ ...event, ticker, entityId: `isin:${isin}` }));
const gapContext = { scope: 'portfolio', wanted: new Set(), entityIds: new Set(portfolioNewsEntities(gapHoldings).map(e => e.entityId)) };
assert.deepEqual(gapRows.filter(row => matchesAlertScope(row, gapContext)), filterCompanyNewsByScope(gapRows, 'portfolio', gapHoldings),
  'all seven customer-probe identity gaps share News/All Alerts membership');

assert.equal(alertCoverageState(null).status, 'loading');
assert.equal(alertCoverageState({ feeds: [], pending: 0 }).status, 'loading', 'empty initialization cannot claim successful checks');
assert.equal(alertCoverageState(report([], undefined, 'pending')).status, 'loading');
assert.equal(alertCoverageState(report([], undefined, 'failed')).status, 'partial');
assert.equal(alertCoverageState({ ...report(), feeds: [{ id: 'news', status: 'ok', reachesToday: false }] }).status, 'behind');
assert.equal(alertCoverageState(report()).status, 'checked');
for (const status of ['pending', 'failed']) assert(!/\d/.test(feedState({ status }).short({ count: 0 })), 'unfinished sources cannot print a false zero');
assert.equal(feedState({ status: 'failed' }).short(), 'partial');
const checkAt = Date.parse('2026-09-07T09:00:00Z');
const completeCoverage = { capturedAt: new Date(checkAt).toISOString(), staleOrIncompleteQueries: 0, pagesFailed: 0, documentsPending: 0 };
const deliveryMeta = { rowCount: 1, capturedAt: completeCoverage.capturedAt,
  newsDelivery: Object.fromEntries(['core', 'publishers', 'tradingView'].map(key => [key, { status: 'ok', pending: false }])),
  enrichmentCoverage: completeCoverage };
assert.equal(companyNewsState('2026-09-07', deliveryMeta, checkAt).status, 'ok');
assert.equal(companyNewsState('2026-09-07', deliveryMeta, checkAt).reachesToday, true);
for (const gap of [
  { staleOrIncompleteQueries: 39 }, { pagesFailed: 2 }, { documentsPending: 330 },
  { capturedAt: '2026-09-05T09:00:00Z' }, { capturedAt: '2026-09-08T09:00:00Z' }, { capturedAt: 'invalid' },
  { staleOrIncompleteQueries: undefined }, { pagesFailed: -1 }, { documentsPending: 'unknown' },
]) {
  const enrichmentCoverage = { ...completeCoverage, ...gap };
  assert(enrichmentCoverageIncomplete(enrichmentCoverage, checkAt));
  const state = companyNewsState('2026-09-07', { ...deliveryMeta, enrichmentCoverage }, checkAt);
  assert.equal(state.status, 'failed', 'declared discovery gaps remain partial even if all other sources loaded');
  assert.equal(state.reachesToday, false);
  assert.equal(alertCoverageState({ feeds: [{ id: 'news', ...state }], pending: 0 }).status, 'partial');
}
const missingCoverage = companyNewsState('2026-09-07', { ...deliveryMeta, enrichmentCoverage: null }, checkAt);
assert.equal(missingCoverage.status, 'ok', 'legacy absence does not invent a failed request');
assert.equal(missingCoverage.reachesToday, false, 'unknown discovery coverage cannot certify current completeness');
assert.match(missingCoverage.note, /has not reported coverage/);
assert.equal(newsViewStatus({ ...deliveryMeta, enrichmentCoverage: { ...completeCoverage, documentsPending: 330 } }).state, 'partial', 'News and All Alerts expose the same pending-document gap');
console.log('PASS: exact OnEMI headline → reviewed KISSHT identity → searchable All Alerts → material neutral AI evidence; aliases, noisy-query retention, brokerage vocabulary, partial refresh, rollover, scope exit and truthful source states.');
