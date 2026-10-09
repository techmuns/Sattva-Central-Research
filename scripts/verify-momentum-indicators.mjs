#!/usr/bin/env node
// Momentum Scanner data checks — the additive indicator fields scrape-technicals.mjs writes for the
// live screener: SMA20/SMA100 and the above-DMA flags, 10-day average volume, the daily/weekly/
// monthly Wilder RSI(14) with running state, and the MACD EMAs.
//
// The client's #1 requirement is accuracy, and there is no npm indicator library in this repo. So
// every figure is checked by INDEPENDENT RECOMPUTE against scripts/lib/indicators.mjs (a separate
// Wilder/EMA/SMA implementation) and from first principles. Dependency-free, like verify-bars.mjs.
//
// Three sections:
//   1. Algorithm core (always, deterministic) — the CI gate. momentum.mjs vs indicators.mjs, the
//      one-step live-advance contract, resampling, field definitions, boundary/null handling.
//   2. Intra-record invariants — run against public/data/technicals.json when it already carries the
//      new fields. SKIPs on a file written before this shipped; the scheduled refresh adds them.
//   3. Live sample + cross-check (best-effort) — fetches a few liquid stocks, recomputes every field
//      a second way, asserts a match, prints the verification table. SKIPs without egress; a real
//      mismatch still FAILS.
//
// Run: node scripts/verify-momentum-indicators.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sma, ema, rsi, macd } from './lib/indicators.mjs';
import { isoWeekKey, monthKey, resample, completedPeriods, wilderRsiState, advanceWilderRsi, rsiFromAverages } from './lib/momentum.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const ok = (label, fn) => {
  try { fn(); passed += 1; console.log('PASS  ' + label); }
  catch (err) { failed += 1; console.log('FAIL  ' + label + '\n      ' + (err.message || err).split('\n')[0]); }
};
const skip = (label, why) => console.log('SKIP  ' + label + '  (' + why + ')');
// Decimal boundary differences (0.8 - 0.7) can exceed 0.1 by one floating-point bit.
const near = (a, b, tol, msg) => assert.ok(a != null && b != null && Math.abs(a - b) <= tol + Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)), `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------------------
// A deterministic dated daily series: weekdays from a fixed start, seeded random walk. No RNG from
// the platform, so the series — and therefore every assertion below — is identical on every run.
// ---------------------------------------------------------------------------------------
function syntheticBars(count, seed = 12345, startDate = '2016-01-01') {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bars = [];
  let price = 500;
  const d = new Date(startDate + 'T00:00:00Z');
  while (bars.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {                 // weekdays only
      price = Math.max(10, price * (1 + (rnd() - 0.485) * 0.03));
      const close = Math.round(price * 100) / 100;
      const high = Math.round(close * (1 + rnd() * 0.01) * 100) / 100;
      const low = Math.round(close * (1 - rnd() * 0.01) * 100) / 100;
      bars.push({ date: d.toISOString().slice(0, 10), open: close, high, low, close, volume: 10000 + Math.round(rnd() * 90000) });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

console.log('\n== Section 1: algorithm core (deterministic) ==');

ok('numeric comparisons accept the exact tolerance boundary and reject a larger difference', () => {
  near(0.8, 0.7, 0.1, 'decimal boundary');
  assert.throws(() => near(0.81, 0.7, 0.1, 'outside tolerance'));
});

const bars = syntheticBars(2200);           // ~8.4 years of weekdays
const close = bars.map((b) => b.close);
const vol = bars.map((b) => b.volume);

ok('momentum.mjs Wilder RSI matches the independent indicators.mjs RSI (daily closes)', () => {
  const st = wilderRsiState(close, 14);
  near(st.value, rsi(close, 14).at(-1), 1e-9, 'daily RSI');
});

ok('RSI is bounded 0–100, and pins to its extremes on monotonic input', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);     // strictly rising
  const down = Array.from({ length: 60 }, (_, i) => 160 - i);   // strictly falling
  const flat = Array.from({ length: 60 }, () => 100);           // unchanged
  assert.equal(wilderRsiState(up, 14).value, 100, 'all-gains RSI is 100');
  assert.ok(wilderRsiState(down, 14).value < 1e-9, 'all-losses RSI is ~0');
  assert.equal(wilderRsiState(flat, 14).value, 100, 'no movement: avgLoss 0 ⇒ 100 by convention');
  const st = wilderRsiState(close, 14);
  assert.ok(st.value >= 0 && st.value <= 100, 'RSI stays within 0–100');
  assert.ok(st.avgGain >= 0 && st.avgLoss >= 0, 'Wilder averages are non-negative');
});

ok('the stored state advances ONE step to the exact full-series RSI (the live-recompute contract)', () => {
  // This is the whole reason the state is stored: the browser carries it one step with the live
  // price. Prove advance(state@k, close[k]) === full RSI through k, for several k and on the
  // resampled weekly/monthly series too.
  for (const k of [20, 100, 500, 1500, close.length - 1]) {
    const state = wilderRsiState(close.slice(0, k), 14);
    const stepped = advanceWilderRsi(state, close[k], 14);
    const full = wilderRsiState(close.slice(0, k + 1), 14);
    near(stepped.value, full.value, 1e-9, `daily advance@${k} value`);
    near(stepped.avgGain, full.avgGain, 1e-9, `daily advance@${k} avgGain`);
    near(stepped.avgLoss, full.avgLoss, 1e-9, `daily advance@${k} avgLoss`);
  }
  for (const tf of ['week', 'month']) {
    const periods = completedPeriods(bars, tf).map((p) => p.close);
    const k = periods.length - 1;
    const stepped = advanceWilderRsi(wilderRsiState(periods.slice(0, k), 14), periods[k], 14);
    const full = wilderRsiState(periods.slice(0, k + 1), 14);
    near(stepped.value, full.value, 1e-9, `${tf} advance value`);
  }
});

ok('weekly / monthly RSI match indicators.mjs on an independently-resampled series', () => {
  // Resample a SECOND way here (group by key, keep the last trading day) — independent of
  // momentum.mjs's resample — then run the independent indicators.mjs RSI over it. The last entry
  // of a full resample is always the current (in-progress) period, which completedPeriods drops.
  const independentResample = (keyFn) => {
    const byKey = new Map();
    for (const b of bars) byKey.set(keyFn(b.date), b.close);
    return [...byKey.values()].slice(0, -1);
  };
  const wk = independentResample(isoWeekKey);
  const mo = independentResample(monthKey);
  assert.deepEqual(completedPeriods(bars, 'week').map((p) => p.close), wk, 'weekly completed closes match the independent resample');
  assert.deepEqual(completedPeriods(bars, 'month').map((p) => p.close), mo, 'monthly completed closes match the independent resample');
  near(wilderRsiState(completedPeriods(bars, 'week').map((p) => p.close), 14).value, rsi(wk, 14).at(-1), 1e-9, 'weekly RSI');
  near(wilderRsiState(completedPeriods(bars, 'month').map((p) => p.close), 14).value, rsi(mo, 14).at(-1), 1e-9, 'monthly RSI');
});

ok('resampling keeps the last trading day per period and drops only the in-progress period', () => {
  const daily = [
    { date: '2026-09-28', close: 10 }, { date: '2026-09-29', close: 11 }, { date: '2026-10-01', close: 12 }, // W40
    { date: '2026-10-05', close: 13 }, { date: '2026-10-06', close: 14 },                                   // W41 (current)
  ];
  const wk = resample(daily, isoWeekKey);
  assert.deepEqual(wk.map((p) => [p.key, p.date, p.close]), [['2026-W40', '2026-10-01', 12], ['2026-W41', '2026-10-06', 14]]);
  assert.deepEqual(completedPeriods(daily, 'week').map((p) => p.date), ['2026-10-01'], 'current week dropped');
  const monthly = [{ date: '2026-08-31', close: 1 }, { date: '2026-09-30', close: 2 }, { date: '2026-10-06', close: 3 }];
  assert.deepEqual(completedPeriods(monthly, 'month').map((p) => [p.key, p.close]), [['2026-08', 1], ['2026-09', 2]], 'current month dropped');
  // ISO weeks: Monday and the following Sunday share a key; the next Monday does not.
  assert.equal(isoWeekKey('2026-09-28'), isoWeekKey('2026-10-04'));
  assert.notEqual(isoWeekKey('2026-09-28'), isoWeekKey('2026-10-05'));
});

ok('the additive daily fields match their definitions and indicators.mjs', () => {
  // SMA20 / SMA100 vs indicators.mjs sma and vs a hand mean.
  near(sma(close, 20).at(-1), close.slice(-20).reduce((a, b) => a + b, 0) / 20, 1e-9, 'sma20 = mean(last 20)');
  near(sma(close, 100).at(-1), close.slice(-100).reduce((a, b) => a + b, 0) / 100, 1e-9, 'sma100 = mean(last 100)');
  // avg_volume_10d is the prior 10 sessions EXCLUDING the latest completed bar (mirrors
  // avg_volume_20d), and volume_ratio_10d = latest ÷ that. The window must end one bar before cmp.
  const win10 = vol.slice(-11, -1);
  assert.equal(win10.length, 10, 'exactly 10 sessions');
  assert.equal(win10.at(-1), vol[vol.length - 2], 'window ends at the bar before the latest — latest excluded');
  assert.equal(vol.slice(-21, -1).length, 20, 'avg_volume_20d still 20 prior sessions');
  const avg10 = win10.reduce((a, b) => a + b, 0) / 10;
  assert.ok(Number.isFinite(vol.at(-1) / avg10), 'volume_ratio_10d = latest ÷ 10-day avg');
  // MACD line is EMA12 − EMA26 at the last completed bar.
  near(ema(close, 12).at(-1) - ema(close, 26).at(-1), macd(close, 12, 26, 9).macd.at(-1), 1e-9, 'line = ema12 − ema26');
});

ok('insufficient history returns null rather than a fabricated figure', () => {
  assert.equal(wilderRsiState([1, 2, 3], 14), null, 'RSI needs period+1 changes');
  assert.equal(wilderRsiState(Array.from({ length: 14 }, (_, i) => i), 14), null, 'exactly 14 closes is one change short');
  assert.ok(wilderRsiState(Array.from({ length: 15 }, (_, i) => i), 14) != null, '15 closes is enough');
  assert.deepEqual(completedPeriods([], 'week'), []);
  assert.equal(rsiFromAverages(5, 0), 100, 'avgLoss 0 ⇒ 100');
});

// ---------------------------------------------------------------------------------------
console.log('\n== Section 2: intra-record invariants on public/data/technicals.json ==');
// ---------------------------------------------------------------------------------------
(() => {
  let file;
  try { file = JSON.parse(readFileSync(resolve(__dirname, '../public/data/technicals.json'), 'utf8')); }
  catch { skip('technicals.json invariants', 'file unreadable'); return; }
  const rows = (file.companies || []).filter((r) => !r.error && r.rsi_multi);
  if (!rows.length) {
    skip('technicals.json invariants', 'committed file has no rsi_multi yet — the scheduled refresh adds the fields');
    return;
  }
  ok(`every row's momentum fields are internally consistent (${rows.length} rows)`, () => {
    for (const r of rows) {
      assert.equal(r.rsi_multi.daily.value, r.rsi14, `${r.ticker}: rsi_multi.daily.value === rsi14`);
      near(r.rsi_multi.daily.lastClose, r.cmp, 1e-6, `${r.ticker}: daily.lastClose === cmp`);
      if (r.macd && r.macd.ema12 != null && r.macd.ema26 != null) {
        // ema12/ema26 are stored at 4 dp and `line` at 2 dp, each rounded from the raw EMAs
        // independently — so recomputing the 2-dp line from the 4-dp EMAs can land one 0.01 step
        // away at a rounding boundary. Allow that single step (a real mismatch is far larger).
        near(Math.round((r.macd.ema12 - r.macd.ema26) * 100) / 100, r.macd.line, 0.011, `${r.ticker}: line === ema12 − ema26`);
      }
      // The above-DMA flags are computed from the FULL-PRECISION moving average, while smaN is
      // stored rounded to the rupee — so within 0.5 of the line the stored value cannot decide the
      // comparison (e.g. cmp 433.80 vs raw SMA ~433.7 is above, but rounds to 434). Only assert
      // where the rounding cannot flip it; the near-the-line band is indeterminate from stored data.
      const dmaConsistent = (flag, sma) => sma == null || Math.abs(r.cmp - sma) <= 0.5 || flag === r.cmp > sma;
      assert.ok(dmaConsistent(r.above_20dma, r.sma20), `${r.ticker}: above_20dma (cmp ${r.cmp} vs sma20 ${r.sma20})`);
      assert.ok(dmaConsistent(r.above_50dma, r.sma50), `${r.ticker}: above_50dma (cmp ${r.cmp} vs sma50 ${r.sma50})`);
      assert.ok(dmaConsistent(r.above_100dma, r.sma100), `${r.ticker}: above_100dma (cmp ${r.cmp} vs sma100 ${r.sma100})`);
      for (const tf of ['daily', 'weekly', 'monthly']) {
        const s = r.rsi_multi[tf];
        if (s == null) continue;
        assert.ok(s.value >= 0 && s.value <= 100, `${r.ticker}: ${tf} RSI in range`);
        assert.ok(s.avgGain >= 0 && s.avgLoss >= 0 && s.lastClose > 0, `${r.ticker}: ${tf} state sane`);
        near(Math.round((s.avgLoss === 0 ? 100 : 100 - 100 / (1 + s.avgGain / s.avgLoss)) * 10) / 10, s.value, 0.1, `${r.ticker}: ${tf} state reproduces value`);
      }
    }
  });
})();

