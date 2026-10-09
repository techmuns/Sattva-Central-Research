// scripts/lib/momentum.mjs — weekly/monthly resampling and Wilder RSI running state
// for the live Momentum Scanner.
//
// WHY THIS EXISTS
//   A later step recomputes RSI and MACD LIVE in the browser, by taking the running state at the
//   last COMPLETED bar of a timeframe and advancing it ONE Wilder step with the live price as the
//   in-progress candle's provisional close. For that to be exact, the daily capture must store not
//   just each indicator's latest value but the Wilder averages (avgGain / avgLoss) and the last
//   completed close they were computed through. This module produces those, for the weekly and
//   monthly timeframes, by resampling the one long daily history the scrape already fetches — so it
//   costs no extra Yahoo request.
//
//   Pure, dependency-free and offline-testable (scripts/verify-momentum-indicators.mjs): the RSI
//   here is independently recomputable with scripts/lib/indicators.mjs, which is the cross-check.
//
// A COMPLETED PERIOD, AND WHY THE CURRENT ONE IS DROPPED
//   `completedPeriods` returns one bar per ISO week / calendar month, closing on that period's last
//   trading day — and it drops the period the latest daily bar falls in, because that week/month is
//   still in progress. The live step then advances the last completed period forward to the live
//   price. Mirror of `completedBars` in lib/yahoo.mjs, one timeframe up: a bar is not a close until
//   its period has ended.

export { isoWeekKey, monthKey, resample, completedPeriods } from '../../public/js/scoring/momentum-history.js';

/**
 * Wilder's RSI(`period`) over `closes`, returning the value AND the running state at the LAST close:
 * `{ value, avgGain, avgLoss, lastClose }`, or null when there are fewer than `period + 1` finite
 * closes. Seed = simple average of the first `period` changes, then Wilder smoothing — identical to
 * the Wilder RSI in scripts/lib/indicators.mjs, which is what makes that an independent check.
 *
 * The state is exactly what `advanceWilderRsi` needs to carry the RSI one step forward with a live
 * price, which is how the browser will compute the provisional RSI on the in-progress candle.
 */
export function wilderRsiState(closes, period = 14) {
  const xs = (closes || []).filter((v) => Number.isFinite(v));
  if (xs.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = xs[i] - xs[i - 1];
    avgGain += Math.max(0, ch);
    avgLoss += Math.max(0, -ch);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < xs.length; i++) {
    const ch = xs[i] - xs[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, ch)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -ch)) / period;
  }
  return { value: rsiFromAverages(avgGain, avgLoss), avgGain, avgLoss, lastClose: xs.at(-1) };
}

/** RSI from Wilder averages. avgLoss === 0 is defined as 100, matching indicators.mjs. */
export function rsiFromAverages(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Advance a Wilder RSI state ONE step with the next close — the live/provisional step the browser
 * performs with the current price. Returns the next `{ value, avgGain, avgLoss, lastClose }`.
 * `wilderRsiState(xs.slice(0, k + 1))` must equal `advanceWilderRsi(wilderRsiState(xs.slice(0, k)), xs[k])`,
 * which is the contract the stored state exists to satisfy and the verifier asserts.
 */
export function advanceWilderRsi(state, nextClose, period = 14) {
  if (!state || !Number.isFinite(nextClose) || !Number.isFinite(state.lastClose)) return null;
  const ch = nextClose - state.lastClose;
  const avgGain = (state.avgGain * (period - 1) + Math.max(0, ch)) / period;
  const avgLoss = (state.avgLoss * (period - 1) + Math.max(0, -ch)) / period;
  return { value: rsiFromAverages(avgGain, avgLoss), avgGain, avgLoss, lastClose: nextClose };
}
