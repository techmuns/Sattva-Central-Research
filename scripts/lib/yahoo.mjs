// lib/yahoo.mjs — the shared Yahoo Finance chart fetcher.
//
// Extracted from scrape-technicals.mjs so every caller shares one code path rather than a
// second, subtly-different copy. Two fetchers against the same endpoint drift: one gains a
// retry, the other keeps a bug, and the two feeds disagree about what a close price is.
//
//   import { fetchBars, sleep } from './lib/yahoo.mjs';
//   const bars = await fetchBars('RELIANCE.NS', new Date('2023-01-01'), new Date());
//
// Yahoo Chart v8 is public and needs no auth. NSE tickers carry a `.NS` suffix; the index is
// `^CRSLDX` (Nifty 500).

export const INDEX_SYMBOL = '^CRSLDX';
export const USER_AGENT = 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// A DAILY BAR IS NOT A CLOSE UNTIL THE SESSION HAS ENDED.
//
// Yahoo's daily series includes the CURRENT session as a bar while the market is open, with
// `close` set to the last trade so far. The technicals scrape is scheduled at 07:00 IST, before
// the open, so for months the last bar was always yesterday's real close. Then GitHub's
// best-effort scheduler started running it four to five hours late — 11:36 IST on 2 Sept — and
// the "close" the dashboard printed for that day was a mid-morning print. Hero MotoCorp read
// "fell 6.7% at the close" for a day that ended down 4.6%; Macpower CNC read −5.7% against the
// 31 August close because Yahoo had not yet published 1 September's bar at all.
//
// So: a bar dated today (IST) is complete only once the session is over. NSE closes at 15:30
// IST and the closing figures settle in the minutes after, so the cut is 16:00 IST. Everything
// else in the series is a finished day and stays.
// ---------------------------------------------------------------------------------------
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const SESSION_SETTLED_IST_MINUTES = 16 * 60;

/** The IST calendar date of an instant, as YYYY-MM-DD. */
export const istDay = (value = new Date()) => new Date(new Date(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Minutes since midnight IST. */
const istMinutes = (value = new Date()) => {
  const d = new Date(new Date(value).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * The bars that describe finished sessions: the trailing bar is dropped when it is dated today
 * (IST) and today's session has not settled yet. `.meta` is carried across.
 */
export function completedBars(bars, now = new Date()) {
  if (!Array.isArray(bars) || !bars.length) return bars;
  const last = bars.at(-1);
  const inProgress = last?.date === istDay(now) && istMinutes(now) < SESSION_SETTLED_IST_MINUTES;
  if (!inProgress) return bars;
  const out = bars.slice(0, -1);
  out.meta = bars.meta;
  return out;
}

/**
 * The move between the last two completed bars, with BOTH dates — because a percentage without
 * them cannot say whether it spans one session or three. `gapDays` is the calendar distance;
 * a weekend is 3, a weekend plus one holiday is 4. A gap wider than that is not a day move
 * and returns null: the upstream skipped a session, and the number would be a two-day move
 * wearing a one-day label.
 */
export const MAX_DAY_MOVE_GAP_DAYS = 4;
export function dayMove(bars) {
  const last = bars?.at?.(-1);
  const prev = bars?.at?.(-2);
  if (!last || !prev || !(prev.close > 0)) return { pct: null, date: last?.date ?? null, prevDate: prev?.date ?? null, gapDays: null };
  const gapDays = Math.round((Date.parse(last.date) - Date.parse(prev.date)) / 86400000);
  const pct = gapDays > MAX_DAY_MOVE_GAP_DAYS ? null : ((last.close - prev.close) / prev.close) * 100;
  return { pct, date: last.date, prevDate: prev.date, gapDays };
}

/**
 * Daily OHLCV bars between two dates.
 *
 * Returns `[{ date, open, high, low, close, volume }]`, oldest first, with nulls dropped —
 * Yahoo occasionally inserts a null row at a non-trading day — and WITHOUT today's bar while
 * today's session is still open (see `completedBars`). The returned array carries a
 * non-enumerable-ish `.meta` property with Yahoo's snapshot fields, which the technicals
 * scraper reads for the bid/ask sentiment rule.
 *
 * Retries 3× with backoff, and treats 429 separately with a longer wait.
 */
export async function fetchBars(symbol, start, end, { includeInProgress = false } = {}) {
  const p1 = Math.floor(start.getTime() / 1000);
  const p2 = Math.floor(end.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  const headers = { 'User-Agent': USER_AGENT };

  let attempt = 0;
  let lastErr;
  while (attempt < 3) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 404) throw new Error('ticker not found');
      if (r.status === 429) {
        lastErr = new Error('rate limited');
        attempt++;
        await sleep(1500 * attempt);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result || !result.timestamp) throw new Error('no chart data');

      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0] || {};
      const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const close = q.close?.[i];
        const volume = q.volume?.[i];
        if (close == null || volume == null) continue;
        out.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          open: q.open?.[i] ?? close,
          high: q.high?.[i] ?? close,
          low: q.low?.[i] ?? close,
          close,
          adjustedClose: Number.isFinite(adjusted[i]) ? adjusted[i] : null,
          volume,
        });
      }
      out.meta = result.meta || {};
      // Completed sessions only, by default. `includeInProgress` is for a caller that wants the
      // live partial bar and knows it is one.
      return includeInProgress ? out : completedBars(out);
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw lastErr;
}
