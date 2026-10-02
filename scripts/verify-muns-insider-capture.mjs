import assert from 'node:assert/strict';
import { captureMunsInsiders, insiderCaptureCompanies, insiderAlternates, insiderCaptureHealth } from './lib/muns-insider-capture.mjs';
import { emptyExchangeSnapshot } from './lib/exchange-deals.mjs';
import { combineExchangeDeals, insiderSummary, validateExchangeSnapshot } from '../public/js/data/exchange-deals-shared.js';

const at = Date.parse('2026-09-10T04:00:00Z');
const row = (date, person) => ({ ticker: 'HELD', date, cells: { Insider: person, Transaction: 'Acquisition', 'Trade Shares': '100', Source: 'BSE' } });
const old = row('2025-07-01', 'Retained old disclosure'), latest = row('2026-09-09', 'New disclosure');
const prior = { targetTickers: ['HELD', 'OTHER', 'FAILED'], byTicker: {
  HELD: { checkedAt: '2026-09-09T12:00:00Z', lastSuccessAt: '2026-09-09T12:00:00Z', from: '2025-07-01', trades: [old] },
  OTHER: { checkedAt: '2026-09-08T12:00:00Z', lastSuccessAt: '2026-09-08T12:00:00Z', trades: [] },
  FAILED: { checkedAt: '2026-09-10T03:00:00Z', error: 'Prior outage', trades: [] },
} };
const calls = [], checkpoints = [];
const companies = [{ ticker: 'OTHER' }, { ticker: 'FAILED' }, { ticker: 'HELD', priority: true }, { ticker: 'NEW', priority: true }];
const next = await captureMunsInsiders(prior, companies, { now: () => at, gapMs: 0,
  request: async (ticker, from, to) => {
    calls.push({ ticker, from, to });
    if (ticker === 'FAILED') throw new Error('Test outage');
    return { ok: true, trades: ticker === 'HELD' ? [latest, { ...latest, raw: 'must not be saved' }] : [] };
  }, checkpoint: state => checkpoints.push(structuredClone(state)),
});
assert.deepEqual(calls.slice(0, 2).map(c => c.ticker).sort(), ['HELD', 'NEW'], 'due/new Sattva holdings are checked first');
assert.equal(calls.find(c => c.ticker === 'HELD').from, '2026-09-02', 'late disclosures overlap the last successful read');
assert.equal(calls.find(c => c.ticker === 'NEW').from, '2025-09-10', 'first check requests a year');
assert.equal(next.byTicker.HELD.trades.length, 2, 'history retained beyond display window and repeat arrivals deduplicated');
assert(next.byTicker.HELD.trades.every(r => !('raw' in r)));
assert.equal(next.byTicker.FAILED.lastSuccessAt, undefined, 'a failed attempt cannot become a successful check');
assert.equal(next.byTicker.OTHER.lastSuccessAt, new Date(at).toISOString(), 'verified empty still advances that company');
assert.equal(checkpoints.length, 4, 'each completed answer checkpoints independently');
const targets = companies.map(c => c.ticker).sort();
assert.deepEqual(next.targetTickers, targets, 'completed and failed companies remain in the full capture target manifest');
for (const checkpoint of checkpoints) assert.deepEqual(checkpoint.targetTickers, targets, 'every checkpoint retains the full target manifest while workers consume the queue');
assert.equal(prior.byTicker.HELD.trades.length, 1, 'prior checkpoint is not mutated');

let clock = at, boundedCalls = 0;
const boundedCompanies = [...companies, { ticker: 'LATER' }];
const bounded = await captureMunsInsiders(prior, boundedCompanies, { now: () => clock, budgetMs: 1000, gapMs: 0,
  request: async () => { boundedCalls++; clock += 1000; return { trades: [] }; },
});
assert.equal(boundedCalls, 1, 'the budget stops further source requests');
assert.deepEqual(bounded.targetTickers, boundedCompanies.map(c => c.ticker).sort(), 'budget expiry retains completed, reserved and still-queued company targets');
assert.equal(bounded.byTicker.LATER, undefined, 'unattempted targets remain unchecked');
assert.deepEqual(bounded.byTicker.HELD.trades, prior.byTicker.HELD.trades, 'budget expiry preserves prior history');
assert.match(insiderSummary({ insiders: bounded }, undefined, at), /3\/5 companies checked/, 'coverage uses the full intended universe after a partial run');
assert.match(insiderSummary({ insiders: bounded }, undefined, at), /2 unchecked/);

const failedHeld = await captureMunsInsiders(next, [{ ticker: 'HELD' }], { now: () => at + 3600000, gapMs: 0, request: async () => ({ ok: false, reason: 'upstream', message: 'Unavailable' }) });
assert.deepEqual(failedHeld.byTicker.HELD.trades, next.byTicker.HELD.trades);
assert.equal(failedHeld.byTicker.HELD.lastSuccessAt, next.byTicker.HELD.lastSuccessAt);
const recovered = await captureMunsInsiders(failedHeld, [{ ticker: 'HELD' }], { now: () => at + 7200000, gapMs: 0, request: async () => ({ trades: [] }) });
assert.equal(recovered.byTicker.HELD.error, null);
assert.equal(recovered.byTicker.HELD.trades.length, 2, 'empty recovery retains historical events');

