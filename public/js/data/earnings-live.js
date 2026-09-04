// data/earnings-live.js — the LIVE quarterly results feed.
//
//   await load();            // snapshot first paint, then one live fetch
//   all()                    // joined rows, newest result first
//   meta()                   // quarter, freshness, provenance, degraded reason
//   forScope(scope, holds)   // portfolio holdings vs the whole universe
//   startLive(live) / stopLive(live)
//   onChange(fn)             // fires on every tick that actually changed something
//   newArrivals()            // companies that appeared since this page loaded
//
// HOW "LIVE" ACTUALLY WORKS HERE
//   First paint reads whatever this device already holds (core/store.js, IndexedDB) so the table
//   is populated with no network at all. Then the tab polls /api/earnings, which proxies
//   Moneycontrol behind a 30s edge cache. A company that files at 14:32 is on screen by ~14:33.
//
//   The poller only repaints when something CHANGED — a new company, a revised figure. Repainting
//   a 1,300-row table every 30s regardless would fight the user's scroll position and sort for no
//   reason.
//
// WHAT ACTUALLY TRAVELS ON A TICK
//   The payload is 1.1MB of JSON, and re-fetching it every 30 seconds to discover that nothing has
//   changed is the largest waste this dashboard is capable of. So the poll asks for
//   /api/earnings?fields=prices — scID -> [ltp, changePct] and a `structureTag`, about 10KB. The
//   full feed is re-fetched only when that tag moves, which is exactly when a company has filed or
//   revised a figure. Everything else is served out of the device's own copy.
//
//   THE STORE HOLDS THE SERVER'S BYTES, NOT OURS. A stored payload is always exactly the
//   representation its ETag describes — price updates from the projection are folded into memory
//   and never written back. That invariant is the whole reason a 304 can be trusted: it says "you
//   already have this", and we must actually have it.
//
// THREE JOINS, ALL OF WHICH CAN LEGITIMATELY MISS
//   1. scId -> NSE ticker, via the committed map. Moneycontrol truncates company names to 15
//      characters, so the name is a label and never a key. No ticker => no ticker shown.
//   2. ticker -> market cap + industry, from universe.json (the NSE-500 export). A company
//      outside the NSE 500 has neither, and shows "—".
//   3. (ticker, resultDate) -> the close on the result day, from result-returns.json. Combined
//      with the live price this gives Return since result. No base price => "—".
//   Every miss renders as an em dash. None of them renders as zero, because "we could not join
//   this" and "this is zero" are different claims.

import { adaptUniverse } from './universe.js';
import { filterByScope } from './scope.js';
import { KEYS, conditionalJson, readEntry, revalidatedJson, isPersistent } from '../core/store.js';

const SNAPSHOT_PATH = 'data/earnings-live.json';
const TICKER_MAP_PATH = 'data/mc-ticker-map.json';
const RETURNS_PATH = 'data/result-returns.json';
const LIVE_ENDPOINT = 'api/earnings';

export const LIVE_ID = 'earnings-live';
export const POLL_MS = 30000;

// The comparison basis. Moneycontrol serves both from the same endpoint and the current-period
// figures are identical between them — only the PRIOR period changes, YoY against the same
// quarter last year, QoQ against the previous quarter. So this is a different question about the
// same filing, not a different feed.
export const SUB_TYPES = [
  { value: 'yoy', label: 'YoY' },
  { value: 'qoq', label: 'QoQ' },
];
const DEFAULT_SUB_TYPE = 'yoy';
let subType = DEFAULT_SUB_TYPE;

let loadPromise = null;
let cache = null; // the ACTIVE { rows, meta, byTicker }
// One cache per sub-type, so switching back is instant and neither can be shown under the other's
// headers. The committed snapshot is YoY only — see `setSubType`.
const bySubType = new Map();
// The last FULL payload per sub-type, as received. Prices from the projection are folded onto this
// and re-ingested, so market cap and return-since-result are always recomputed by the same code
// that computed them at load rather than by a second, price-only derivation that could drift.
const rawBySubType = new Map();
let tickerMap = null;
let returnsBase = null;
let universeIndex = null;
let seenScIds = null; // populated on first successful load; anything new after that is an arrival
let arrivals = [];
const listeners = new Set();

