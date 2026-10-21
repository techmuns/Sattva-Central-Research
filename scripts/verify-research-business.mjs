#!/usr/bin/env node
// Portfolio relationship and event-return contracts. No network, inference or private data.
import assert from 'node:assert/strict';
import { businessIntent, businessSignals, businessReadings, holdingForBusinessRow, portfolioBusinessContext, fitBusinessContext, businessPeerSamples, datedPerformance } from '../public/js/research/business-context.js';
import { researchPriceHistory, retainedPriceHistory } from './lib/research-price-history.mjs';
import { providerEvidence, researchEvidenceChars } from '../public/js/research/evidence-shared.js';
import { researchPreview } from '../public/js/research/preview.js';
import { buildMunsRequest } from '../worker/research.mjs';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { queryPlan, chooseRows, fitEvidenceToBudget, DASHBOARD_RESEARCH_SOURCES } = await import('../public/js/research/estate.js');
const ref = { ticker: 'STLTECH', isin: 'INE000000001', name: 'Sterlite Technologies Limited', weightPct: 20 };
const fibre = { ticker: 'FIBRECO', isin: 'INE000000002', name: 'Fibre Company', weightPct: 2 };
const network = { ticker: 'NETWORKCO', isin: 'INE000000003', name: 'Network Company', weightPct: 1 };
const broad = { ticker: 'BANK', isin: 'INE000000004', name: 'Bank Company', weightPct: 70 };
const tiny = { ticker: null, isin: 'INE000000005', name: 'Small Optical Company', weightPct: .01 };
const outside = { ticker: 'OUTSIDE', isin: 'INE000000006', name: 'Outside Company' };
const holdings = [ref, fibre, network, broad, tiny];
const index = [...holdings, outside];
const positions = { sizes: { complete: true, basis: 'workbook' }, holdings };
const options = { scope: 'portfolio', holdings, portfolio: { status: 'ready', mode: 'verified-holdings' }, portfolioPositions: positions, now: '2026-09-07T12:00:00Z' };
const questions = [
  'Which are my ai related stocks and how are they performing after sterlite news?',
  'the benefit that sterlite comparable business which other stocks in my portfolio have got benefit',
  'Which other stocks in my portfolio have comparable businesses and could benefit after Sterlite news?',
];
for (const question of questions) {
  const plan = queryPlan(question, index, options);
  assert(plan.business && plan.crossHolding, question);
  assert.deepEqual(plan.companies.map(c => c.ticker), ['STLTECH']);
  assert.equal(plan.businessHoldings.length, 5);
  assert(plan.businessHoldingsVerified);
}
for (const question of ['Latest news on Sterlite?', 'What is my portfolio value?', 'Why did Sterlite gain today?']) assert.equal(businessIntent(question), null, question);
const themedNames = [{ ticker: 'SOLARINDS', name: 'Solar Industries India' }, { ticker: 'WAAREERTL', name: 'Waaree Renewable Technologies' }];
for (const company of themedNames) {
  const narrow = queryPlan(`What matters most about ${company.name} for my portfolio?`, themedNames, { scope: 'portfolio', holdings: themedNames });
  assert.equal(narrow.business, null, 'issuer-name words must not turn a company question into a peer scan');
  assert.deepEqual([...narrow.tickers], [company.ticker]);
}
const follow = queryPlan('Which other portfolio stocks could benefit?', index, { ...options, history: [{ role: 'user', text: 'Latest Sterlite news?' }] });
assert.deepEqual(follow.companies.map(c => c.ticker), ['STLTECH']);
const switched = queryPlan('Which other portfolio stocks have similar businesses to Network Company?', index, { ...options, history: [{ role: 'user', text: 'Latest Sterlite news?' }] });
assert.deepEqual(switched.companies.map(c => c.ticker), ['NETWORKCO']);
assert.equal(businessIntent('How have they performed?', [{ role: 'user', text: questions[0] }]).theme, 'ai');
const watch = queryPlan(questions[0], index, { ...options, scope: 'watchlist', holdings: [fibre] });
assert.deepEqual(watch.businessHoldings, [fibre]); assert.equal(watch.businessHoldingsVerified, false);
const fallback = queryPlan(questions[0], index, { ...options, portfolioPositions: { ...positions, sizes: { complete: false } }, holdings: [fibre] });
assert.deepEqual(fallback.businessHoldings, holdings, 'unavailable valuations cannot replace the actual position identities with saved coverage');
assert(fallback.businessHoldingsVerified); assert(!fallback.businessWeightsComplete);
assert(!queryPlan(questions[0], index, { ...options, portfolio: { status: 'limited', mode: 'public-snapshot-fixture' } }).businessHoldingsVerified);
const withoutReference = queryPlan(questions[0], index, { ...options, holdings: [fibre], portfolioPositions: { ...positions, holdings: [fibre] } });
assert.equal(withoutReference.companies[0].inScope, false);

