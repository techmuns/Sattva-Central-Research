#!/usr/bin/env node
// Momentum Scanner (Step 2) checks — the live engine and the filter evaluation behind the new
// Breakouts / Technical sub-view. Dependency-free and deterministic, like verify-bars.mjs.
//
// The browser recomputes RSI and MACD on the in-progress candle; if that math drifts from the data
// pipeline the screener lies. So this asserts, to 1e-9:
//   (a) public/js/scoring/momentum-live.js `advanceWilderRsi` is identical to the pipeline's
//       scripts/lib/momentum.mjs, and reproduces the full-series Wilder RSI one step on;
//   (b) `advanceMacd` reproduces a from-scratch EMA12/EMA26/signal/line recompute one step on.
// And it asserts the two filters give the expected pass/fail on crafted rows — including rows with
// no Step-1 fields, which must read "pending", never "passing".
//
// Run: node scripts/verify-momentum-scanner.mjs

import assert from 'node:assert/strict';
import * as live from '../public/js/scoring/momentum-live.js';
import * as pipeline from './lib/momentum.mjs';

let passed = 0;
let failed = 0;
const ok = (label, fn) => {
  try { fn(); passed += 1; console.log('PASS  ' + label); }
  catch (err) { failed += 1; console.log('FAIL  ' + label + '\n      ' + String(err.message || err).split('\n')[0]); }
};
const near = (a, b, tol, msg) => assert.ok(a != null && b != null && Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// A deterministic close series — seeded walk, no platform RNG.
function series(count, seed = 918273) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  let p = 300;
  for (let i = 0; i < count; i++) { p = Math.max(10, p * (1 + (rnd() - 0.48) * 0.04)); out.push(Math.round(p * 100) / 100); }
  return out;
}

// Reference EMA with an SMA seed — the same shape the scraper's local ema() and indicators.mjs use.
function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let prev = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) continue;
    if (prev == null) { let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += closes[j]; prev = sum / period; }
    else prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

console.log('\n== (a) live math matches the pipeline / a from-scratch recompute ==');

const closes = series(220);

ok('advanceWilderRsi is identical to scripts/lib/momentum.mjs and reproduces the full RSI one step on', () => {
  for (const k of [20, 60, 120, closes.length - 1]) {
    const state = pipeline.wilderRsiState(closes.slice(0, k), 14);
    const a = live.advanceWilderRsi(state, closes[k]);
    const b = pipeline.advanceWilderRsi(state, closes[k]);
    near(a.value, b.value, 1e-9, `browser vs pipeline value @${k}`);
    near(a.avgGain, b.avgGain, 1e-9, `avgGain @${k}`);
    near(a.avgLoss, b.avgLoss, 1e-9, `avgLoss @${k}`);
    // And the one-step advance equals the full-series Wilder RSI through that bar.
    const full = pipeline.wilderRsiState(closes.slice(0, k + 1), 14);
    near(a.value, full.value, 1e-9, `advance == full @${k}`);
  }
});

ok('advanceMacd reproduces a from-scratch EMA12/EMA26/signal/line recompute one step on', () => {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const lineSeries = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const lineDefined = lineSeries.filter((x) => x != null);
  const sigRaw = emaSeries(lineDefined, 9);
  const offset = lineSeries.findIndex((x) => x != null);
  const signal = new Array(lineSeries.length).fill(null);
  for (let i = 0; i < sigRaw.length; i++) signal[i + offset] = sigRaw[i];

  for (const n of [120, 170, closes.length - 1]) {
    const state = { ema12: ema12[n - 1], ema26: ema26[n - 1], signal: signal[n - 1] };
    const adv = live.advanceMacd(state, closes[n]);
    near(adv.ema12, ema12[n], 1e-9, `ema12 @${n}`);
    near(adv.ema26, ema26[n], 1e-9, `ema26 @${n}`);
    near(adv.line, lineSeries[n], 1e-9, `line @${n}`);
    near(adv.signal, signal[n], 1e-9, `signal @${n}`);
    assert.equal(adv.bullish, lineSeries[n] > signal[n], `bullish @${n}`);
    assert.equal(adv.above_zero, lineSeries[n] > 0, `above_zero @${n}`);
  }
});

