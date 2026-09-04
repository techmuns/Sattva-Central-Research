// data/concall-scans.js — live current-quarter analysis plus Screener's retained document index.
//
//   await load();                 // snapshot first paint, then one live fetch
//   all()                         // calls, newest first
//   upcoming() / today()          // the schedule
//   meta()                        // quarter, freshness, provenance, degraded reason
//   forScope(scope, holdings)
//   startLive(live) / stopLive(live)
//   onChange(fn)                  // fires only on ticks that actually changed something
//   newArrivals()                 // rows that appeared or acquired their analysis since load
//
// HOW "LIVE" WORKS HERE
//   First paint reads whatever this device already holds (core/store.js, IndexedDB) so the table
//   is populated with no network at all. Then the tab polls /api/concalls every 30s, which
//   re-reads StockScans' newest page behind a 30s edge cache and the newest successful Screener
//   Actions artifact behind a 60s cache. A call analysed at 14:32 is on screen by about 14:33;
//   a newly collected document reaches an open tab on the same conditional poll.
//
// WHAT ACTUALLY TRAVELS ON A TICK
//   The combined payload is large and almost nothing on a con-call row moves on a tick — a row appears
//   when the call is held and changes once more when StockScans has analysed it. So the poll is a
//   conditional GET: it sends the ETag of the copy we hold, and 119 polls out of 120 come back as
//   a bodyless 304. The feed is re-sent only when a row genuinely changed, which is also the only
//   time we would have anything to repaint.
//
//   THE STORE HOLDS THE SERVER'S BYTES. A stored payload is exactly the representation its ETag
//   describes, so a 304 — "you already have this" — is always true of what we actually have.
//
// THE INTERESTING CHANGE IS NOT A NEW ROW
//   A concall appears on the feed when it is HELD, and acquires its score, sentiment and bullets
//   twenty-odd minutes later when StockScans has processed it. So the change worth repainting for
//   is usually an existing row gaining `resultScore` — not the row count moving. That is why the
//   fingerprint covers the analysis fields and why `newArrivals` counts "newly analysed" as an
//   arrival, not just "newly listed".
//
// THE SCORES ARE STOCKSCANS', NOT OURS
//   `resultScore`, `sentimentTier` and the `tags` bullets are their analysis, rendered unchanged
//   and attributed. We add no scoring of our own here — deliberately. See worker/stockscans.mjs.

import { resultTierOf, sentimentTierOf, docUrl, fingerprint, mergeScans } from './stockscans-shared.js';
import { filterByScope } from './scope.js';
import { KEYS, conditionalJson, readEntry, revalidatedJson, isPersistent } from '../core/store.js';

const SNAPSHOT_PATH = 'data/concall-scans.json';
const LIVE_ENDPOINT = 'api/concalls';
const STORE_KEY = KEYS.concalls;

export const LIVE_ID = 'concall-scans';
export const POLL_MS = 30000;

let loadPromise = null;
let cache = null; // { rows, byTicker, upcoming, today, meta }
let seenKeys = null; // key -> hadAnalysis, so "analysis landed" counts as an arrival
let arrivals = [];
const listeners = new Set();

/**
 * A ROW'S IDENTITY IS NOT (COMPANY, TIME) — measured, on this feed, today.
 *
 * The research provider can hold TWO analyses of ONE call: Supriya Lifescience's 14 Aug 11:00 call
 * appears twice, scoring 50.4 and 50.3 against two different documents. Both are theirs and both
 * are real, so neither may be dropped — but `${companyKey}|${when}` calls them the same row, and a
 * key that means two different rows is the failure `CLAUDE.md` names under *Performance on large
 * tables*: the screener's repaint holds `<tr>` nodes in a Map by key, so the collision silently
 * orphaned one node. It stayed in the DOM through every filter — a scored call sitting at the top
 * of "Awaiting analysis", out of sort order, which no row COUNT could ever catch.
 *
 * So the document is part of what identifies a row, and where even that repeats, a counter closes
 * it. The failure to prevent is one key meaning two rows; two keys meaning one row is not possible
 * here, because the id is derived from the row's own content and assigned in the feed's own order.
 */
