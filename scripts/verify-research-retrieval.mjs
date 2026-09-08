#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PORTFOLIO_QUESTIONS, researchQuestionBank } from './lib/research-questions.mjs';
import { matchesCapturedNews } from './lib/research-news-oracle.mjs';
import { buildMunsRequest, handleResearch } from '../worker/research.mjs';
import { providerPositions } from '../public/js/research/evidence-shared.js';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { queryPlan, chooseRows, fitEvidenceToBudget, withResearchDeadline } = await import('../public/js/research/estate.js');
const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
const cases = researchQuestionBank(book.holdings);
const index = book.holdings;
let questionsChecked = 0;
for (const test of cases) {
  const plan = queryPlan(test.question, index, { scope: 'portfolio', holdings: book.holdings });
  assert(test.ticker ? plan.tickers.has(test.ticker) : plan.isins.has(test.id.split(':')[0]), `${test.category}: ${test.company} must retain its identity`);
  questionsChecked++;
}
assert.equal(cases.length, book.holdings.length * 14);
assert.equal(new Set(cases.map(c => c.id)).size, cases.length, 'every case is unique including unknown symbols');
assert(cases.some(c => c.ticker === null));

const ambiguousIndex = [...index, { ticker: 'BIRLACORPN', name: 'Birla Corporation' }];
assert.deepEqual(queryPlan('Latest on Aditya Birla Capital?', ambiguousIndex).companies.map(c => c.ticker), ['ABCAPITAL']);
const demerged = queryPlan('Latest on Vedanta Iron and Steel?', index, { scope: 'portfolio', holdings: index });
assert.equal(demerged.companies.length, 1);
assert.equal(demerged.companies[0].isin, 'INE1CLE01013');
assert.equal(demerged.companies[0].inScope, true);
const misleading = [
  { ticker: 'OTHER', company: 'Allcargo Logistics', title: 'earnings order revenue profit expansion refinancing' },
  { ticker: null, queryTicker: 'ALLCARGO', queryCompany: 'Allcargo Logistics', attribution: 'uncertain', title: 'earnings order revenue profit expansion refinancing' },
  { ticker: 'ALLCARGO', company: 'Allcargo Logistics', attribution: 'confirmed', title: 'Actual company disclosure' },
];
const exact = chooseRows(misleading, { tickers: new Set(['ALLCARGO']), names: ['allcargo logistics'], tokens: ['earnings', 'order', 'revenue', 'profit', 'expansion', 'refinancing'] }, r => r);
assert.equal(exact.companyRows, 1, 'keywords and query metadata cannot create company attribution');
assert.equal(exact.rows[0].title, 'Actual company disclosure', 'confirmed company evidence precedes uncertain search results');
assert(!exact.rows.some(r => r.ticker === 'OTHER'), 'an unrelated issuer is not fallback evidence for a company question');
assert(exact.rows.some(r => r.attribution === 'uncertain'), 'possible coverage for the requested issuer retains its uncertainty label');
const latestPlan = queryPlan('any new updates on jayaswal neco?', index);
assert.deepEqual(latestPlan.tokens, [], 'generic latest-update vocabulary cannot promote a stock quote page');
const newsRanking = chooseRows([
  { ticker: 'JAYNECOIND', recordType: 'reference-page', date: '2026-09-06', title: 'Share Price, Stock Price' },
  { ticker: 'JAYNECOIND', date: '2026-09-04', title: 'Company statement on financial impact' },
], latestPlan, r => r, (a, b) => b.date.localeCompare(a.date));
assert.equal(newsRanking.rows[0].title, 'Company statement on financial impact', 'dated developments precede generic reference pages');
// Exact Sept 7 CI regression: the captured ET title had two spaces before Market;
// the provider-facing literal title safely collapses whitespace. This is not lost news.
const capturedLatest = { ticker: 'ADANIENT', company: 'Adani Enterprises', date: '2026-09-07', title: 'Adani Ent Share Price Live Updates: Adani Enterprises  Market Performance Snapshot',
  url: 'https://economictimes.indiatimes.com/markets/stocks/stock-liveblog/adani-ent-stock-price-live-updates-07-sep-2026/liveblog/133860680.cms' };