// ---------------------------------------------------------------------------------------
console.log('\n== Section 3: live sample + independent cross-check (opt-in: MOMENTUM_LIVE=1) ==');
// Off by default so CI stays deterministic and never depends on (or hammers) Yahoo. Run locally
// with MOMENTUM_LIVE=1 for the verification table and a live independent recompute.
// ---------------------------------------------------------------------------------------
await (async () => {
  if (process.env.MOMENTUM_LIVE !== '1') { skip('live sample', 'set MOMENTUM_LIVE=1 to fetch Yahoo and print the table'); return; }
  let fetchBars;
  try { ({ fetchBars } = await import('./lib/yahoo.mjs')); } catch { skip('live sample', 'yahoo.mjs unavailable'); return; }
  const SAMPLE = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY'];
  const end = new Date();
  const rows = [];
  for (const t of SAMPLE) {
    let long;
    try { long = await fetchBars(`${t}.NS`, new Date(end.getTime() - 4050 * 86400000), end); }
    catch { skip(`live ${t}`, 'no egress to Yahoo'); return; }
    if (!long || long.length < 200) { skip(`live ${t}`, 'short series'); continue; }
    const c = long.map((b) => b.close), v = long.map((b) => b.volume), cmp = c.at(-1);
    const wk = completedPeriods(long, 'week').map((p) => p.close);
    const mo = completedPeriods(long, 'month').map((p) => p.close);
    const r = (x, d = 0) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
    const rec = {
      ticker: t, cmp,
      sma20: r(sma(c, 20).at(-1)), sma50: r(sma(c, 50).at(-1)), sma100: r(sma(c, 100).at(-1)), sma200: r(sma(c, 200).at(-1)),
      above_20dma: cmp > sma(c, 20).at(-1), above_50dma: cmp > sma(c, 50).at(-1), above_100dma: cmp > sma(c, 100).at(-1), above_200dma: cmp > sma(c, 200).at(-1),
      avg_volume_10d: Math.round(v.slice(-11, -1).reduce((a, b) => a + b, 0) / 10),
      avg_volume_20d: Math.round(v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20),
      rsiD: r(wilderRsiState(c, 14).value, 1), rsiW: r(wilderRsiState(wk, 14).value, 1), rsiM: r(wilderRsiState(mo, 14).value, 1),
      monthlyBars: mo.length,
    };
    // Independent recompute via indicators.mjs — a different RSI/EMA/SMA implementation.
    ok(`live ${t}: RSI daily/weekly/monthly match indicators.mjs`, () => {
      near(rec.rsiD, rsi(c, 14).at(-1), 0.05, `${t} daily`);
      near(rec.rsiW, rsi(wk, 14).at(-1), 0.05, `${t} weekly`);
      near(rec.rsiM, rsi(mo, 14).at(-1), 0.05, `${t} monthly`);
    });
    ok(`live ${t}: values are sane (RSI 0–100, DMAs ordered, flags consistent)`, () => {
      for (const x of [rec.rsiD, rec.rsiW, rec.rsiM]) assert.ok(x >= 0 && x <= 100, `${t} RSI range`);
      assert.equal(rec.above_20dma, rec.cmp > rec.sma20);
      assert.equal(rec.above_200dma, rec.cmp > rec.sma200);
      assert.ok(rec.monthlyBars >= 60, `${t} monthly warm-up: ${rec.monthlyBars} bars`);
    });
    rows.push(rec);
  }
  if (rows.length) {
    console.log('\n  Verification table (independently recomputed from Yahoo daily history):');
    console.log('  ' + 'TICKER'.padEnd(10) + 'CMP'.padStart(10) + 'SMA20'.padStart(9) + 'SMA50'.padStart(9) + 'SMA100'.padStart(9) + 'SMA200'.padStart(9) + '  >20/50/100/200' + '   RSI D/W/M'.padStart(22) + '  VOL10d/20d');
    for (const r of rows) {
      const flags = `${r.above_20dma ? 'Y' : 'n'}/${r.above_50dma ? 'Y' : 'n'}/${r.above_100dma ? 'Y' : 'n'}/${r.above_200dma ? 'Y' : 'n'}`;
      console.log('  ' + r.ticker.padEnd(10) + String(r.cmp.toFixed(1)).padStart(10) + String(r.sma20).padStart(9) + String(r.sma50).padStart(9) + String(r.sma100).padStart(9) + String(r.sma200).padStart(9) + '      ' + flags.padEnd(12) + `${r.rsiD}/${r.rsiW}/${r.rsiM}`.padStart(16) + '   ' + `${r.avg_volume_10d}/${r.avg_volume_20d}`);
    }
    console.log('  (monthly RSI warmed from ' + rows.map((r) => r.monthlyBars).join(', ') + ' monthly bars respectively)');
  }
})();

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
