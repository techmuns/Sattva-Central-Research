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
import { validateScreenerUpcomingRows } from './screener-upcoming-shared.js';
import { filterByScope } from './scope.js';
import { KEYS, conditionalJson, readEntry, writeEntry, revalidatedJson, isPersistent } from '../core/store.js';

const SNAPSHOT_PATH = 'data/concall-scans.json';
const LIVE_ENDPOINT = 'api/concalls';
const STORE_KEY = KEYS.concalls;
const SCHEDULE_KEY = KEYS.concallPortfolioUpcoming;

export const LIVE_ID = 'concall-scans';
export const POLL_MS = 30000;

let loadPromise = null;
let cache = null; // { rows, byTicker, upcoming, today, meta }
// The last portfolio calendar anybody actually read: { rows, checkedAt, savedAt }. See `ingest`.
let heldSchedule = null;
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
  // 0. The retained portfolio calendar, BEFORE anything is ingested. Without it a reload during an
  //    S Screen outage repaints an empty Upcoming view from the stored response, which is the
  //    version of this failure that looks permanent — see `ingest`. Validated on the way in: these
  //    rows came from an upstream, and bytes off the device are not a reason to stop checking.
  try {
    const saved = await readEntry(SCHEDULE_KEY);
    const rows = saved?.value?.rows;
    // `Array.isArray`, not `rows.length`: a successful read of a dashboard with nothing scheduled
    // is an ANSWER, and one this device may hold as its newest. Gating on length dropped it, and
    // the older combined response then resurrected events that had been correctly cleared.
    if (Array.isArray(rows)) {
      heldSchedule = { rows: validateScreenerUpcomingRows(rows), checkedAt: saved.value.checkedAt || null, savedAt: saved.savedAt };
    }
  } catch { heldSchedule = null; }

  // 1. Whatever this device already holds, on screen with no network at all.
  const stored = await readEntry(STORE_KEY);
  if (stored?.value?.rows?.length) ingest(stored.value, { live: true, origin: 'store', checkedAt: stored.savedAt });

  // 2. Ask the Worker what has changed. With the stored ETag attached this is usually a bodyless
  //    304. The Worker has already merged its latest successful Screener Actions artifact into
  //    this representation. Deliberately optional: a missing Worker (plain `python3 -m http.server`)
  //    must not stop the tab rendering.
  const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
  // A CONFIRMATION IS A 304 OR A 200 WE ACTUALLY INGESTED, and nothing else. `conditionalJson`
  // reports what the server said — `status: 0` only for a request that never completed — so a 503
  // arrives as 503 and a 404 as 404. Reading only for 0 would have let every server-side failure
  // through as though the calendar had been checked.
  const confirmedLive = out.status === 304 || (out.status === 200 && !!out.value?.rows?.length);
  if (out.status === 200 && out.value?.rows?.length) ingest(out.value, { live: true, origin: 'live', checkedAt: out.checkedAt });
  else if (out.status === 304) markChecked('live', out.checkedAt);

  // 3. The committed snapshot, last and only when needed — a first visit with no Worker, or an
  //    unreachable route where a redeploy may have shipped something newer than this device holds.
  if (!cache || out.status === 0) {
    const snapshot = await revalidatedJson(SNAPSHOT_PATH, { optional: !!cache });
    if (snapshot?.rows?.length && isNewerThanHeld(snapshot)) ingest(snapshot, { live: false, origin: 'snapshot', checkedAt: Date.now() });
  }

  // The live route confirmed nothing, so neither did anything on screen — the calendar included.
  // Say so rather than serving the stored payload's own account of itself.
  if (!confirmedLive) markScheduleUnconfirmed();

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
  // AND IT LIFTS A RETENTION MARK. A 304 says the representation we hold is current — calendar
  // included — so an outage that marked it unconfirmed is over the moment one arrives. Without
  // this, recovery through an unchanged ETag never clears the flag (the bytes are identical, so
  // no content change is coming) and All Alerts reports the feed failed indefinitely while every
  // revalidation succeeds. It cannot clear a mark where the held representation supplied no
  // calendar: nothing has been confirmed about rows it never carried.
  const lifts = cache.meta.portfolioUpcomingSupplied && cache.meta.portfolioUpcomingConfirmed === false;
  cache.meta = { ...cache.meta, origin, checkedAt: at || Date.now(),
    portfolioUpcomingConfirmed: cache.meta.portfolioUpcomingSupplied ? true : cache.meta.portfolioUpcomingConfirmed,
    portfolioUpcomingRetained: cache.meta.portfolioUpcomingSupplied ? false : cache.meta.portfolioUpcomingRetained };
  // Whether this 304 CHANGED anything a consumer renders. The poller returns null on an unchanged
  // tick, so without this the lifted mark would sit in `meta` unread until All Alerts' own next
  // collection — the label lagging the data, which is the failure this whole change is about.
  return lifts;
}