const includedLatest = { ...capturedLatest, attribution: 'confirmed', title: capturedLatest.title.replace(/\s+/g, ' ') };
assert(matchesCapturedNews(includedLatest, capturedLatest), 'literal whitespace normalization does not create a missing-news false positive');
assert(!matchesCapturedNews({ ...includedLatest, title: 'Adani Ent Share Price Live Updates: Adani Enterprises…' }, capturedLatest), 'a matching URL cannot justify truncating a headline below its actual budget');
assert(!matchesCapturedNews({ ...includedLatest, title: 'A…' }, capturedLatest), 'a matching URL cannot turn a near-empty headline into retrieved evidence');
assert(matchesCapturedNews({ ...includedLatest, url: null }, { ...capturedLatest, url: null }), 'URL-less retained articles use the normalized literal headline');
for (const change of [{ attribution: 'uncertain' }, { ticker: 'OTHER' }, { ticker: null }, { date: '2026-09-06' }, { title: 'Different company development' },
  { title: '' },
  { title: 'Adani Ent Share Price' }, { title: '…' }, { url: 'https://example.test/another-story' }, { url: null }])
  assert(!matchesCapturedNews({ ...includedLatest, ...change }, capturedLatest), 'wrong attribution, date, article, or non-literal title cannot satisfy newest-news coverage');
assert(matchesCapturedNews({ ...includedLatest, ticker: null }, { ...capturedLatest, ticker: null }), 'tickerless captured issuer is matched by its exact company identity');
assert(!matchesCapturedNews({ ...includedLatest, ticker: null, company: 'Other company' }, { ...capturedLatest, ticker: null }), 'a shared article URL cannot substitute a different tickerless issuer');
assert(matchesCapturedNews({ ...includedLatest, ticker: null, isin: 'INE423A01024', company: 'Clipped name…' }, { ...capturedLatest, ticker: null, isin: 'INE423A01024' }), 'stable ISIN identifies tickerless issuers without relying on display-name clipping');
assert(!matchesCapturedNews({ ...includedLatest, ticker: null, isin: 'OTHER' }, { ...capturedLatest, ticker: null, isin: 'INE423A01024' }), 'a different stable ISIN cannot share a latest-news match');
assert(!matchesCapturedNews({ ...includedLatest, title: 'A…', url: null }, { ...capturedLatest, url: null }), 'a near-empty URL-less prefix cannot identify an article');
const longTitle = 'Literal captured company development '.repeat(16);
assert(matchesCapturedNews({ ...includedLatest, title: `${longTitle.slice(0, 419)}…`, url: null }, { ...capturedLatest, title: longTitle, url: null }), 'URL-less fallback supports the actual 420-character headline boundary');
assert(matchesCapturedNews({ ...includedLatest, title: `${longTitle.slice(0, 419)}…` }, { ...capturedLatest, title: longTitle }), 'URL-backed articles support the actual 420-character headline boundary');
assert(!matchesCapturedNews({ ...includedLatest, title: `${longTitle.slice(0, 418)}…` }, { ...capturedLatest, title: longTitle }), 'URL-backed clipping one character before the actual boundary is rejected');
assert(!matchesCapturedNews({ ...includedLatest, title: `${longTitle.slice(0, 419)}…` }, { ...capturedLatest, title: longTitle.slice(0, 420) }), 'an exactly 420-character source title must not be truncated');
const noCompanyRows = chooseRows([{ ticker: 'OTHER', title: 'Latest material news' }], latestPlan, r => r);
assert.equal(noCompanyRows.companyRows, 0);
assert.deepEqual(noCompanyRows.rows, []);
assert.equal(fitEvidenceToBudget({ sources: [{ id: 'news', ...noCompanyRows }] }).sources[0].companyRows, 0, 'zero retrieved matches remains explicit, without asserting no events');

const companies = [
  { isin: 'INE000000001', ticker: 'BIG', name: 'Big Company', sector: 'Steel', weightPct: 80 },
  { isin: 'INE000000002', ticker: 'SMALL', name: 'Small Company', sector: 'Steel', weightPct: 19 },
  { isin: 'INF000000001', ticker: null, name: 'Unresolved Fund', sector: 'Fund', weightPct: 1 },
];
const positions = { sizes: { complete: true, basis: 'listed-market-value' }, holdings: companies };
const ranked = researchQuestionBank(companies, { complete: true });
assert.equal(ranked[0].company, 'Big Company');
assert.equal(ranked.at(-1).company, 'Unresolved Fund');
assert(!JSON.stringify(ranked).includes('weightPct'));
const follow = queryPlan('And what are its risks?', companies, { history: [{ role: 'user', text: 'Latest info on Big Company?' }] });
assert(follow.tickers.has('BIG'));
const next = queryPlan('What about Small Company?', companies, { history: [{ role: 'user', text: 'Latest info on Big Company?' }] });
assert(next.tickers.has('SMALL') && !next.tickers.has('BIG'));
assert.equal(queryPlan('What about my portfolio overall?', companies, { history: [{ role: 'user', text: 'Latest info on Big Company?' }] }).tickers.size, 0, 'a portfolio-wide question does not inherit a single issuer');
assert(queryPlan('How does it affect my other holdings?', companies, { history: [{ role: 'user', text: 'Latest info on Big Company?' }] }).tickers.has('BIG'), 'a cross-holding impact question retains its explicit pronoun reference');
const smaller = queryPlan('What changed in my smallest 2 holdings?', companies, { portfolioPositions: positions, holdings: companies });
assert.deepEqual([...smaller.tickers], ['SMALL'], 'unmapped smallest fund is not silently replaced with BIG');
assert.deepEqual([...queryPlan('Latest news on my largest holding?', companies, { portfolioPositions: positions, holdings: companies }).tickers], ['BIG']);
assert.deepEqual([...queryPlan('Compare my largest holding with my smallest holding', companies, { portfolioPositions: positions, holdings: companies }).tickers], ['BIG'], 'largest and smallest are both selected before the unresolved-fund coverage check');
assert.equal(queryPlan('My top 2 holdings?', companies, { portfolioPositions: { ...positions, sizes: { complete: false } } }).companies.length, 0, 'incomplete prices cannot invent a weight ranking');

