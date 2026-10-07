// scoring/momentum-live.js — the live engine for the Momentum Scanner (Breakouts / Technical).
//
// Pure, dependency-free, browser + Node importable (scripts/verify-momentum-scanner.mjs imports it).
// It owns two things and nothing else:
//
//   1. The LIVE RECOMPUTE. Intraday the only thing that moves is the current price (and today's
//      cumulative volume); the heavy history is fixed. So each stock's stored Step-1 state is
//      advanced ONE step with the live price, as if today's / this week's / this month's candle
//      closed there:
//        - RSI (daily/weekly/monthly): advanceWilderRsi(rsi_multi.<tf>, livePrice) — the IDENTICAL
//          Wilder step scripts/lib/momentum.mjs performs, so the browser can never drift from the
//          pipeline (the verifier asserts equality to 1e-9).
//        - MACD: advance EMA12 and EMA26 one step, line = ema12 − ema26, signal one step from the
//          stored signal.
//        - DMAs: compare the live price directly to the stored SMA20/50/100/200.
//        - Volume: today's cumulative volume vs the stored 10-day average.
//
//   2. The FILTER DEFINITIONS, as DATA (built to grow toward ~40). Each filter is a list of named
//      conditions with a test(liveVals, thresholds); a stock passes when ALL are true. Thresholds
//      are data too, with client defaults.
//
// HONESTY: every function returns null (never a fabricated number) when a stock lacks the Step-1
// fields — the committed technicals.json carries them only after the scheduled Data refresh. A row
// with no fields is `evaluable: false` and must never be shown as passing.

// ---------------------------------------------------------------------------------------
// Live recompute
// ---------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Advance a Wilder RSI(14) state ONE step with the live price — the exact step
 * scripts/lib/momentum.mjs `advanceWilderRsi` performs. `state` is the stored
 * `rsi_multi.<tf>` = { value, avgGain, avgLoss, lastClose }. Returns the advanced
 * { value, avgGain, avgLoss, lastClose }, or null when the state or price is unusable.
 */
export function advanceWilderRsi(state, livePrice, period = 14) {
  if (!state || !isNum(livePrice) || !isNum(state.lastClose) || !isNum(state.avgGain) || !isNum(state.avgLoss)) return null;
  const ch = livePrice - state.lastClose;
  const avgGain = (state.avgGain * (period - 1) + Math.max(0, ch)) / period;
  const avgLoss = (state.avgLoss * (period - 1) + Math.max(0, -ch)) / period;
  const value = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  return { value, avgGain, avgLoss, lastClose: livePrice };
}

// EMA smoothing constants: span 12 → 2/13, span 26 → 2/27, signal span 9 → 2/10.
const K12 = 2 / 13;
const K26 = 2 / 27;
const K9 = 2 / 10;

/**
 * Advance a MACD state ONE step with the live price. `state` carries the raw EMAs at the last
 * completed daily bar plus the stored signal: { ema12, ema26, signal }. Returns
 * { ema12, ema26, line, signal, above_zero, bullish } (bullish = line > signal), or null.
 */
export function advanceMacd(state, livePrice) {
  if (!state || !isNum(livePrice) || !isNum(state.ema12) || !isNum(state.ema26)) return null;
  const ema12 = livePrice * K12 + state.ema12 * (1 - K12);
  const ema26 = livePrice * K26 + state.ema26 * (1 - K26);
  const line = ema12 - ema26;
  const signal = isNum(state.signal) ? line * K9 + state.signal * (1 - K9) : null;
  return { ema12, ema26, line, signal, above_zero: line > 0, bullish: signal == null ? null : line > signal };
}

/**
 * Normalize one company + its live quote into the values the filters test. Returns a flat object;
 * every field is null when the input is missing, and `evaluable` is false when the company carries
 * no Step-1 momentum fields at all (the daily file has not been refreshed yet).
 *
 * `livePrice` is the current price (a live quote when fresh, else the EOD close the caller chose).
 * `liveVolume` is today's CUMULATIVE traded volume so far. `prevClose` defaults to the stored last
 * completed close (`company.cmp`) — the natural previous close for the in-progress candle.
 */
