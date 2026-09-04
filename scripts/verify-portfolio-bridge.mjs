import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateResearchBody } from '../worker/research.mjs';
import { validPortfolioReply, validPositionSizes, questionNeedsPortfolio } from '../public/js/research/portfolio-bridge.js';
import { providerEvidenceChars } from '../public/js/research/evidence-shared.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { fitEvidenceToBudget, DASHBOARD_RESEARCH_SOURCES } = await import('../public/js/research/estate.js');
const coverage = await import('../public/js/data/coverage.js');
const reading = { status: 'ready', answer: 'A verified portfolio reading.', bookAsOf: '2026-06-30', checkedAt: new Date().toISOString(), quotes: { freshness: 'partial-or-stale' } };
const holdings = [{ isin: 'INE009A01021', name: 'Example equity', sector: 'Technology', ticker: 'EXAMPLE' }, { isin: 'INF000000001', name: 'Example fund', sector: 'Fund', ticker: null }];
const sizeReply = { sizes: { basis: 'listed-market-value', complete: true, bookAsOf: reading.bookAsOf, checkedAt: reading.checkedAt, archiveVersion: 2 }, holdings: holdings.map(h => ({ ...h, weightPct: 50 })) };
assert.equal(validPositionSizes(sizeReply), true);
assert.equal(validPositionSizes({ ...sizeReply, sizes: { ...sizeReply.sizes, bookAsOf: '2026-02-31' } }), false);
assert.equal(validPositionSizes({ ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: '2020-01-01' } }), false);
assert.equal(validPositionSizes({ ...sizeReply, holdings: [sizeReply.holdings[0], sizeReply.holdings[0]] }), false);
for (const weightPct of [null, -1, Infinity, NaN, 1000, 10]) {
  assert.equal(validPositionSizes({ ...sizeReply, holdings: [{ ...sizeReply.holdings[0], weightPct }, sizeReply.holdings[1]] }), false);
}
assert.equal(validPositionSizes({ ...sizeReply, sizes: { ...sizeReply.sizes, complete: false }, holdings: holdings.map(h => ({ ...h, weightPct: null })) }), true);
assert.equal(validPortfolioReply({ reading, holdings }), true);
assert.equal(validPortfolioReply({ reading: { ...reading, checkedAt: '2020-01-01' }, holdings }), false);
assert.equal(validPortfolioReply({ reading: { ...reading, answer: 'x'.repeat(6001) }, holdings }), false);
assert.equal(validPortfolioReply({ reading, holdings: [{ ...holdings[0], ticker: 'javascript:evil' }] }), false);
assert.equal(questionNeedsPortfolio('Do I have Sterlite in my portfolio?'), true);
assert.equal(questionNeedsPortfolio('What changed at IIFL Finance?'), false);

assert.equal(validateResearchBody({ question: 'What is my biggest position?', evidence: { sources: [] } }).error, 'portfolio_unavailable');
assert.equal(validateResearchBody({ question: 'What is my biggest position?', evidence: { sources: [], portfolio: reading } }).ok, true);
assert.equal(validateResearchBody({ question: 'What changed?', evidence: { sources: [], portfolio: { ...reading, checkedAt: '2020-01-01' } } }).error, 'stale_portfolio');

coverage.prime({ asOf: '2020-01-01', holdings: [{ isin: 'INE009A01021', name: 'old name', ticker: 'OLD' }, { isin: 'INE000000001', name: 'sold', ticker: 'SOLD' }] });
coverage.useFamilyBook(holdings, reading.bookAsOf);
assert.equal(coverage.holdings().length, 2);
assert.equal(coverage.has('SOLD'), false, 'a sold name in the committed coverage list cannot remain owned');
assert.equal(coverage.has('EXAMPLE'), true);
assert.equal(coverage.uncovered().length, 1, 'fund unit is retained, not silently excluded');
assert.equal(coverage.meta().asOf, reading.bookAsOf);
assert.equal(coverage.meta().unlisted, null, 'old reason-bucket counts are not attributed to the active book');