const comparison = queryPlan('Compare Big Company and Small Company', companies);
const selected = chooseRows([...Array.from({ length: 100 }, (_, i) => ({ ticker: 'BIG', detail: `Item ${i}` })), { ticker: 'SMALL', detail: 'Small holding evidence' }], comparison, row => row);
assert.deepEqual(selected.rows.slice(0, 2).map(row => row.ticker), ['BIG', 'SMALL'], 'dominant issuer cannot crowd a small holding out of comparisons');
const unresolvedComparison = queryPlan('Compare Big Company and Unresolved Fund', companies);
const mixedRows = chooseRows([...Array.from({ length: 50 }, (_, i) => ({ ticker: 'BIG', detail: `Item ${i}` })), { isin: 'INF000000001', company: 'Unresolved Fund', detail: 'Unresolved issuer evidence' }], unresolvedComparison, r => r);
assert.equal(mixedRows.rows[1].isin, 'INF000000001', 'tickerless holdings also receive a fair turn');
const budget = fitEvidenceToBudget({ sources: [{ id: 'news', tab: 'News', status: 'ready', ...selected }] }, 2000);
assert(budget.sources[0].rows.some(row => row.ticker === 'SMALL'));

const compressed = providerPositions(positions);
assert.deepEqual(compressed.holdings.map(row => Object.fromEntries(compressed.columns.map((column, i) => [column, row[i]]))), companies, 'compact prompt preserves every identity, weight and unknown symbol');
const input = { question: 'Brief my portfolio', history: [], scope: 'portfolio', evidence: { sources: [{ rows: [{ text: 'x'.repeat(21_000) }] }] } };
assert.equal(buildMunsRequest(input).llm_type, 'hosted_llm', 'large full-book prompts avoid the small model context limit');
assert.equal(buildMunsRequest({ ...input, evidence: {} }).llm_type, 'local_llm');

const abort = new AbortController();
const never = new Promise(() => {});
const waiting = withResearchDeadline(never, 'Fixture', { signal: abort.signal, timeoutMs: 5000 });
abort.abort();
await assert.rejects(waiting, { name: 'AbortError' });
const deadlineStart = performance.now();
await assert.rejects(withResearchDeadline(never, 'Slow feed', { timeoutMs: 20 }), /still updating/);
assert(performance.now() - deadlineStart < 1000);

const originalFetch = globalThis.fetch;
const req = () => new Request('https://dashboard.example/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Latest news?', evidence: { sources: [] } }) });
try {
  let cancelled = false;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => { cancelled = true; controller.error(new DOMException('Cancelled', 'AbortError')); });
    },
  }));
  const response = await handleResearch(req(), { MUNS_TOKEN: 'fixture-only-token-value' });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true, 'stopping downstream cancels upstream inference');
  globalThis.fetch = async () => new Response('x'.repeat(64_001));
  const malformed = await handleResearch(req(), { MUNS_TOKEN: 'fixture-only-token-value' });
  const malformedEvents = (await malformed.text()).trim().split('\n').map(JSON.parse);
  assert(malformedEvents.some(e => e.type === 'error' && /oversized/.test(e.message)));
  assert(!malformedEvents.some(e => e.type === 'done'));
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(JSON.stringify({ text: '<research-answer>\n₹ steel</research-answer>' }) + '\n');
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }));
  const fragmented = await handleResearch(req(), { MUNS_TOKEN: 'fixture-only-token-value' });
  const events = (await fragmented.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events.find(e => e.type === 'text')?.text, '₹ steel');
  assert.equal(events.at(-1).type, 'done');
} finally { globalThis.fetch = originalFetch; }
console.log(`PASS: ${questionsChecked} named-company retrieval cases; ${cases.length + PORTFOLIO_QUESTIONS.length} generated questions; weight ranking, comparisons, follow-ups, complete compact context, model routing, deadlines, cancellation and fragmented streams.`);