export function liveIndicators(company, livePrice, liveVolume, prevClose) {
  const c = company || {};
  const prev = prevClose === undefined ? (isNum(c.cmp) ? c.cmp : null) : prevClose;
  // A row is evaluable only if it carries the Step-1 field set. Any ONE of these being present is
  // not enough; the daily refresh writes them together, so their joint absence is the "pending"
  // signal. SMA100/above-100 may still be null for a young stock — that is a real null, handled
  // per condition, not a pending row.
  const hasRsi = !!(c.rsi_multi && c.rsi_multi.daily && isNum(c.rsi_multi.daily.avgGain));
  const hasMacd = !!(c.macd && isNum(c.macd.ema12) && isNum(c.macd.ema26));
  const hasSma = isNum(c.sma20) && isNum(c.sma50) && isNum(c.sma200);
  const evaluable = hasRsi && hasMacd && hasSma && isNum(livePrice);

  const aboveDma = (sma) => (isNum(sma) && isNum(livePrice) ? livePrice > sma : null);
  const rsiD = hasRsi ? advanceWilderRsi(c.rsi_multi.daily, livePrice) : null;
  const rsiW = c.rsi_multi && c.rsi_multi.weekly ? advanceWilderRsi(c.rsi_multi.weekly, livePrice) : null;
  const rsiM = c.rsi_multi && c.rsi_multi.monthly ? advanceWilderRsi(c.rsi_multi.monthly, livePrice) : null;
  const macd = hasMacd ? advanceMacd({ ema12: c.macd.ema12, ema26: c.macd.ema26, signal: c.macd.signal }, livePrice) : null;

  // freshCross: not yet bullish at the last completed bar (stored line ≤ signal, or the stored
  // positive_crossover flag), and bullish now. A new signal, not a standing one.
  let freshCross = null;
  if (macd && macd.bullish != null) {
    const storedBelow = c.macd.positive_crossover === true || (isNum(c.macd.line) && isNum(c.macd.signal) && c.macd.line <= c.macd.signal);
    freshCross = macd.bullish === true && storedBelow === true;
  }

  return {
    evaluable,
    price: isNum(livePrice) ? livePrice : null,
    prevClose: isNum(prev) ? prev : null,
    rising: isNum(livePrice) && isNum(prev) ? livePrice > prev : null,
    above20dma: aboveDma(c.sma20),
    above50dma: aboveDma(c.sma50),
    above100dma: aboveDma(c.sma100),
    above200dma: aboveDma(c.sma200),
    // The stored (EOD) 20-DMA flag — "recently crossed / holding the cross" even if a live tick dips.
    priorAbove20dma: typeof c.above_20dma === 'boolean' ? c.above_20dma : null,
    rsiDaily: rsiD ? rsiD.value : null,
    rsiWeekly: rsiW ? rsiW.value : null,
    rsiMonthly: rsiM ? rsiM.value : null,
    macdBullish: macd ? macd.bullish : null,
    macdLine: macd ? macd.line : null,
    macdSignal: macd ? macd.signal : null,
    macdAboveZero: macd ? macd.above_zero : null,
    freshCross,
    volRatio10d: isNum(liveVolume) && isNum(c.avg_volume_10d) && c.avg_volume_10d > 0 ? liveVolume / c.avg_volume_10d : null,
    liveVolume: isNum(liveVolume) ? liveVolume : null,
    avgVolume10d: isNum(c.avg_volume_10d) ? c.avg_volume_10d : null,
    // Raw stored SMAs, for cell tooltips.
    sma20: isNum(c.sma20) ? c.sma20 : null,
    sma50: isNum(c.sma50) ? c.sma50 : null,
    sma100: isNum(c.sma100) ? c.sma100 : null,
    sma200: isNum(c.sma200) ? c.sma200 : null,
  };
}

// ---------------------------------------------------------------------------------------
// Filter definitions — DATA, not hardcoded. Built to grow toward ~40 filters.
//
// Each filter is { id, label, short, conditions: [{ key, label(t), test(v, t), live(v) }] }.
//   - label(t)  the human rule, with the current threshold interpolated.
//   - test(v,t) true only when the condition holds; MUST be false (not throw) on a null input.
//   - live(v)   a short string of the live value behind the condition, for tooltips.
// A stock passes a filter when EVERY condition tests true AND the row is evaluable.
// ---------------------------------------------------------------------------------------

export const THRESHOLD_DEFAULTS = Object.freeze({ rsiD1: 70, rsiW: 70, rsiM: 65, rsiD2: 50, volMult: 1.5 });

// The adjustable thresholds, grouped by the filter they belong to. Drives the UI controls and the
// URL round-trip; `clampThresholds` keeps a pasted or bookmarked value sane.
export const THRESHOLD_FIELDS = Object.freeze([
  { key: 'rsiD1', filter: 'strong-momentum', label: 'RSI daily >', min: 0, max: 100, step: 1 },
  { key: 'rsiW', filter: 'strong-momentum', label: 'RSI weekly >', min: 0, max: 100, step: 1 },
  { key: 'rsiM', filter: 'strong-momentum', label: 'RSI monthly >', min: 0, max: 100, step: 1 },
  { key: 'rsiD2', filter: 'volume-momentum', label: 'RSI daily >', min: 0, max: 100, step: 1 },
  { key: 'volMult', filter: 'volume-momentum', label: 'Volume ≥ ×', min: 0, max: 20, step: 0.1 },
]);

const n1 = (x) => (x == null ? '—' : Number(x).toFixed(1));