const signals = row => businessSignals(row).map(s => s.id);
assert.deepEqual(signals({ ticker: 'AI', company: 'AI Finance', title: 'Results gain 10%', feed: 'AI Alerts', url: 'https://example.test/ai' }), []);
assert.deepEqual(signals({ ticker: 'AIFIN', company: 'AI Finance', title: 'AI Finance announces a dividend' }), []);
assert.deepEqual(signals({ ticker: 'SOLARINDS', company: 'Solar Industries India', title: 'Solar Industries India announces a dividend' }), []);
assert.deepEqual(signals({ ticker: 'SOLARINDS', company: 'Solar Industries India', title: 'Solar Industries India wins a defence order' }), ['defence']);
const genuineAI = businessSignals({ ticker: 'AIFIN', company: 'AI Finance', title: 'AI Finance launches artificial intelligence products' });
assert.equal(genuineAI[0].id, 'ai');
assert.match(genuineAI[0].excerpt, /^AI Finance launches/, 'semantic filtering does not rewrite the source quote');
assert.deepEqual(signals({ ticker: 'BANK', company: 'Bank Company', title: 'Bank Company gains today. Network Company launches 5G networks.' }), []);
assert.deepEqual(signals({ ticker: 'HDFCBANK', company: 'HDFC Bank', title: 'Strongest sectors 🏦 HDFC Bank financial services 📱 Telecom Bharti Airtel 5G 🚙 Auto Tata Motors' }), []);
assert(!signals({ ticker: 'STLTECH', company: ref.name, title: '*Indo-Tech*: Power transformers order. *STLTECH*: Optical fibre capacity expansion.' }).includes('power-equipment'));
assert.deepEqual(signals({ ticker: 'MODEL', company: 'Model Company', title: 'Model Company uses transformer models for language processing' }), []);
assert(signals({ ticker: 'FIBRECO', company: fibre.name, sourceTags: ['Optical fibre capacity expansion'] }).includes('fibre-cabling'));
assert.equal(businessSignals({ industry: 'Cables - Telecom' })[0].basis, 'industry label only');
assert.equal(businessSignals({ ticker: 'FIBRECO', company: fibre.name, title: 'Fibre Company does not manufacture optical fibre cables.' })[0].stance, 'denied-or-limited');
assert.equal(holdingForBusinessRow({ queryTicker: 'FIBRECO', company: fibre.name, attribution: 'uncertain' }, holdings), null);
assert.equal(holdingForBusinessRow({ ticker: 'FIBRE' }, holdings), null);
assert.equal(holdingForBusinessRow({ isin: tiny.isin }, holdings), tiny);
assert.equal(holdingForBusinessRow({ company: tiny.name }, holdings), tiny);
assert.equal(holdingForBusinessRow({ ticker: fibre.ticker, isin: outside.isin }, holdings), null, 'a conflicting ISIN cannot be overridden by its ticker');

const row = (company, detail, more = {}) => ({ ticker: company.ticker, isin: company.isin, company: company.name, date: '2026-09-03',
  attribution: 'confirmed', title: `${company.name}: ${detail}`, url: `https://example.test/${company.isin}`, ...more });
