// data/technicals.js — the live technicals feed, loaded once and cached.
//
// This is the only genuinely live data in the dashboard. It is fetched lazily the first
// time the Breakouts tab mounts (the other eight tabs shouldn't pay for a ~800KB file),
// scored once through the ported LKP model, and cached for the life of the page. Sub-view
// switches, scope changes and sorts all operate on the cached scored list — nothing here
// refetches or rescores.
//
//   await load();                 // idempotent; safe to await from every render()
//   all()                         // scored rows, best score first
//   forScope('portfolio')         // narrowed to the synced book (js/data/coverage.js)
//   byTicker('RELIANCE')          // one scored row
//   meta()                        // generated_at, source, counts, index, breadth
//
// A scored row is `{ ...scoreCompany(c), company: c }` — see scoring/tech-scoring.js.

import { scoreCompany } from '../scoring/tech-scoring.js';
import { filterByScope } from './scope.js';

const TECHNICALS_PATH = 'data/technicals.json';
const ATR_HISTORY_PATH = 'data/atr-history.json';
const SOURCE_OVERLAY_PATH = 'data/technicals-source.json';

let loadPromise = null;
let cache = null; // { meta, scored, byTicker }
let refreshPromise = null;
const subscribers = new Set();
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

// Revalidate the bounded capture; a General Alerts refresh must not reuse the page-lifetime cache.
export function refresh() {
  if (refreshPromise) return refreshPromise;
  if (loadPromise && !cache) return loadPromise;
  const previous = cache;
  refreshPromise = buildCache().then((next) => {
    subscribers.forEach((fn) => fn());
    return next;
  }).catch((error) => { cache = previous; throw error; })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/**
 * Fetch + score once. Concurrent callers share the same in-flight promise, and every later
 * call returns the cached result immediately.
 */
export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = buildCache().catch((err) => {
    loadPromise = null; // let a later mount retry rather than wedging the tab forever
    throw err;
  });
  return loadPromise;
}

async function buildCache() {
  const payload = await fetchJson(TECHNICALS_PATH);
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];

  // ATR trend accumulator — the ATR Stability rule reads `c.atr_history`. Optional: without
  // it the rule still scores on the absolute level and says the trend is pending.
  const atrHistory = await fetchJson(ATR_HISTORY_PATH).catch(() => ({}));
  for (const row of rows) {
    const hist = row.ticker && atrHistory[row.ticker];
    if (Array.isArray(hist)) row.atr_history = hist;
  }

  // Optional TradingView overlay. When technicals-source.json is present, its scraped
  // indicator values replace the OHLCV-derived ones so the dashboard shows what an analyst
  // would see on TradingView — and `_source_tech_fields` records which fields were
  // overwritten so rule-meta.js can label the Source chip accurately per rule.
  // We do not build that scraper here; this just honours the file if it appears.
  await applySourceOverlay(rows);

  const scored = rows.map((c) => scoreCompany(c)).sort(bestFirst);
  const byTicker = new Map();
  for (const s of scored) if (s.company?.ticker) byTicker.set(s.company.ticker.toUpperCase(), s);

  cache = {
    meta: {
      generated_at: payload?.generated_at ?? null,
      // The session the closes belong to — NOT when the file was written. See the scraper.
      price_date: payload?.price_date ?? null,
      price_date_rows: payload?.price_date_rows ?? null,
      move_verification: payload?.move_verification ?? null,
      source: payload?.source ?? null,
      index_symbol: payload?.index_symbol ?? null,
      index_close: payload?.index_close ?? null,
      index_6m_return: payload?.index_6m_return ?? null,
      market_breadth: payload?.market_breadth ?? null,
      company_count: payload?.company_count ?? rows.length,
      // How the coverage splits — see `coverage()` below. Absent on a payload written before the
      // scrape took the book as input, and `coverage()` treats that as "all index", which is what
      // such a file actually was.
      nse500_count: payload?.nse500_count ?? null,
      book_count: payload?.book_count ?? 0,
      partial_refresh: payload?.partial_refresh ?? null,
      failures: payload?.failures ?? scored.filter((s) => s.tickerError).length,
      scored_count: scored.filter((s) => !s.tickerError).length,
    },
    scored,
    byTicker,
  };
  return cache;
}

// Rank: rows with data first, then by points desc, then by score % desc as a tiebreak.
function bestFirst(a, b) {
  if (!!a.tickerError !== !!b.tickerError) return a.tickerError ? 1 : -1;
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  return b.scorePct - a.scorePct;
}

// Committed static files, so `no-cache` and not `no-store`: revalidate on each load, and reuse the
// bytes already on disk when the server says they have not changed. `no-store` forbids reuse
// outright, which meant a 2MB corpus was re-downloaded in full on every single visit.
async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return res.json();
}

async function applySourceOverlay(rows) {
  let src;
  try {
    src = await fetchJson(SOURCE_OVERLAY_PATH);
  } catch {
    return; // absent by design today — nothing to overlay
  }
  const bySlug = src?.companies || {};
  for (const row of rows) {
    const s = row.ticker && bySlug[row.ticker.toUpperCase()];
    if (!s) continue;
    const o = s.oscillators || {};
    const ma = s.moving_averages || {};
    const sourced = new Set();
    if (o.rsi_14 != null) { row.rsi14 = o.rsi_14; sourced.add('rsi14'); }
    if (o.adx_14 != null) { row.adx14 = o.adx_14; sourced.add('adx14'); }
    if (ma.ema_50 != null) { row.ema50 = ma.ema_50; sourced.add('ema50'); }
    if (ma.sma_50 != null) { row.sma50 = ma.sma_50; sourced.add('sma50'); }
    if (ma.sma_200 != null) { row.sma200 = ma.sma_200; sourced.add('sma200'); }
    if (sourced.size) row._source_tech_fields = sourced;
  }
}

// ---- accessors (all synchronous; call load() first) --------------------------------------

export function all() {
  return cache ? cache.scored : [];
}

export function meta() {
  return cache ? cache.meta : null;
}

/**
 * How this feed's coverage splits, for the notes that used to just say "NSE 500".
 *
 * They said that because for a long time it was true — the scrape read an NSE-500 screener export
 * and nothing else, which meant a holding outside the index had no row here at all. It now also
 * carries every listed company in the book, so a label reading "NSE 500" over a list that is more
 * than that would be the wrong kind of wrong: not a missing number, a stated one that is false.
 */
export function coverage() {
  const m = meta();
  if (!m) return { total: 0, nse500: 0, book: 0, label: '' };
  const total = m.company_count ?? all().length;
  const book = m.book_count || 0;
  return {
    total,
    nse500: m.nse500_count ?? (total - book),
    book,
    label: book ? `NSE 500 + ${book} held` : 'NSE 500',
  };
}

export function byTicker(ticker) {
  if (!cache || !ticker) return null;
  return cache.byTicker.get(String(ticker).toUpperCase()) || null;
}

export function isLoaded() {
  return !!cache;
}

/**
 * forScope('universe') → every scored company.
 * forScope('portfolio', holdings) → only the tickers in the book.
 * forScope('watchlist') → only the companies the reader starred.
 * Filtering the cached list, never refetching.
 */
export function forScope(scope, holdings = []) {
  return filterByScope(all(), scope, holdings, (s) => s.company?.ticker);
}

/** Rows that actually scored — the error rows are useful to count but not to rank. */
export function scoredOnly(rows = all()) {
  return rows.filter((s) => !s.tickerError);
}