/**
 * THE PORTFOLIO CALENDAR IS A SECOND UPSTREAM, AND ITS ABSENCE IS NOT AN EMPTY CALENDAR.
 *
 * `/api/concalls` assembles two independent sources: StockScans' analysed rows, and the
 * authenticated S Screen dashboard captured into an immutable Actions artifact. Either fails on
 * its own — a GitHub artifact read that times out, an expired collector token — and when
 * StockScans is the one that fails the Worker serves the committed snapshot, which is a capture
 * of StockScans alone and has never carried a calendar at all.
 *
 * Both used to arrive here as `[]`, which this module wrote straight over a good calendar; and
 * because the response is stored under the server's own ETag, the emptiness then survived every
 * reload until a healthy 200 happened to land. All Alerts' Upcoming view went to zero rows on an
 * outage in a feed it does not read.
 *
 * So a payload that carries no array retains what we hold. `[]` is a different claim — a
 * successful read of a dashboard with nothing on it — and does clear. Same rule as `failed`
 * rather than empty books in the investor snapshot, and as retained NSE rows beneath a shrinking
 * live window.
 */
function scheduleFrom(payload) {
  if (!Array.isArray(payload?.portfolioUpcoming)) return null;
  return payload.portfolioUpcoming.slice().sort(
    (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '99:99').localeCompare(String(b.time || '99:99')),
  );
}

/**
 * A LIVE READ THAT DID NOT HAPPEN IS NOT A CONFIRMATION OF WHAT IS ON SCREEN.
 *
 * Reloading with an unreachable Worker paints the stored response, and that response carries the
 * `meta.screener` of whichever read produced it — `status: 'ok'`, its own `checkedAt`. Left alone,
 * All Alerts reads that as a calendar confirmed just now, which is the exact claim this whole
 * change exists to stop being made: bytes off the device that no read has vouched for in this
 * session are RETAINED, whoever last wrote them and whatever they said at the time.
 *
 * `screener.status` is deliberately left as the upstream reported it — it describes the artifact
 * collector, not our ability to reach our own route, and overwriting it would conflate two
 * different failures. The retention flag is what the coverage note branches on.
 */
/** Every listener, in one place — the poller's failure path needs them as much as `refresh` does. */
function emit() {
  for (const fn of listeners) {
    try { fn(cache); } catch (err) { console.error('[concall-scans] listener failed', err); }
  }
}

/** Mark unconfirmed and report whether that actually changed the rendered metadata. */
function notifyIfScheduleUnconfirmed() {
  const before = cache?.meta.portfolioUpcomingConfirmed;
  markScheduleUnconfirmed();
  return !!cache && before !== cache.meta.portfolioUpcomingConfirmed;
}

function markScheduleUnconfirmed() {
  if (!cache || cache.meta.portfolioUpcomingConfirmed === false) return;
  // `confirmed` is about the READ and is cleared unconditionally: a last successful read can
  // legitimately have returned an empty dashboard, and an empty calendar nobody checked is still
  // a calendar nobody checked. `retained` is about the ROWS and may not be claimed where none
  // were held — on a first visit with an unreachable route this device has never captured the
  // calendar at all, and saying its empty result is "the retained rows from the last successful
  // capture" would invent a capture that never happened. Two facts, two flags.
  cache.meta = { ...cache.meta, portfolioUpcomingConfirmed: false, portfolioUpcomingRetained: !!heldSchedule };
}