const endpointFor = (st) => `${LIVE_ENDPOINT}?subType=${encodeURIComponent(st)}`;
const pricesEndpointFor = (st) => `${LIVE_ENDPOINT}?subType=${encodeURIComponent(st)}&fields=prices`;
const storeKey = (st) => KEYS.earnings(st);
const priceStoreKey = (st) => `${KEYS.earnings(st)}:prices`;
const structureTagFor = (st) => rawBySubType.get(st)?.meta?.structureTag || null;

export function currentSubType() {
  return subType;
}

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
  // The three join tables are optional: without them the feed still renders, just with fewer
  // columns filled. `revalidatedJson` lets the browser reuse them across loads instead of
  // re-downloading half a megabyte of lookup tables every visit.
  const [map, returns, universeRaw] = await Promise.all([
    revalidatedJson(TICKER_MAP_PATH, { optional: true }),
    revalidatedJson(RETURNS_PATH, { optional: true }),
    revalidatedJson('data/universe.json', { optional: true }),
  ]);

  tickerMap = map?.map || {};
  returnsBase = returns?.base || {};
  universeIndex = buildUniverseIndex(universeRaw);

  // 1. Whatever this device already holds, on screen with no network at all.
  const stored = await readEntry(storeKey(subType));
  if (stored?.value?.rows?.length) ingest(stored.value, { live: true, origin: 'store', checkedAt: stored.savedAt });

  // 2. Ask the Worker what has changed since. Carrying the stored ETag means the answer is usually
  //    a bodyless 304 — a couple of hundred bytes instead of 1.1MB. Deliberately optional: a
  //    missing Worker (plain `python3 -m http.server`) must not stop the tab rendering.
  const out = await conditionalJson(endpointFor(subType), { key: storeKey(subType), optional: true });
  if (out.status === 200 && out.value?.rows?.length) ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
  else if (out.status === 304) markChecked('live', out.checkedAt);

  // 3. The committed snapshot, last and only when it is needed: on a first visit with no Worker,
  //    or when the live route is unreachable and a redeploy may have shipped something newer than
  //    the copy on this device. It is 1.1MB, so it is never fetched speculatively.
  if (!cache || out.status === 0) {
    const snapshot = await revalidatedJson(SNAPSHOT_PATH, { optional: !!cache });
    if (snapshot?.rows?.length && isNewerThanHeld(snapshot)) ingest(snapshot, { live: false, origin: 'snapshot', checkedAt: Date.now() });
  }

  if (!cache) throw new Error(`${SNAPSHOT_PATH} could not be loaded and no cached copy exists.`);
  return cache;
}

/**
 * Is a payload newer than the one we are already showing?
 *
 * Only asked of the committed snapshot, and only when the live route is down. Without a stamp to
 * compare, the honest answer is no — replacing a copy we know the age of with one we do not would
 * make the freshness label a guess.
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
 * Record that the server confirmed our copy, without rebuilding a single row. This is what a 304
 * means and it is worth showing: "as of 09:14, last checked 14:31" is a different and more useful
 * claim than either half alone.
 */
function markChecked(origin, at) {
  if (!cache) return;
  cache.meta = { ...cache.meta, origin, checkedAt: at || Date.now() };
}

/**
 * Switch the comparison basis. Resolves to the new cache, or throws if the switch could not be
 * made — the caller repaints on success and says what happened on failure.
 *
 * WHY THIS CAN FAIL AND MUST BE ALLOWED TO
 *   The committed snapshot is YoY. There is no QoQ file on disk, and there deliberately isn't one:
 *   the two differ only in the prior-period column, so a stale QoQ snapshot would look exactly
 *   like a live one while comparing against the wrong quarter. If the live endpoint is
 *   unreachable, QoQ genuinely cannot be shown, and saying so is the only honest option —
 *   silently leaving YoY numbers under QoQ headers would be the worst outcome available.
 *
 *   A QoQ payload held in the device's own store is a different case and IS shown: it is real QoQ
 *   under QoQ headers, so nothing is mislabelled. What it can be is old, and that is answered the
 *   same way everything else here is — `meta.origin` and `meta.checkedAt` travel with it and the
 *   Live pill says when it was last confirmed.
 */
