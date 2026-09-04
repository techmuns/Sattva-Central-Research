import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateResearchBody } from '../worker/research.mjs';
import { validPortfolioReply, validPositionSizes, questionNeedsPortfolio } from '../public/js/research/portfolio-bridge.js';
import { providerEvidenceChars, researchEvidenceChars, providerEvidence } from '../public/js/research/evidence-shared.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { fitEvidenceToBudget, DASHBOARD_RESEARCH_SOURCES } = await import('../public/js/research/estate.js');
const coverage = await import('../public/js/data/coverage.js');
const reading = { status: 'ready', answer: 'A verified portfolio reading.', bookAsOf: '2026-06-30', checkedAt: new Date().toISOString(), archiveVersion: 2, quotes: { freshness: 'partial-or-stale' } };
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
const fitted = fitEvidenceToBudget({ portfolio: largeReading, portfolioPositions: sizeReply, sources: DASHBOARD_RESEARCH_SOURCES.map(s => ({ ...s, status: 'ready', source: 'provider', asOf: '2026-09-04', rowCount: 20, summary: { info: 'a'.repeat(2000) }, rows: Array.from({ length: 20 }, (_, i) => ({ ticker: `STOCK${i}`, value: i })) })) });
assert.deepEqual(fitted.portfolio, largeReading, 'portfolio caveats and figures may not be silently truncated');
assert.ok(researchEvidenceChars(fitted) <= 13000);
assert.deepEqual(providerEvidence(fitted).portfolioPositions, sizeReply);
assert.ok(providerEvidenceChars(fitted) > researchEvidenceChars(fitted));
assert.equal(validateResearchBody({ question: 'What changed?', requirePortfolio: true, evidence: { sources: [], portfolio: reading } }).error, 'invalid_portfolio_positions');
assert.equal(validateResearchBody({ question: 'What changed?', requirePortfolio: true, evidence: { sources: [], portfolio: reading, portfolioPositions: sizeReply } }).ok, true);
assert.equal(validateResearchBody({ question: 'What changed?', requirePortfolio: true, evidence: { sources: [], portfolio: reading, portfolioPositions: { ...sizeReply, sizes: { ...sizeReply.sizes, archiveVersion: 8 } } } }).error, 'invalid_portfolio_positions');
assert.ok(fitted.sources.every(s => s.includedRows > 0), 'research rows still receive space alongside the portfolio');

// Drive the real transport without a browser, network, credentials or model.
const listeners = new Set();
const posts = [];
let responder;
const parent = { postMessage(message, origin) { posts.push({ message, origin }); queueMicrotask(() => responder?.(message)); } };
globalThis.window = { parent, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
const elements = [];
globalThis.document = {
  referrer: '', body: { appendChild() {} },
  createElement(tag) { const e = { tag, contentWindow: tag === 'iframe' ? parent : null, append() {}, setAttribute() {}, close() { this.open = false; }, showModal() { this.open = true; } }; elements.push(e); return e; },
};
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
assert.equal(elements.find(e => e.tag === 'iframe').src, 'https://sattva-family.pages.dev/research-bridge');
assert.ok(!elements.find(e => e.tag === 'dialog').open, 'data connection stays invisible');
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
responder = m => emit({ ...m, type: 'result', reading: { ...reading, checkedAt: new Date().toISOString() }, ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: new Date().toISOString() } });
assert.deepEqual((await bridge.readPortfolio('Do I own Example?')).holdings, sizeReply.holdings);
responder = m => emit({ ...m, type: 'result', ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: new Date().toISOString() } });
assert.equal((await bridge.readPositionSizes()).holdings[0].weightPct, 50);
assert.equal(posts.at(-1).message.type, 'positions');
assert.equal(posts.at(-1).message.question, undefined, 'position sizing does not invoke a model question');
responder = m => emit({ ...m, type: 'result', reading: { ...reading, checkedAt: '2020-01-01' }, holdings });
await assert.rejects(bridge.readPortfolio('Do I own Example?'), /stale or invalid/);
assert.equal(bridge.portfolioConnectionState(), 'unavailable', 'a rejected reading revokes the connected badge');
assert.equal(bridge.portfolioConnected(), false);
assert.notEqual(coverage.meta().syncStatus, 'family-session');
assert.deepEqual(coverage.holdings().map(h => h.isin), sizeReply.holdings.map(h => h.isin), 'failed checks retain the verified identities instead of reverting to the public snapshot');
assert.match(coverage.syncLabel(), /temporarily unavailable.*last verified holdings/);
assert.equal(await bridge.connectPortfolio(), true, 'the transport can still be available after a data failure');
assert.equal(bridge.portfolioConnected(), false, 'a handshake alone cannot certify recovery');
responder = m => emit({ ...m, type: 'ready', capabilities: ['position-sizes'] });
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'available' });
await bridge.connectPortfolio();
assert.equal(bridge.portfolioConnected(), false, 'a reloaded peer must also pass a holdings read before recovery');

responder = m => emit({ ...m, type: 'error', message: 'Fixture workbook unavailable' });
await assert.rejects(bridge.readPositionSizes(), /Fixture workbook unavailable/);
assert.equal(bridge.portfolioConnectionState(), 'unavailable', 'background failures keep the warning visible');