const rowIdOf = (r) => `${r.companyKey}|${r.when}|${r.ssUrl || r.pptSsUrl || ''}`;

function assignRowIds(rows) {
  const counts = new Map();
  for (const r of rows) {
    const base = rowIdOf(r);
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    r.rowUid = n ? `${base}#${n}` : base;
  }
  return rows;
}

/** The stable per-row id. Exported because the tab keys its table and its Deep Dive cell on it. */
export const rowUid = (r) => r.rowUid || rowIdOf(r);

const keyOf = (r) => rowUid(r);

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // let a later mount retry rather than wedging the tab
    throw err;
  });
  return loadPromise;
}

async function build() {
  // 1. Whatever this device already holds, on screen with no network at all.
  const stored = await readEntry(STORE_KEY);
  if (stored?.value?.rows?.length) ingest(stored.value, { live: true, origin: 'store', checkedAt: stored.savedAt });

  // 2. Ask the Worker what has changed. With the stored ETag attached this is usually a bodyless
  //    304. The Worker has already merged its latest successful Screener Actions artifact into
  //    this representation. Deliberately optional: a missing Worker (plain `python3 -m http.server`)
  //    must not stop the tab rendering.
  const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
  if (out.status === 200 && out.value?.rows?.length) ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
  else if (out.status === 304) markChecked('live', out.checkedAt);

  // 3. The committed snapshot, last and only when needed — a first visit with no Worker, or an
  //    unreachable route where a redeploy may have shipped something newer than this device holds.
  if (!cache || out.status === 0) {
    const snapshot = await revalidatedJson(SNAPSHOT_PATH, { optional: !!cache });
    if (snapshot?.rows?.length && isNewerThanHeld(snapshot)) ingest(snapshot, { live: false, origin: 'snapshot', checkedAt: Date.now() });
  }

  if (!cache) throw new Error(`${SNAPSHOT_PATH} could not be loaded and no cached copy exists.`);
  return cache;
}

/**
 * Is a payload newer than the one on screen? Asked only of the committed snapshot, when the live
 * route is down. With no stamp to compare, the honest answer is no — swapping a copy whose age we
 * know for one whose age we do not would turn the freshness label into a guess.
 */
function isNewerThanHeld(payload) {
  if (!cache) return true;
  const incoming = Date.parse(payload?.meta?.fetchedAt || '');
  const held = Date.parse(cache.meta?.fetchedAt || '');
  if (!Number.isFinite(incoming)) return false;
  if (!Number.isFinite(held)) return true;
  return incoming > held;
}

/**
 * Record that the server confirmed our copy without rebuilding a row — what a 304 means. Worth
 * showing: "as of 19:18, last checked 14:31" says more than either half on its own.
 */
function markChecked(origin, at) {
  if (!cache) return;
  cache.meta = { ...cache.meta, origin, checkedAt: at || Date.now() };
}

function ingest(payload, { live, origin = 'live', checkedAt = Date.now() }) {
  const rows = assignRowIds((payload?.rows || []).map(decorate).sort(byNewest));

  const isFirst = seenKeys === null;
  if (isFirst) {
    seenKeys = new Map(rows.map((r) => [keyOf(r), r.resultScore != null]));
  } else {
    for (const r of rows) {
      const k = keyOf(r);
      const hadAnalysis = seenKeys.get(k);
      const isNew = !seenKeys.has(k);
      const justAnalysed = hadAnalysis === false && r.resultScore != null;
      if (isNew || justAnalysed) {
        arrivals.unshift({ ...r, seenAt: Date.now(), reason: isNew ? 'listed' : 'analysed' });
      }
      if (isNew || justAnalysed) seenKeys.set(k, r.resultScore != null);
    }
    arrivals = arrivals.slice(0, 40); // a "just in" strip, not an audit log
  }

  const byTicker = new Map();
  for (const r of rows) if (r.ticker && !byTicker.has(r.ticker)) byTicker.set(r.ticker, r);

  cache = {
    rows,
    byTicker,
    upcoming: (payload?.upcoming || []).slice().sort((a, b) => String(a.when || '').localeCompare(String(b.when || ''))),
    portfolioUpcoming: (payload?.portfolioUpcoming || []).slice().sort(
      (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '99:99').localeCompare(String(b.time || '99:99')),
    ),
    today: payload?.today || { day: null, rows: [] },
    meta: {
      ...(payload?.meta || {}),
      count: rows.length,
      analysed: rows.filter((r) => r.resultScore != null).length,
      isLive: live && !payload?.degraded,
      degraded: payload?.degraded || null,
      receivedAt: Date.now(),
      // Where this paint came from, and when the server last confirmed it. `fetchedAt` is when
      // StockScans was read; `meta.screener.checkedAt` dates the independent document capture;
      // `checkedAt` is when we last asked whether the combined representation was still current. A
      // 304 moves the second and not the first.
      origin,
      checkedAt,
      persisted: isPersistent(),
    },
  };
  return cache;
}