export async function setSubType(next) {
  const wanted = SUB_TYPES.some((s) => s.value === next) ? next : DEFAULT_SUB_TYPE;
  if (wanted === subType && cache) return cache;

  const cached = bySubType.get(wanted);
  if (cached) {
    subType = wanted;
    cache = cached;
    notify();
    return cache;
  }

  // The device may already hold this basis from an earlier visit. Show it at once and confirm in
  // the background — the toggle is instant on a warm store rather than a network round trip.
  const stored = await readEntry(storeKey(wanted));
  if (stored?.value?.rows?.length && (stored.value.meta?.subType || wanted) === wanted) {
    subType = wanted;
    ingest(stored.value, { live: true, origin: 'store', checkedAt: stored.savedAt });
    notify();
    confirmInBackground(wanted);
    return cache;
  }

  const out = await conditionalJson(endpointFor(wanted), { key: storeKey(wanted), optional: true });
  const payload = out.value;
  if (!payload?.rows?.length) {
    throw new Error(
      wanted === DEFAULT_SUB_TYPE
        ? 'The results feed is unreachable.'
        : `${wanted.toUpperCase()} needs the live feed, which is unreachable right now. Only ${DEFAULT_SUB_TYPE.toUpperCase()} ships as a committed snapshot.`
    );
  }
  // The server must have answered the question we asked. A payload that says `yoy` when we asked
  // for `qoq` is the one failure that would be invisible downstream — the current-period figures
  // are identical, so it would look right while comparing against the wrong quarter. Refuse it.
  const served = payload.meta?.subType || null;
  if (served && served !== wanted) {
    throw new Error(`The feed answered with ${served.toUpperCase()} when ${wanted.toUpperCase()} was requested, so the comparison would have been mislabelled.`);
  }
  subType = wanted;
  ingest(payload, { live: true, origin: 'live', checkedAt: out.checkedAt });
  notify();
  return cache;
}

/** Revalidate a basis we painted from the store. Silent on 304; repaints through `notify` on 200. */
function confirmInBackground(wanted) {
  conditionalJson(endpointFor(wanted), { key: storeKey(wanted), optional: true })
    .then((out) => {
      if (subType !== wanted) return; // the reader moved on; do not overwrite what they are looking at
      if (out.status === 200 && out.value?.rows?.length && (out.value.meta?.subType || wanted) === wanted) {
        ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
        notify();
      } else if (out.status === 304) {
        markChecked('live', out.checkedAt);
        notify();
      }
    })
    .catch(() => {});
}

function buildUniverseIndex(raw) {
  if (!Array.isArray(raw)) return new Map();
  const idx = new Map();
  for (const c of adaptUniverse(raw)) {
    if (c.ticker) idx.set(String(c.ticker).toUpperCase(), c);
  }
  return idx;
}

/**
 * Fold a payload into the cache. Shared by the snapshot and every live tick so the two can never
 * diverge in shape — the same join, the same derivations, one code path.
 */