const rows = [
  row(ref, 'Optical fibre capacity expansion for AI demand', { industry: 'Cables - Telecom' }),
  row(fibre, 'Optical fibre orders and telecom network equipment expansion'),
  row(network, '5G network equipment deliveries expand'),
  row(broad, 'AI adoption in banking services'),
  row(tiny, 'Optical fibre production begins'),
  row(outside, 'Optical fibre manufacturing and telecom networks'),
];
const plan = queryPlan(questions[0], index, options);
const selected = chooseRows(rows, plan, r => r);
assert(!selected.rows.some(r => r.ticker === 'OUTSIDE'));
assert(selected.businessReadings.some(r => r.isin === tiny.isin));
assert(!selected.businessReadings.some(r => r.isin === outside.isin));
const narrow = chooseRows(rows, queryPlan('Latest Sterlite news?', index, options), r => r);
assert(narrow.rows.every(r => r.ticker === ref.ticker)); assert(!narrow.businessReadings);
const source = { id: 'company-news', tab: 'News', status: 'ready', dataQuality: 'partial', rowCount: rows.length, ...selected };
const context = portfolioBusinessContext({ plan, packets: [source] });
assert.equal(context.holdingsBasis, 'complete authenticated positions');
assert.equal(context.candidatesFound, 4); assert.equal(context.referenceHoldingsExcluded, 1);
assert(context.candidates.slice(0, 3).every(c => c.ticker !== 'BANK'), 'large AI adopter must not displace product peers');
assert.equal(context.candidates.at(-1).ticker, 'BANK');
assert.match(context.candidates.at(-1).relationship, /Adjacent|broad theme/);
assert.equal(context.candidates[0].weightPct, 2);
assert.equal(context.candidates[0].evidence[0].sourceStatus, 'partial');
assert.equal(context.candidates.find(c => c.isin === tiny.isin).performance.status, 'unavailable');
assert(!context.candidates.some(c => c.ticker === 'STLTECH' || c.ticker === 'OUTSIDE'));
const peerSource = businessPeerSamples([source], context)[0];
assert.equal(peerSource.rows.length, 4);
assert(peerSource.rows.every(r => r.ticker !== ref.ticker && r.ticker !== outside.ticker));
assert.equal(peerSource.rows[0].ticker, fibre.ticker);
assert.equal(peerSource.rowCount, source.rowCount, 'selection does not rewrite source coverage');
assert.equal(peerSource.status, source.status); assert.equal(peerSource.dataQuality, 'partial');
assert.deepEqual(businessPeerSamples([source], { candidates: [] }), [source], 'no discovered peers keeps useful reference evidence');
const disputed = portfolioBusinessContext({ plan, packets: [source, { id: 'telegram', tab: 'Telegram', status: 'ready',
  businessReadings: businessReadings([row(fibre, 'Fibre Company does not manufacture optical fibre cables.', { feed: 'Telegram' })], plan) }] });
assert.match(disputed.candidates.find(c => c.ticker === fibre.ticker).relationship, /Conflicting/);
assert.equal(disputed.candidates.find(c => c.ticker === fibre.ticker).counterEvidence[0].verification, 'unverified discussion');
const deniedOnly = portfolioBusinessContext({ plan, packets: [{ ...source, businessReadings: businessReadings([
  rows[0], row(fibre, 'does not manufacture optical fibre cables.')], plan) }] });
assert.equal(deniedOnly.candidates.length, 0);
assert.equal(businessReadings([row(fibre, 'AI optical fibre', { attribution: 'related' })], plan).length, 0);

for (const limit of [20, 200, 1000, 3000, 6300]) {
  const fitted = fitBusinessContext(context, limit);
  assert(!fitted || JSON.stringify(fitted).length <= limit, `comparison exceeds ${limit}`);
  if (fitted?.candidates) assert.equal(fitted.candidates.length + fitted.candidatesOmitted, context.candidatesFound);
}
const sources = DASHBOARD_RESEARCH_SOURCES.map(s => ({ ...s, status: 'unavailable', error: 'Fixture unavailable', rows: [] }));
sources[sources.findIndex(s => s.id === 'company-news')] = peerSource;
const fitted = fitEvidenceToBudget({ selection: { companies: plan.companies, business: plan.business }, businessContext: context, sources });
assert(researchEvidenceChars(fitted) <= 18000);
assert(fitted.businessContext.candidates.length >= 2);
assert.equal(fitted.sources.length, DASHBOARD_RESEARCH_SOURCES.length);
assert(fitted.sources.some(s => s.rows.length));
assert(fitted.sources.filter(s => s.id !== 'company-news').every(s => s.status === 'unavailable'));
assert.deepEqual(providerEvidence(fitted).businessContext, fitted.businessContext);
assert(JSON.stringify(buildMunsRequest({ question: questions[0], history: [], evidence: fitted, scope: 'portfolio' })).includes('source-backed-business-comparison'));
const preview = researchPreview(fitted);
assert.equal(preview.items[0].ticker, 'FIBRECO');
assert(preview.items.every(p => p.tab === 'News' && !p.title.includes('benefited')));
assert(preview.items.every(p => p.quality === 'partial'));