ok('both advance functions return null on missing state or price (never a fabricated number)', () => {
  assert.equal(live.advanceWilderRsi(null, 100), null);
  assert.equal(live.advanceWilderRsi({ avgGain: 1, avgLoss: 1, lastClose: 100 }, null), null);
  assert.equal(live.advanceWilderRsi({ avgGain: 1, avgLoss: null, lastClose: 100 }, 100), null);
  assert.equal(live.advanceMacd(null, 100), null);
  assert.equal(live.advanceMacd({ ema12: 1, ema26: null }, 100), null);
  assert.equal(live.advanceMacd({ ema12: 1, ema26: 2, signal: null }, 100).bullish, null, 'no stored signal ⇒ bullish unknown');
});

console.log('\n== (b) filter evaluation on crafted rows ==');

// Build a company whose stored RSI state, advanced with ch = 0 (lastClose = live price), yields a
// target RSI: value = 100 − 100/(1 + avgGain/avgLoss), so avgGain/avgLoss = rs sets the value.
const rsiState = (target, lastClose) => {
  const rs = target >= 100 ? 1e9 : (100 / (100 - target)) - 1; // target = 100 − 100/(1+rs)
  return { value: target, avgGain: rs, avgLoss: 1, lastClose };
};
// A company tuned so Filter 1 passes at the default thresholds (price above every DMA; D/W/M RSI high).
function strongCompany(price = 100) {
  return {
    ticker: 'TEST', name: 'Test', cmp: price - 5,
    sma20: 80, sma50: 75, sma100: 70, sma200: 60, above_20dma: true,
    avg_volume_10d: 1_000_000,
    rsi_multi: { daily: rsiState(80, price), weekly: rsiState(78, price), monthly: rsiState(72, price) },
    macd: { ema12: 110, ema26: 100, signal: 0, line: 9.5, positive_crossover: false },
  };
}

ok('a tuned row passes Filter 1 at the default thresholds, and every condition reports ok', () => {
  const v = live.liveIndicators(strongCompany(100), 100, 2_000_000);
  assert.equal(v.evaluable, true);
  const r = live.evaluateFilter('strong-momentum', v);
  assert.equal(r.pass, true, 'Filter 1 passes');
  assert.ok(r.conditions.every((c) => c.ok), 'all conditions ok');
  assert.equal(live.passesGate('strong-momentum', v), true);
});

ok('dropping one condition below its threshold fails Filter 1, and names the failing condition', () => {
  const c = strongCompany(100);
  c.rsi_multi.daily = rsiState(60, 100); // 60 is below the default rsiD1 = 70
  const v = live.liveIndicators(c, 100, 2_000_000);
  const r = live.evaluateFilter('strong-momentum', v);
  assert.equal(r.pass, false);
  assert.equal(r.conditions.find((x) => x.key === 'rsiD').ok, false);
  assert.ok(r.conditions.filter((x) => x.key !== 'rsiD').every((x) => x.ok), 'the other six still hold');
  assert.equal(live.passesGate('strong-momentum', v), false);
});

ok('a threshold change re-decides the same row (data is config, not hardcoded)', () => {
  const v = live.liveIndicators(strongCompany(100), 100, 2_000_000);
  assert.equal(live.evaluateFilter('strong-momentum', v, { ...live.THRESHOLD_DEFAULTS, rsiD1: 85 }).pass, false, 'raise rsiD1 to 85 ⇒ fails');
  assert.equal(live.evaluateFilter('strong-momentum', v, { ...live.THRESHOLD_DEFAULTS, rsiD1: 50 }).pass, true, 'lower rsiD1 to 50 ⇒ passes');
});

ok('Filter 2 tests volume, rising price, 20 DMA, daily RSI and MACD bullish', () => {
  const c = strongCompany(100); // MACD ema12 110 > ema26 100 ⇒ bullish; price 100 > cmp 95 ⇒ rising
  const v = live.liveIndicators(c, 100, 2_000_000); // 2.0× the 1.0m 10-day avg ≥ 1.5
  const r = live.evaluateFilter('volume-momentum', v);
  assert.equal(r.pass, true);
  assert.equal(v.macdBullish, true);
  // strongCompany's stored line (9.5) is already above its signal (0), so this is a STANDING
  // bullish state, not a fresh cross. (freshCross is exercised directly in the next check.)
  assert.equal(v.freshCross, false);
});