function ingest(payload, { live, origin = 'live', checkedAt = Date.now() }) {
  const rows = (payload?.rows || []).map(joinRow).sort(byNewestResult);

  const isFirst = seenScIds === null;
  if (isFirst) {
    seenScIds = new Set(rows.map((r) => r.scId));
  } else {
    const fresh = rows.filter((r) => !seenScIds.has(r.scId));
    for (const r of fresh) {
      seenScIds.add(r.scId);
      // Newest first, and capped: this drives a "just reported" strip, not an audit log.
      arrivals.unshift({ ...r, seenAt: Date.now() });
    }
    arrivals = arrivals.slice(0, 40);
  }

  const byTicker = new Map();
  for (const r of rows) if (r.ticker) byTicker.set(r.ticker, r);

  // Indexed by result date, because the calendar half of the tab asks "who filed on this day?"
  // on every date click. Scanning 1,722 rows per click is affordable and building the index once
  // per ingest is free, and it also gives us the window the feed actually covers — which is the
  // difference between "nobody reported" and "we do not carry that date".
  const byDate = new Map();
  for (const r of rows) {
    if (!r.resultDate) continue;
    const list = byDate.get(r.resultDate);
    if (list) list.push(r);
    else byDate.set(r.resultDate, [r]);
  }
  let firstDate = null;
  let lastDate = null;
  for (const d of byDate.keys()) {
    if (!firstDate || d < firstDate) firstDate = d;
    if (!lastDate || d > lastDate) lastDate = d;
  }

  cache = {
    rows,
    byTicker,
    byDate,
    dateRange: { first: firstDate, last: lastDate },
    meta: {
      ...(payload?.meta || {}),
      latestResultDate: payload?.latestResultDate ?? null,
      count: rows.length,
      isLive: live && !payload?.degraded,
      degraded: payload?.degraded || null,
      // Which comparison this cache holds. The UI labels its columns from `currentPeriod` /
      // `priorPeriod`, so this and those must always come from the same payload.
      subType: payload?.meta?.subType || subType,
      // What each optional join actually managed, so the UI can be specific about gaps rather
      // than showing dashes with no explanation.
      mappedTickers: rows.filter((r) => r.ticker).length,
      withMarketCap: rows.filter((r) => r.marketCap != null).length,
      withReturn: rows.filter((r) => r.returnSinceResult != null).length,
      receivedAt: Date.now(),
      // Where THIS paint came from, and when the server last confirmed it. Two different claims:
      // `fetchedAt` is when Moneycontrol was read, `checkedAt` is when we last asked whether that
      // was still current. A 304 moves the second and not the first, which is the honest reading.
      origin,
      checkedAt,
      persisted: isPersistent(),
    },
  };
  bySubType.set(cache.meta.subType, cache);
  rawBySubType.set(cache.meta.subType, payload);
  return cache;
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(cache);
    } catch (err) {
      console.error('[earnings-live] listener failed', err);
    }
  }
}

function joinRow(raw) {
  const mapped = tickerMap?.[raw.scId] || null;
  const ticker = raw.ticker || mapped?.ticker || null;
  const uni = ticker ? universeIndex?.get(ticker) : null;

  // Market cap, computed LIVE rather than stored. The map holds the share count, which barely
  // moves; multiplying it by the price on this very tick gives a market cap that is correct now
  // instead of correct whenever the map was last built. Falls back to universe.json (a curated
  // but hand-refreshed export) and then to the count-times-price captured at build time.
  //   shares × price is in rupees; ÷ 1e7 gives crore.
  const shares = raw.shares ?? mapped?.shares ?? null;
  const liveCap = shares && raw.ltp ? (shares * raw.ltp) / 1e7 : null;
  const marketCap = liveCap ?? uni?.marketCap ?? raw.mktCapAtBuild ?? mapped?.mktCapAtBuild ?? null;

  // Return since result: base is the close on the result day (immutable, cached); the current
  // price is Moneycontrol's live `ltp`. So this figure moves on every tick, which is the point.
  const baseKey = ticker && raw.resultDate ? `${ticker}@${raw.resultDate}` : null;
  const baseEntry = baseKey ? returnsBase?.[baseKey] : null;
  const base = baseEntry?.close ?? null;
  const returnSinceResult = base != null && base > 0 && raw.ltp != null ? ((raw.ltp - base) / base) * 100 : null;

  return {
    ...raw,
    ticker,
    // Moneycontrol truncates to 15 chars; the price feed carries the full legal name, and
    // universe.json is better still. Prefer the longest thing we actually know.
    company: uni?.name || raw.fullName || mapped?.fullName || raw.name,
    shortName: raw.name,
    marketCap,
    marketCapIsLive: liveCap != null,
    // universe.json's industry is the curated one and wins where it exists; Moneycontrol's
    // subsector fills in the ~69% of reporters that sit outside the NSE-500 export.
    industry: uni?.industry || uni?.sector || raw.industry || mapped?.industry || null,
    inUniverse: !!uni,
    basePrice: base,
    basePricedOn: baseEntry?.pricedOn ?? null,
    returnSinceResult,
  };
}