const exchange = { ...emptyExchangeSnapshot(new Date(at).toISOString()), insiders: next };
validateExchangeSnapshot(exchange);
const joined = combineExchangeDeals([latest], exchange);
assert.equal(joined.length, 2, 'Muns supplement and retained Screener/Muns rows reconcile once');
assert.match(insiderSummary({ insiders: failedHeld }, ['HELD'], at), /1 failed/);
assert.match(insiderSummary(exchange, ['UNSEEN'], at), /1 unchecked/);
assert.match(insiderSummary(exchange, ['HELD'], at + 5 * 3600000), /delayed/);
assert.match(insiderSummary(exchange, undefined, at), /3\/4 companies checked/, 'completed runs include all successful targets in universe coverage');
assert.match(insiderSummary(exchange, undefined, at), /1 failed/, 'a failed target cannot disappear from universe status');
assert.throws(() => validateExchangeSnapshot({ ...exchange, insiders: { targetTickers: [], byTicker: { X: {} } } }), /checkpoint/);
assert.deepEqual(insiderCaptureCompanies([{ ticker: 'HELD', priority: true }], { byTicker: { UNIVERSE: [], HELD: [] } }, exchange).map(c => [c.ticker, !!c.priority]), [['HELD', true], ['UNIVERSE', false]]);

// The source answers HTTP 500 for some companies under one identifier and not another (HEG by NSE
// symbol, measured 2 October 2026), and for a few under every identifier. Neither may hold the run
// red for ever; an outage, a refused credential and a failure retries cannot clear still must.
const refusal = { ok: false, reason: 'upstream', status: 500, message: 'The insider-trades API answered HTTP 500.' };
const hegRow = { date: '2026-09-30', cells: { Insider: 'Director', Transaction: 'Acquisition', 'Trade Shares': '3000' } };
const alternates = insiderAlternates({ 509631: { ticker: 'HEG' }, 540565: { ticker: 'INDIGRID' }, 500143: { ticker: '500143' } });
assert.deepEqual(alternates('HEG', { ticker: 'HEG' }), ['509631']);
assert.deepEqual(alternates('509631', { ticker: '509631' }), ['HEG']);
assert.deepEqual(alternates('500143', {}), [], 'a BSE-only code has no symbol to fall back to');
assert.deepEqual(alternates('RELIANCE', { bseCode: '500325' }), ['500325']);
const ambiguous = insiderAlternates({ 111111: { ticker: 'TWIN' }, 222222: { ticker: 'TWIN' } });
assert.deepEqual(ambiguous('TWIN', {}), [], 'a symbol shared by two scrip codes names neither');

const hegCalls = [];
const viaCode = await captureMunsInsiders({ targetTickers: [], byTicker: {} }, [{ ticker: 'HEG' }], { now: () => at, gapMs: 0, alternates,
  request: async (id) => { hegCalls.push(id); return id === '509631' ? { ok: true, trades: [hegRow] } : refusal; } });
assert.deepEqual(hegCalls, ['HEG', '509631'], 'a refused symbol is asked again under its BSE code');
assert.equal(viaCode.byTicker.HEG.error, null);
assert.equal(viaCode.byTicker.HEG.via, '509631');
assert.equal(viaCode.byTicker.HEG.trades[0].ticker, 'HEG', 'rows stay filed under the company the dashboard knows');
hegCalls.length = 0;
await captureMunsInsiders(viaCode, [{ ticker: 'HEG' }], { now: () => at + 3 * 3600000, gapMs: 0, alternates,
  request: async (id) => { hegCalls.push(id); return { ok: true, trades: [] }; } });
assert.deepEqual(hegCalls, ['509631'], 'the identifier that answered is asked first next time');

const timeoutCalls = [];
const timedOut = await captureMunsInsiders({ targetTickers: [], byTicker: {} }, [{ ticker: 'HEG' }], { now: () => at, gapMs: 0, alternates,
  request: async (id) => { timeoutCalls.push(id); return { ok: false, reason: 'timeout', message: 'The insider-trades API did not answer within 20s.' }; } });
assert.deepEqual(timeoutCalls, ['HEG'], 'a timeout is not a refusal: no other identifier is spent on it');
assert.equal(timedOut.byTicker.HEG.errorKind, 'transient');
const halfRefused = await captureMunsInsiders({ targetTickers: [], byTicker: {} }, [{ ticker: 'HEG' }], { now: () => at, gapMs: 0, alternates,
  request: async (id) => { if (id === 'HEG') return refusal; throw new Error('This operation was aborted'); } });
assert.equal(halfRefused.byTicker.HEG.errorKind, 'transient', 'a refusal followed by a timeout is not proof the source refuses the company');