ok('MACD freshCross is true only when it was not bullish at the last completed bar', () => {
  const below = strongCompany(100); below.macd = { ema12: 110, ema26: 100, signal: 0, line: -2, positive_crossover: false };
  const vBelow = live.liveIndicators(below, 100, 2_000_000);
  assert.equal(vBelow.macdBullish, true);
  assert.equal(vBelow.freshCross, true, 'stored line (−2) ≤ signal (0) and bullish now ⇒ fresh');
  const standing = strongCompany(100); standing.macd = { ema12: 110, ema26: 100, signal: 0, line: 5, positive_crossover: false };
  const vStanding = live.liveIndicators(standing, 100, 2_000_000);
  assert.equal(vStanding.freshCross, false, 'stored line (5) > signal (0) ⇒ already bullish, not fresh');
});

ok('Filter 2 fails when volume is short or the price is not rising', () => {
  const lowVol = live.liveIndicators(strongCompany(100), 100, 1_200_000); // 1.2× < 1.5×
  assert.equal(live.evaluateFilter('volume-momentum', lowVol).conditions.find((c) => c.key === 'vol').ok, false);
  assert.equal(live.evaluateFilter('volume-momentum', lowVol).pass, false);
  const falling = strongCompany(100); falling.cmp = 105; // price 100 < prev 105 ⇒ not rising
  const vFall = live.liveIndicators(falling, 100, 2_000_000);
  assert.equal(vFall.rising, false);
  assert.equal(live.evaluateFilter('volume-momentum', vFall).pass, false);
});

ok('the "Both" gate requires both filters', () => {
  const v = live.liveIndicators(strongCompany(100), 100, 2_000_000);
  assert.equal(live.passesGate('both', v), true);
  const c = strongCompany(100); c.rsi_multi.monthly = rsiState(40, 100); // breaks Filter 1 only
  const v2 = live.liveIndicators(c, 100, 2_000_000);
  assert.equal(live.passesGate('strong-momentum', v2), false);
  assert.equal(live.passesGate('volume-momentum', v2), true);
  assert.equal(live.passesGate('both', v2), false, 'Both needs Filter 1 too');
});

ok('a row with NO Step-1 fields is pending — never evaluable, never passing', () => {
  const bare = { ticker: 'OLD', name: 'Old', cmp: 100, pct_change_today: 1 }; // the committed file before refresh
  const v = live.liveIndicators(bare, 100, 2_000_000);
  assert.equal(v.evaluable, false);
  for (const id of ['strong-momentum', 'volume-momentum']) {
    const r = live.evaluateFilter(id, v);
    assert.equal(r.evaluable, false);
    assert.equal(r.pass, false, `${id} cannot pass a pending row`);
  }
  assert.equal(live.passesGate('both', v), false);
  assert.equal(live.passesGate('strong-momentum', v), false);
});

ok('a missing live price makes the row pending even when the fields are present', () => {
  const v = live.liveIndicators(strongCompany(100), null, 2_000_000);
  assert.equal(v.evaluable, false);
  assert.equal(live.passesGate('strong-momentum', v), false);
});

ok('null live volume leaves volRatio10d null and fails only the volume condition', () => {
  const v = live.liveIndicators(strongCompany(100), 100, null);
  assert.equal(v.volRatio10d, null);
  assert.equal(v.evaluable, true, 'absent volume does not make the row pending');
  assert.equal(live.evaluateFilter('volume-momentum', v).conditions.find((c) => c.key === 'vol').ok, false);
  assert.equal(live.evaluateFilter('strong-momentum', v).pass, true, 'Filter 1 does not use volume');
});

ok('the client default thresholds and clamp bounds hold', () => {
  assert.deepEqual(live.THRESHOLD_DEFAULTS, { rsiD1: 70, rsiW: 70, rsiM: 65, rsiD2: 50, volMult: 1.5 });
  assert.deepEqual(live.clampThresholds({}), { rsiD1: 70, rsiW: 70, rsiM: 65, rsiD2: 50, volMult: 1.5 });
  assert.equal(live.clampThresholds({ rsiD1: 999 }).rsiD1, 100, 'clamped to max');
  assert.equal(live.clampThresholds({ rsiD1: -5 }).rsiD1, 0, 'clamped to min');
  assert.equal(live.clampThresholds({ rsiD1: 'oops' }).rsiD1, 70, 'non-numeric ⇒ default');
  assert.equal(live.clampThresholds({ volMult: 2.5 }).volMult, 2.5, 'valid value kept');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