const largeReading = { ...reading, answer: 'x'.repeat(5400) };
const fitted = fitEvidenceToBudget({ portfolio: largeReading, sources: DASHBOARD_RESEARCH_SOURCES.map(s => ({ ...s, status: 'ready', source: 'provider', asOf: '2026-09-04', rowCount: 20, summary: { info: 'a'.repeat(2000) }, rows: Array.from({ length: 20 }, (_, i) => ({ ticker: `STOCK${i}`, value: i })) })) });
assert.deepEqual(fitted.portfolio, largeReading, 'portfolio caveats and figures may not be silently truncated');
assert.ok(providerEvidenceChars(fitted) <= 13000);
assert.ok(fitted.sources.every(s => s.includedRows > 0), 'research rows still receive space alongside the portfolio');

// Drive the real transport without a browser, network, credentials or model.
const listeners = new Set();
const posts = [];
let responder;
const parent = { postMessage(message, origin) { posts.push({ message, origin }); queueMicrotask(() => responder?.(message)); } };
globalThis.window = { parent, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
globalThis.document = { referrer: 'https://sattva-family.pages.dev/research' };
globalThis.location = { origin: 'https://sattva-central-research.tech-441.workers.dev' };
const bridge = await import('../public/js/research/portfolio-bridge.js?transport');
const emit = (message, origin = 'https://sattva-family.pages.dev', source = parent) => { for (const fn of [...listeners]) fn({ origin, source, data: message }); };
responder = m => {
  emit({ ...m, type: 'ready' }, 'https://evil.example');
  emit({ ...m, type: 'ready' }, undefined, {});
  emit({ ...m, type: 'ready', capabilities: ['position-sizes'] });
};
assert.equal(await bridge.connectPortfolio(), true);
assert.equal(listeners.size, 1, 'only the lifetime archive-change listener remains');
let invalidated = null;
bridge.onPortfolioInvalidation(version => { invalidated = version; });
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'invalidated', version: 2 }, 'https://evil.example');
assert.equal(invalidated, null);
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'invalidated', version: 2 });
assert.equal(invalidated, 2);
let readyVersion = null;
bridge.onPortfolioReady(version => { readyVersion = version; });
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'positions-ready', version: 2 }, 'https://evil.example');
assert.equal(readyVersion, null);
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'positions-ready', version: 2 });
assert.equal(readyVersion, 2);
assert.equal(invalidated, 2, 'a ready notification does not invalidate the book again');
responder = m => emit({ ...m, type: 'result', reading: { ...reading, checkedAt: new Date().toISOString() }, holdings });
assert.deepEqual((await bridge.readPortfolio('Do I own Example?')).holdings, holdings);
responder = m => emit({ ...m, type: 'result', ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: new Date().toISOString() } });
assert.equal((await bridge.readPositionSizes()).holdings[0].weightPct, 50);
assert.equal(posts.at(-1).message.type, 'positions');
assert.equal(posts.at(-1).message.question, undefined, 'position sizing does not invoke a model question');
responder = m => emit({ ...m, type: 'result', reading: { ...reading, checkedAt: '2020-01-01' }, holdings });
await assert.rejects(bridge.readPortfolio('Do I own Example?'), /stale or invalid/);
responder = undefined;
const ctrl = new AbortController();
const pending = bridge.readPortfolio('Do I own Example?', ctrl.signal);
ctrl.abort();
await assert.rejects(pending, /Cancelled/);
assert.equal(posts.at(-1).message.type, 'cancel');
assert.ok(posts.every(p => p.origin === 'https://sattva-family.pages.dev'));
assert.equal(listeners.size, 1);

const source = readFileSync(new URL('../public/js/tabs/ask-research.js', import.meta.url), 'utf8');
assert.match(source, /filter\(\(session\) => !session.private\)/, 'private conversations never enter standalone localStorage');
assert.match(source, /generation\.portfolio/);
console.log('Portfolio bridge: transport, privacy, ownership, freshness, refusal and evidence-budget checks passed.');
