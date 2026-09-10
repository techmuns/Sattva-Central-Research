import assert from 'node:assert/strict';
import { captureMunsInsiders, insiderCaptureCompanies } from './lib/muns-insider-capture.mjs';
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
assert.equal(prior.byTicker.HELD.trades.length, 1, 'prior checkpoint is not mutated');

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
assert.throws(() => validateExchangeSnapshot({ ...exchange, insiders: { targetTickers: [], byTicker: { X: {} } } }), /checkpoint/);
assert.deepEqual(insiderCaptureCompanies([{ ticker: 'HELD', priority: true }], { byTicker: { UNIVERSE: [], HELD: [] } }, exchange).map(c => [c.ticker, !!c.priority]), [['HELD', true], ['UNIVERSE', false]]);
console.log('PASS Muns supplementation: Sattva portfolio priority, expanding universe, overlap, checkpoint recovery, failures, empty answers, old history and deduplication');