/**
 * Attach StockScans' own tier labels and the deep link. No arithmetic of ours touches the score —
 * `resultTierOf` applies their published bands, so the label we show is the label they show.
 */
function decorate(r) {
  return {
    ...r,
    resultTier: resultTierOf(r.resultScore),
    sentiment: sentimentTierOf(r.sentimentTier),
    transcriptUrl: docUrl({ ssUrl: r.ssUrl }),
    pptUrl: docUrl({ ssUrl: r.pptSsUrl }),
  };
}

function byNewest(a, b) {
  return String(b.when || '').localeCompare(String(a.when || ''));
}

// ---------------------------------------------------------------------------------------
// Live polling
// ---------------------------------------------------------------------------------------

export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      // A conditional GET. On an unchanged tick this is a 304 with no body at all and `status`
      // tells us so without touching a single row — the 450KB payload never crosses the wire.
      const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
      if (!out.value?.rows?.length) return null;
      if (out.status === 304) {
        markChecked('live', out.checkedAt);
        return null;
      }
      // Always refresh the cache; only NOTIFY on a real change, so a repaint never throws away
      // the reader's sort and search for a tick that carried nothing new.
      const changed = hasChanged(out.value);
      ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
      return changed ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[concall-scans] listener failed', err);
      }
    }
  });
  live.start(LIVE_ID, { fresh: true });
  return () => {
    off();
    live.stop(LIVE_ID);
  };
}

/** Revalidate once for surfaces that do not mount the shared 30-second poller. */
export async function refresh() {
  await load();
  const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
  if (!Array.isArray(out.value?.rows) || out.value?.ok === false) throw Error('Con-call revalidation failed; retained analysis is unchanged');
  if (!out.value?.rows?.length) return cache;
  if (out.status === 304) {
    markChecked('live', out.checkedAt);
    return cache;
  }
  const changed = hasChanged(out.value);
  ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
  if (changed) {
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[concall-scans] listener failed', err);
      }
    }
  }
  return cache;
}

export function stopLive(live) {
  live?.stop?.(LIVE_ID);
}

function hasChanged(payload) {
  if (!cache) return true;
  if ((payload.rows?.length ?? 0) !== cache.meta.count) return true;
  if (!!payload.degraded !== !!cache.meta.degraded) return true;
  const schedule = (rows) => JSON.stringify((rows || []).map((row) => [row.id, row.date, row.time, row.eventType, row.sourceUrl]));
  if (schedule(payload.portfolioUpcoming) !== schedule(cache.portfolioUpcoming)) return true;
  return fingerprint(payload.rows) !== fingerprint(cache.rows);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export const all = () => (cache ? cache.rows : []);
export const upcoming = () => (cache ? cache.upcoming : []);
export const portfolioUpcoming = () => (cache ? cache.portfolioUpcoming : []);
export const today = () => (cache ? cache.today : { day: null, rows: [] });
export const meta = () => (cache ? cache.meta : null);
export const isLoaded = () => !!cache;
export const newArrivals = () => arrivals;
export const byTicker = (t) => (cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null);

export function forScope(scope, holdings = [], rows = all()) {
  return filterByScope(rows, scope, holdings);
}

export { mergeScans };