// Refused on every identifier, three times over a day: named as a source gap, rechecked weekly.
let refusedState = { targetTickers: [], byTicker: {} };
for (const hours of [0, 12, 25]) {
  refusedState = await captureMunsInsiders(refusedState, [{ ticker: 'INDIGRID', priority: true }], { now: () => at + hours * 3600000, gapMs: 0, alternates, request: async () => refusal });
}
assert.equal(refusedState.byTicker.INDIGRID.errorKind, 'refused');
assert.equal(refusedState.byTicker.INDIGRID.failures, 3);
assert.equal(refusedState.byTicker.INDIGRID.unsupported, true);
const refusedHealth = insiderCaptureHealth(refusedState, at + 25 * 3600000);
assert.equal(refusedHealth.ok, true, 'a source gap does not fail the run');
assert.match(refusedHealth.notes.join(' '), /1 companies the source refuses on every identifier.*INDIGRID/);
let skipped = 0;
await captureMunsInsiders(refusedState, [{ ticker: 'INDIGRID', priority: true }], { now: () => at + 30 * 3600000, gapMs: 0, alternates, request: async () => { skipped++; return refusal; } });
assert.equal(skipped, 0, 'a named gap is not asked about every run, even as a holding');
const rechecked = await captureMunsInsiders(refusedState, [{ ticker: 'INDIGRID', priority: true }], { now: () => at + 9 * 24 * 3600000, gapMs: 0, alternates, request: async () => ({ ok: true, trades: [] }) });
assert.equal(rechecked.byTicker.INDIGRID.unsupported, undefined, 'a weekly recheck that answers clears the gap');
assert.equal(rechecked.byTicker.INDIGRID.error, null);
assert.match(insiderSummary({ insiders: refusedState }, ['INDIGRID'], at + 25 * 3600000), /1 not served by the source/);
assert.doesNotMatch(insiderSummary({ insiders: refusedState }, ['INDIGRID'], at + 25 * 3600000), /failed checks|unchecked/);

// A failure that is not a refusal and survives every retry for two days fails the run.
let slowState = { targetTickers: [], byTicker: {} };
for (const hours of [0, 24, 49]) {
  slowState = await captureMunsInsiders(slowState, [{ ticker: 'SLOW' }], { now: () => at + hours * 3600000, gapMs: 0, request: async () => { throw new Error('This operation was aborted'); } });
}
const slowHealth = insiderCaptureHealth(slowState, at + 49 * 3600000);
assert.equal(slowHealth.ok, false);
assert.match(slowHealth.problems.join(' '), /1 companies have failed every retry for over 48 hours: SLOW/);
assert.equal(slowState.byTicker.SLOW.unsupported, undefined, 'a timeout is never classified as a source gap');

// Companies that answered before failing together is an outage, whatever the cause.
const healthy = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`C${i}`, { checkedAt: '2026-09-09T00:00:00Z', lastSuccessAt: '2026-09-09T00:00:00Z', error: null, trades: [] }]));
const outage = await captureMunsInsiders({ targetTickers: Object.keys(healthy), byTicker: healthy }, Object.keys(healthy).map(ticker => ({ ticker })), {
  now: () => at, gapMs: 0, request: async (id) => (Number(id.slice(1)) % 3 ? { ok: true, trades: [] } : refusal) });
assert.equal(outage.run.healthyAttempted, 30);
assert.equal(outage.run.healthyFailed, 10);
assert.equal(insiderCaptureHealth(outage, at).ok, false, 'a third of previously healthy companies failing is an outage');
assert.match(insiderCaptureHealth(outage, at).problems.join(' '), /10 of 30 companies that answered last time failed this run/);

// A refused credential stops the run and fails it, by name.
const refusedToken = await captureMunsInsiders({ targetTickers: [], byTicker: {} }, [{ ticker: 'A' }, { ticker: 'B' }], { now: () => at, gapMs: 0,
  request: async () => ({ ok: false, reason: 'unauthorised', status: 401, message: 'refused' }) });
assert.equal(insiderCaptureHealth(refusedToken, at).ok, false);
assert.match(refusedToken.error, /unauthorised/);

// Failures retained from before lead the next run, ahead of the rotation, within the lane.
const retained = { targetTickers: [], byTicker: {
  OLD: { checkedAt: '2026-09-01T00:00:00Z', lastSuccessAt: '2026-09-01T00:00:00Z', error: null, trades: [] },
  BROKE1: { checkedAt: '2026-09-09T00:00:00Z', error: 'The insider-trades API answered HTTP 520.', trades: [] },
  BROKE2: { checkedAt: '2026-09-09T01:00:00Z', error: 'The insider-trades API answered HTTP 520.', trades: [] },
} };
const order = [];
await captureMunsInsiders(retained, ['OLD', 'BROKE2', 'BROKE1', 'NEVER'].map(ticker => ({ ticker })), { now: () => at, gapMs: 0, retryLane: 1,
  request: async (id) => { order.push(id); return { ok: true, trades: [] }; } });
assert.deepEqual(order, ['BROKE1', 'NEVER', 'OLD', 'BROKE2'], 'the oldest failure leads; the lane is capped and the rest rotate by age');
assert.equal(insiderCaptureHealth(retained, at).ok, true, 'failures recorded before this change are retried before they can fail a run');
console.log('PASS Muns supplementation: Sattva portfolio priority, expanding universe, overlap, checkpoint recovery, failures, empty answers, old history and deduplication');