export const MOMENTUM_FILTERS = Object.freeze({
  'strong-momentum': {
    id: 'strong-momentum',
    label: 'Strong Momentum',
    short: 'Filter 1',
    description: 'Price above every DMA, with daily, weekly and monthly RSI all strong.',
    conditions: [
      { key: 'above20', label: () => 'Price > 20 DMA', test: (v) => v.above20dma === true, live: (v) => (v.sma20 == null ? '—' : `20DMA ${v.sma20.toFixed(0)}`) },
      { key: 'above50', label: () => 'Price > 50 DMA', test: (v) => v.above50dma === true, live: (v) => (v.sma50 == null ? '—' : `50DMA ${v.sma50.toFixed(0)}`) },
      { key: 'above100', label: () => 'Price > 100 DMA', test: (v) => v.above100dma === true, live: (v) => (v.sma100 == null ? '—' : `100DMA ${v.sma100.toFixed(0)}`) },
      { key: 'above200', label: () => 'Price > 200 DMA', test: (v) => v.above200dma === true, live: (v) => (v.sma200 == null ? '—' : `200DMA ${v.sma200.toFixed(0)}`) },
      { key: 'rsiD', label: (t) => `RSI daily > ${t.rsiD1}`, test: (v, t) => v.rsiDaily != null && v.rsiDaily > t.rsiD1, live: (v) => `RSI(D) ${n1(v.rsiDaily)}` },
      { key: 'rsiW', label: (t) => `RSI weekly > ${t.rsiW}`, test: (v, t) => v.rsiWeekly != null && v.rsiWeekly > t.rsiW, live: (v) => `RSI(W) ${n1(v.rsiWeekly)}` },
      { key: 'rsiM', label: (t) => `RSI monthly > ${t.rsiM}`, test: (v, t) => v.rsiMonthly != null && v.rsiMonthly > t.rsiM, live: (v) => `RSI(M) ${n1(v.rsiMonthly)}` },
    ],
  },
  'volume-momentum': {
    id: 'volume-momentum',
    label: 'Volume + Momentum',
    short: 'Filter 2',
    description: 'A volume surge on a rising price, holding its 20 DMA, with daily RSI firm and MACD bullish.',
    conditions: [
      { key: 'vol', label: (t) => `Volume ≥ ${Number(t.volMult).toFixed(1)}× 10-day avg`, test: (v, t) => v.volRatio10d != null && v.volRatio10d >= t.volMult, live: (v) => (v.volRatio10d == null ? '—' : `${v.volRatio10d.toFixed(2)}×`) },
      { key: 'rising', label: () => 'Price rising vs previous close', test: (v) => v.rising === true, live: (v) => (v.price == null || v.prevClose == null ? '—' : `${v.price.toFixed(2)} vs ${v.prevClose.toFixed(2)}`) },
      { key: 'cross20', label: () => 'Above or holding the 20 DMA', test: (v) => v.above20dma === true || v.priorAbove20dma === true, live: (v) => (v.sma20 == null ? '—' : `20DMA ${v.sma20.toFixed(0)}`) },
      { key: 'rsiD', label: (t) => `RSI daily > ${t.rsiD2}`, test: (v, t) => v.rsiDaily != null && v.rsiDaily > t.rsiD2, live: (v) => `RSI(D) ${n1(v.rsiDaily)}` },
      { key: 'macd', label: () => 'MACD bullish', test: (v) => v.macdBullish === true, live: (v) => (v.macdBullish == null ? '—' : v.macdBullish ? 'bullish' : 'bearish') },
    ],
  },
});

/** Evaluate one filter against live values. `{ pass, evaluable, conditions: [{key,label,ok,live}] }`. */
export function evaluateFilter(filterId, v, thresholds = THRESHOLD_DEFAULTS) {
  const filter = MOMENTUM_FILTERS[filterId];
  if (!filter) return { pass: false, evaluable: false, conditions: [] };
  const evaluable = !!(v && v.evaluable);
  const conditions = filter.conditions.map((c) => ({
    key: c.key,
    label: c.label(thresholds),
    ok: evaluable ? c.test(v, thresholds) === true : false,
    live: v ? c.live(v) : '—',
  }));
  return { pass: evaluable && conditions.every((c) => c.ok), evaluable, conditions };
}

/** Does a row pass the active gate? `gate` is a filter id or 'both'. Pending rows never pass. */
export function passesGate(gate, v, thresholds = THRESHOLD_DEFAULTS) {
  if (!v || !v.evaluable) return false;
  if (gate === 'both') return evaluateFilter('strong-momentum', v, thresholds).pass && evaluateFilter('volume-momentum', v, thresholds).pass;
  if (gate === 'volume-momentum') return evaluateFilter('volume-momentum', v, thresholds).pass;
  return evaluateFilter('strong-momentum', v, thresholds).pass;
}

export const GATES = Object.freeze(['strong-momentum', 'volume-momentum', 'both']);

/** Keep a supplied threshold map within each field's declared bounds, falling back to the default. */
export function clampThresholds(input = {}) {
  const out = { ...THRESHOLD_DEFAULTS };
  for (const f of THRESHOLD_FIELDS) {
    const raw = input[f.key];
    const num = Number(raw);
    if (raw == null || raw === '' || !Number.isFinite(num)) continue;
    out[f.key] = Math.min(f.max, Math.max(f.min, num));
  }
  return out;
}