function ingest(payload, { live, origin = 'live', checkedAt = Date.now() }) {
  const rows = assignRowIds((payload?.rows || []).map(decorate).sort(byNewest));
  const schedule = scheduleFrom(payload);
  const screener = payload?.meta?.screener || null;
  const suppliedAt = screener?.checkedAt || null;
  // A SUPPLIED CALENDAR OLDER THAN THE ONE WE HOLD IS NOT AN UPDATE. The two entries are written
  // separately — the large response through `conditionalJson`, this calendar under its own key —
  // so a quota failure or aborted transaction on the big one leaves a NEWER calendar beside an
  // OLDER response. The next reload restores the newer calendar first and would then adopt the
  // older response's copy over it, and write that back, rolling the calendar backward until some
  // later content change happened to correct it. Compare only where both sides date themselves:
  // an undated capture cannot be ordered and is taken as given, exactly as `isNewerThanHeld`
  // refuses to rank a snapshot carrying no stamp.
  const stale = !!schedule && !!suppliedAt && !!heldSchedule?.checkedAt && suppliedAt < heldSchedule.checkedAt;
  const adopted = schedule && !stale ? schedule : null;
  if (adopted) {
    heldSchedule = { rows: adopted, checkedAt: suppliedAt, savedAt: Date.now() };
    // Its own entry, never a patched copy of the response: `core/store.js` holds the server's own
    // bytes under the server's own tag, and that pairing is the whole basis for trusting a 304.
    void writeEntry(SCHEDULE_KEY, { value: { rows: adopted, checkedAt: suppliedAt } });
  }
  // `supplied` is a fact about the RESPONSE; `retained` is the claim made to a reader. They are
  // not the same and neither can be derived from the other: a payload that carried no calendar
  // while nothing was held supplies nothing and retains nothing.
  const supplied = !!schedule;
  const retained = !adopted && !!heldSchedule;

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
    portfolioUpcoming: adopted || heldSchedule?.rows || [],
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
      // The portfolio calendar's own provenance, deliberately separate from `checkedAt` above:
      // these rows can be older than the response that carried the rest of this payload, and a
      // surface that prints one time for both would date a retained calendar to a check that
      // never reached it. `retained` is what makes the Upcoming view say so out loud.
      portfolioUpcomingRetained: retained,
      portfolioUpcomingSupplied: supplied,
      // ONLY AN ADOPTED CALENDAR IS A CONFIRMED ONE, and `true` here was wrong twice. A payload
      // that carried none confirms nothing about the rows it left on screen; and a payload whose
      // calendar was REFUSED as stale certifies rows it did not supply — which would let the older
      // response vouch for the newer held ones, and let a later 304 clear their retention mark on
      // the strength of `supplied`. `confirmed` answers one question: did this read vouch for what
      // is now painted.
      portfolioUpcomingConfirmed: !!adopted,
      portfolioUpcomingCheckedAt: (adopted ? suppliedAt : heldSchedule?.checkedAt) || null,
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
      // A POLL THAT FAILED IS A CHECK THAT DID NOT HAPPEN, and this one is swallowed: `live.js`
      // backs off and never surfaces the error, so without this the calendar on an open tab keeps
      // reading as confirmed through an outage that began after the page loaded.
      if (!out.value?.rows?.length) {
        // And it has to REACH them. `live.js` catches this throw without invoking subscribers, so
        // marking `meta` alone leaves an open All Alerts view rendering its previous healthy status
        // until its own next collection — the flag corrected and nobody told, which is the same
        // failure as never correcting it.
        if (notifyIfScheduleUnconfirmed()) emit();
        throw Error('Con-call source could not be revalidated.');
      }
      if (out.status === 304) {
        // Notify only where the 304 lifted a retention mark — an ordinary unchanged tick still
        // repaints nothing, which is what keeps a reader's sort and search intact.
        return markChecked('live', out.checkedAt) ? cache : null;
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
  if (!Array.isArray(out.value?.rows) || out.value?.ok === false) {
    if (notifyIfScheduleUnconfirmed()) emit();
    throw Error('Con-call revalidation failed; retained analysis is unchanged');
  }
  if (!out.value?.rows?.length) {
    if (notifyIfScheduleUnconfirmed()) emit();
    return cache;
  }
  if (out.status === 304) {
    if (markChecked('live', out.checkedAt)) emit();
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
  // A CALENDAR ARRIVING OR GOING MISSING IS ITSELF A CHANGE, even when its rows are identical.
  // The coverage chip reads `portfolioUpcomingRetained`, so a transition nobody is told about
  // leaves All Alerts printing the previous answer — a retained calendar still labelled
  // confirmed, or a recovered one still labelled retained — until its own next collection.
  if (!!scheduleFrom(payload) !== cache.meta.portfolioUpcomingSupplied) return true;
  // The collector's own health is rendered too — `alert-sources.js` treats `collectorLatestFailed`
  // as its own leg of the incomplete predicate — so a workflow failing while its previous artifact
  // stays readable changes what is displayed without changing a single row.
  const health = (m) => JSON.stringify([m?.status ?? null, m?.collectorLatestFailed ?? null, m?.portfolioUpcomingAvailable ?? null]);
  if (health(payload?.meta?.screener) !== health(cache.meta.screener)) return true;
  // Beyond that, only a calendar the payload actually carried can be a row change. A payload with
  // none leaves the retained rows on screen, so comparing against them would repaint every
  // consumer over an upstream failure that altered nothing they can see.
  const schedule = (rows) => JSON.stringify(rows.map((row) => [row.id, row.date, row.time, row.eventType, row.sourceUrl]));
  const incoming = scheduleFrom(payload);
  if (incoming && schedule(incoming) !== schedule(cache.portfolioUpcoming)) return true;
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