const price = { bar_date: '2026-09-07', prev_bar_date: '2026-09-01', move_prev_date: '2026-09-04',
  cmp: 90, move_close: 110, pct_change_today: 10, move_check: 'corrected', six_month_return_pct: 99 };
const reading = datedPerformance(price, '2026-09-03');
assert.equal(reading.closeRupees, 110);
assert.deepEqual(reading.latestSession, { from: '2026-09-04', to: '2026-09-07', changePct: 10, verification: 'corrected' });
assert.equal(reading.afterEvent.status, 'unavailable');
assert.equal(datedPerformance({ ...price, bar_date: '2026-09-02' }, '2026-09-03').latestSession, null);
assert.equal(datedPerformance({ ...price, bar_date: '2026-02-30' }).status, 'undated');
assert.equal(datedPerformance({ ...price, move_prev_date: '2026-08-01' }).latestSession, null);
assert.equal(datedPerformance({ ...price, pct_change_today: null }).latestSession, null);
assert.equal(datedPerformance({ ...price, move_close: null }).closeRupees, null);
const history = researchPriceHistory([
  { date: '2026-09-02', close: 200, adjustedClose: 100 }, // Corporate action already accounted for
  { date: '2026-09-03', close: 105, adjustedClose: 105 },
  { date: '2026-09-07', close: 110, adjustedClose: 110 },
], { sourceSymbol: 'FIBRECO.NS', capturedAt: '2026-09-07T12:00:00Z' });
const after = datedPerformance({ ...price, closeHistory: history }, '2026-09-03').afterEvent;
assert.equal(after.status, 'available'); assert.equal(after.changePct, 10);
assert.equal(after.from, '2026-09-02'); assert.equal(after.to, '2026-09-07');
assert.match(after.basis, /not proof of causation/i);
for (const mutation of [retainedPriceHistory(history), { ...history, basis: 'raw-close' },
  { ...history, rows: [...history.rows, history.rows[0]] }, { ...history, rows: history.rows.slice(0, -1) }]) {
  assert.equal(datedPerformance({ ...price, closeHistory: mutation }, '2026-09-03').afterEvent.status, 'unavailable');
}
assert.equal(datedPerformance({ ...price, closeHistory: history }, '2026-09-07').afterEvent.status, 'unavailable');
assert.equal(datedPerformance({ ...price, closeHistory: history }, '2026-02-30').afterEvent.status, 'unavailable');
assert.equal(researchPriceHistory([{ date: '2026-02-30', adjustedClose: 10 }, { date: '2026-03-01', adjustedClose: 10 }]), null);
assert.equal(researchPriceHistory([{ date: '2026-09-01', adjustedClose: 10 }, { date: '2026-09-01', adjustedClose: 11 }]), null);
assert.equal(researchPriceHistory([{ date: '2026-09-01', close: 10 }, { date: '2026-09-02', close: 11 }]), null);
const long = researchPriceHistory(Array.from({ length: 130 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), adjustedClose: 100 + i })));
assert.equal(long.rows.length, 120); assert.match(long.retention, /not an exhaustive/);
assert.equal(retainedPriceHistory(null), null); assert.equal(retainedPriceHistory(history).capturedAt, history.capturedAt);
console.log('PASS portfolio business intent, exact identity, peer discovery, attribution, source budgets, previews, and dated adjusted returns');