responder = () => {};
const realSetTimeout = globalThis.setTimeout;
try {
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 90_000 ? 0 : ms, ...args);
  await assert.rejects(bridge.readPositionSizes(), /did not answer in time/);
} finally { globalThis.setTimeout = realSetTimeout; }
assert.equal(bridge.portfolioConnectionState(), 'unavailable', 'timed-out reads cannot restore the badge');

const recovered = [];
const offRecovery = bridge.onPortfolioConnection(value => recovered.push(value));
responder = m => emit({ ...m, type: 'result', ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: new Date().toISOString() } });
await bridge.readPositionSizes();
assert.equal(bridge.portfolioConnected(), true, 'a validated positions read restores the badge');
assert.equal(coverage.meta().syncStatus, 'family-session');
await bridge.readPositionSizes();
assert.deepEqual(recovered, [true], 'unchanged healthy reads do not trigger extra connection refreshes');
offRecovery();
const beforeAbort = posts.length;
const ctrl = new AbortController();
const pending = bridge.readPortfolio('Do I own Example?', ctrl.signal);
ctrl.abort();
await assert.rejects(pending, /Cancelled/);
assert.equal(bridge.portfolioConnected(), true, 'cancelling a queued question is not a connection failure');
assert.equal(posts.length, beforeAbort, 'a cancelled queued question never starts a private read');
assert.ok(posts.every(p => p.origin === 'https://sattva-family.pages.dev'));
assert.equal(listeners.size, 1);

let inFlight = 0, peak = 0, positionReads = 0;
responder = m => {
  inFlight++; peak = Math.max(peak, inFlight);
  if (m.type === 'positions') positionReads++;
  setTimeout(() => {
    inFlight--;
    emit({ ...m, type: 'result', reading: { ...reading, checkedAt: new Date().toISOString() },
      ...sizeReply, sizes: { ...sizeReply.sizes, checkedAt: new Date().toISOString() } });
  }, 10);
};
const consumer = new AbortController();
const discarded = bridge.readPositionSizes(consumer.signal, { force: true });
const shared = bridge.readPositionSizes(undefined, { force: true });
const question = bridge.readPortfolio('What changed?');
consumer.abort();
await assert.rejects(discarded, /Cancelled/);
await Promise.all([shared, question]);
assert.equal(peak, 1, 'background, alerts and questions never compete for the Family reader');
assert.equal(positionReads, 1, 'concurrent scope and alert reads share one positions request');
assert.equal(coverage.has('EXAMPLE'), true, 'validated replies update the shared dashboard book');
emit({ channel: bridge.PORTFOLIO_CHANNEL, type: 'invalidated', version: 3 });
assert.equal(coverage.has('EXAMPLE'), true, 'rechecking does not flash an older fallback book');
assert.equal(coverage.meta().syncStatus, 'family-checking');

let readStarted, cancelAcknowledged = false;
const started = new Promise(resolve => { readStarted = resolve; });
responder = m => {
  if (m.type === 'read') { readStarted(); return; }
  if (m.type === 'cancel') { setTimeout(() => { cancelAcknowledged = true; emit({ ...m, type: 'error', message: 'Cancelled' }); }, 20); return; }
  assert.equal(cancelAcknowledged, true, 'next read waits for cancellation acknowledgement');
  emit({ ...m, type:'result', ...sizeReply, sizes:{ ...sizeReply.sizes, checkedAt:new Date().toISOString() } });
};
const abortRunning = new AbortController();
const runningQuestion = bridge.readPortfolio('Cancel this reading', abortRunning.signal);
await started; abortRunning.abort();
await assert.rejects(runningQuestion, /Cancelled/);
assert.equal(posts.at(-1).message.type, 'cancel');
await bridge.readPositionSizes();
assert.equal(bridge.portfolioConnected(), true, 'cancelling an active question is not a connection failure');

responder = m => emit({ ...m, type: 'auth-required' });
await assert.rejects(bridge.readPortfolio('What changed?'), /Unlock/);
assert.equal(bridge.portfolioConnectionState(), 'locked', 'read failure must preserve the sign-in state');
responder = m => emit({ ...m, type: 'ready', capabilities: ['position-sizes'] });
await bridge.connectPortfolio();

emit({ channel: bridge.PORTFOLIO_CHANNEL, id: 'connector', type: 'auth-required' }, 'https://evil.example');
assert.equal(bridge.portfolioConnected(), true);
emit({ channel: bridge.PORTFOLIO_CHANNEL, id: 'connector', type: 'auth-required' });
assert.equal(bridge.portfolioConnectionState(), 'locked');
assert.equal(bridge.portfolioConnected(), false);
bridge.unlockPortfolio();
assert.equal(elements.find(e => e.tag === 'dialog').open, true);
responder = m => emit({ ...m, type: 'ready', capabilities: ['position-sizes', 'portfolio-context'] });
assert.equal(await bridge.connectPortfolio(), true);
assert.equal(elements.find(e => e.tag === 'dialog').open, false, 'successful sign-in closes the dialog');

const source = readFileSync(new URL('../public/js/tabs/ask-research.js', import.meta.url), 'utf8');
assert.match(source, /filter\(\(session\) => !session.private\)/, 'private conversations never enter standalone localStorage');
assert.match(source, /generation\.portfolio/);
console.log('Portfolio bridge: transport, privacy, ownership, freshness, refusal and evidence-budget checks passed.');