/**
 * Newest result first — and within a date, MONEYCONTROL'S OWN ORDER.
 *
 * `resultDate` is a date; filings arrive through the day. Nine companies reported on 11 Aug and
 * the upstream returns them in the order they reported. An earlier version tie-broke on the size
 * of the profit move instead, which looked reasonable and was wrong: it reshuffled the top of the
 * table so "latest results" showed neither the latest nor Moneycontrol's list, and the two sources
 * disagreed on screen about the same quarter. `seq` is the upstream index — see worker/mc.mjs.
 */
function byNewestResult(a, b) {
  if (a.resultDate !== b.resultDate) return String(b.resultDate || '').localeCompare(String(a.resultDate || ''));
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/**
 * Sort key for the Date column, descending: newest date first, and within a date the upstream
 * order. Encoded as one string because `scoreTable` sorts on a single value — the inverted `seq`
 * makes a smaller upstream index sort higher under a descending sort.
 */
export function dateSortValue(r) {
  return `${r.resultDate || ''}|${String(999999 - (r.seq ?? 0)).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------------------
// Live polling
// ---------------------------------------------------------------------------------------

/**
 * Register + start the poller on the shared live engine. The fetcher returns null when nothing
 * has changed, and `paint` is only called for real changes — see the header.
 */
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      // Always the ACTIVE sub-type: the poller follows the toggle rather than pinning whichever
      // basis happened to be selected when it was registered.
      const st = subType;

      // THE TICK ASKS FOR PRICES, NOT FOR THE FEED. Measured: 30KB against 1.1MB, and when even
      // the prices have not moved the browser's revalidation makes it 0.3KB on the wire. The
      // `structureTag` in the reply is what tells us whether the rows underneath those prices are
      // still the rows we hold.
      const out = await conditionalJson(pricesEndpointFor(st), { key: priceStoreKey(st), optional: true });
      if (!out.value?.prices) return null;
      // A tick that arrives for the basis the user has since switched away from is dropped rather
      // than folded in — it would overwrite the active cache with the other comparison.
      if (st !== subType || (out.value.meta?.subType || st) !== st) return null;
      // Fallback prices are real retained values, but they are not a successful current read. Do
      // not apply them or let a matching structure tag short-circuit away the degraded state.
      if (out.value.degraded) {
        const healthChanged = markProjectionChecked(out.value, out.checkedAt);
        return healthChanged ? cache : null;
      }

      const held = structureTagFor(st);
      if (held && out.value.structureTag === held) {
        // Same rows, possibly moved prices. Refresh the cache but do NOT notify: repainting 1,300
        // rows because someone traded would rebuild the table and throw away whatever the reader
        // had sorted or searched, for no new information about any result.
        const healthChanged = markProjectionChecked(out.value, out.checkedAt);
        applyPrices(out.value);
        return healthChanged ? cache : null;
      }

      // Either a company has filed or revised, or we have nothing to compare against yet (the
      // committed snapshot carries no structure tag). Now — and only now — pull the full feed.
      const full = await conditionalJson(endpointFor(st), { key: storeKey(st), optional: true });
      if (st !== subType) return null;
      const failure = structuralRefreshFailure(full, st, out.value.structureTag);
      if (failure) {
        const healthChanged = markStructuralRefreshFailed(failure, full.checkedAt || out.checkedAt);
        return healthChanged ? cache : null;
      }
      const structural = hasStructuralChange(full.value);
      ingest(full.value, { live: true, origin: 'live', checkedAt: full.checkedAt });
      return structural ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    notify();
  });
  live.start(LIVE_ID, { fresh: true });
  return () => {
    off();
    live.stop(LIVE_ID);
  };
}

/**
 * Revalidate the active feed once without starting the 30-second poller.
 *
 * General Alerts uses this for its explicit Refresh button. The prices projection keeps an unchanged
 * check tiny; the full payload is pulled only when the structure tag says a result appeared or was
 * revised. Calling `load()` again cannot do this because that function is intentionally idempotent.
 */
export async function refresh() {
  await load();
  const st = subType;
  const out = await conditionalJson(pricesEndpointFor(st), { key: priceStoreKey(st), optional: true });
  if (!out.value?.prices || st !== subType || (out.value.meta?.subType || st) !== st) return cache;
  if (out.value.degraded) {
    const healthChanged = markProjectionChecked(out.value, out.checkedAt);
    if (healthChanged) notify();
    return cache;
  }

  const held = structureTagFor(st);
  if (held && out.value.structureTag === held) {
    const healthChanged = markProjectionChecked(out.value, out.checkedAt);
    if (healthChanged) notify();
    applyPrices(out.value);
    return cache;
  }

  const full = await conditionalJson(endpointFor(st), { key: storeKey(st), optional: true });
  if (st !== subType) return cache;
  const failure = structuralRefreshFailure(full, st, out.value.structureTag);
  if (failure) {
    const healthChanged = markStructuralRefreshFailed(failure, full.checkedAt || out.checkedAt);
    if (healthChanged) notify();
    return cache;
  }
  const changed = hasStructuralChange(full.value);
  ingest(full.value, { live: true, origin: 'live', checkedAt: full.checkedAt });
  if (changed) notify();
  return cache;
}

/**
 * A projection with a different structure tag proves the held rows are old. Only a fresh, full
 * response can clear that condition; a 304/store replay or a degraded/empty response cannot.
 */
export function structuralRefreshFailure(out, expectedSubType, projectedStructureTag = null) {
  if (!out || out.status !== 200 || out.fromStore) {
    return `the full results refresh failed${out?.status ? ` (HTTP ${out.status})` : ''}`;
  }
  const payload = out.value;
  if (!payload?.rows?.length) return 'the full results refresh returned no rows';
  if ((payload.meta?.subType || expectedSubType) !== expectedSubType) {
    return `the full results refresh answered with ${(payload.meta?.subType || 'an unknown comparison').toUpperCase()}`;
  }
  if (payload.degraded) return `the full results refresh degraded (${payload.degraded})`;
  const fullTag = payload.meta?.structureTag || payload.structureTag || null;
  if (projectedStructureTag && fullTag && fullTag !== projectedStructureTag) {
    return 'the full results refresh did not contain the structure reported by the prices feed';
  }
  return null;
}

function markStructuralRefreshFailed(reason, at) {
  if (!cache) return false;
  const changed = String(cache.meta.degraded || '') !== String(reason || '');
  cache.meta = {
    ...cache.meta,
    degraded: reason,
    isLive: false,
    origin: 'live',
    checkedAt: at || Date.now(),
  };
  return changed;
}

/** Record whether the lightweight price read itself reached the upstream. */
function markProjectionChecked(payload, at) {
  if (!cache) return false;
  const degraded = payload?.degraded || null;
  const changed = String(cache.meta.degraded || '') !== String(degraded || '');
  cache.meta = {
    ...cache.meta,
    degraded,
    isLive: !degraded,
    origin: 'live',
    checkedAt: at || Date.now(),
  };
  return changed;
}

export function stopLive(live) {
  live?.stop?.(LIVE_ID);
}

/**
 * Fold a prices projection onto the full payload we hold and re-ingest.
 *
 * Re-ingesting rather than patching the derived rows in place is deliberate: market cap is
 * `shares × price` and return-since-result is measured against the result-day close, so both move
 * with the price. Recomputing them anywhere but `joinRow` is exactly how the two would drift.
 *
 * The store is NOT rewritten here. It holds the server's own bytes under the server's own ETag,
 * and a locally-patched copy under a tag that no longer describes it would make the next 304 a
 * lie. Prices are re-applied from the projection after every load instead.
 */
function applyPrices(pricePayload) {
  const st = pricePayload.meta?.subType || subType;
  const raw = rawBySubType.get(st);
  if (!raw?.rows?.length) return false;

  let moved = 0;
  const rows = raw.rows.map((r) => {
    const p = pricePayload.prices?.[r.scId];
    if (!p) return r;
    const [ltp, changePct] = p;
    if (ltp === r.ltp && changePct === r.changePct) return r;
    moved++;
    return { ...r, ltp, changePct };
  });
  if (!moved) return false;

  ingest({ ...raw, rows }, { live: true, origin: 'live', checkedAt: Date.now() });
  return true;
}

/**
 * Did anything happen that is worth rebuilding the screen for?
 *
 * Deliberately EXCLUDES the traded price. Prices move every tick; results do not. Including the
 * price here would mean a structural repaint every 30 seconds all day, which throws away the
 * user's sort and search for no new information.
 */
function hasStructuralChange(payload) {
  if (!cache) return true;
  if ((payload.meta?.subType || subType) !== cache.meta.subType) return true;
  if ((payload.rows?.length ?? 0) !== cache.meta.count) return true;
  if ((payload.latestResultDate ?? null) !== (cache.meta.latestResultDate ?? null)) return true;
  if (!!payload.degraded !== !!cache.meta.degraded) return true;
  return fingerprint(payload.rows) !== fingerprint(cache.rows);
}

/**
 * An ORDER-INDEPENDENT checksum over identity and the reported figures.
 *
 * Order-independent matters: the payload arrives in Moneycontrol's sort order while the cache is
 * held in ours, so any order-sensitive hash reports "changed" on every single tick — which is
 * exactly the bug this replaced. Summing the per-row hashes removes order from the result.
 *
 * A hash collision would mean a missed update until the next real change. With the row count in
 * the key and a 32-bit mix over four fields, that is not a risk worth more machinery than this.
 */
function fingerprint(rows = []) {
  let total = 0;
  for (const r of rows) {
    // Prior is in here as well as current: the two sub-types share every current-period figure and
    // differ only in the comparison, so a checksum over `current` alone cannot tell them apart.
    const tok = `${r.scId}|${r.resultDate}|${r.netProfit?.current ?? ''}|${r.netProfit?.prior ?? ''}|${r.revenue?.current ?? ''}|${r.revenue?.prior ?? ''}`;
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
    total = (total + h) | 0; // sum: row order cannot affect this
  }
  return `${rows.length}:${total}`;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export function all() {
  return cache ? cache.rows : [];
}
export function meta() {
  return cache ? cache.meta : null;
}
export function byTicker(t) {
  return cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null;
}
export function isLoaded() {
  return !!cache;
}
export function newArrivals() {
  return arrivals;
}
export function clearArrivals() {
  arrivals = [];
}

/**
 * Every company that FILED on one date, in the upstream's own order within the day.
 *
 * This is a measurement, not a schedule: these companies have published. The calendar half of the
 * Earnings Hub uses it for any date that has already happened, because for a past date "who was
 * due" is the weaker question and Moneycontrol only answer it twenty companies at a time — where
 * this is every one of them, already on the device, with the reported figures attached.
 */
export function reportedOn(iso) {
  return (cache?.byDate?.get(iso) || []).slice();
}

/** How many filed on one date. The date strip asks this once per chip, so it must not copy. */
export function reportedCount(iso) {
  return cache?.byDate?.get(iso)?.length || 0;
}

/**
 * The span of result dates this feed carries, as `{ first, last }` (nulls before first load).
 *
 * Needed to tell two very different empty answers apart: a date inside the window with nothing on
 * it means nobody filed that day, and a date before `first` means this feed does not reach back
 * that far. Rendering both as an empty table would state the first while meaning the second.
 */
export function dateRange() {
  return cache?.dateRange || { first: null, last: null };
}

/**
 * forScope('portfolio', holdings) narrows to the tickers actually held; 'universe' is everything
 * that has reported. Filtering the cached list — never a refetch.
 */
export function forScope(scope, holdings = []) {
  return filterByScope(all(), scope, holdings);
}
