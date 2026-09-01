// data/super-investors.js — the live super-investor feed, off Ticker Finology via our Worker.
//
//   load()              the list, then every book, painting as they arrive
//   list()              [{ name, slug, bio, imageUrl }]
//   book(slug)          one normalised portfolio, or null if it has not landed
//   books()             every book that has landed
//   movesFor(slug)      quarter-over-quarter changes for one investor
//   allMoves()          the same across every loaded book
//   meta()              what loaded, what failed, where the paint came from, and when
//   onChange(fn)        fires as each book lands, so the grid fills in progressively
//
// LOADED ONCE PER PAGE, NEVER POLLED. Shareholding data changes when a company files, which is
// once a quarter. A poller here would re-scrape somebody else's service every thirty seconds to
// re-learn a number that moves four times a year.
//
// THE DEVICE IS READ BEFORE THE NETWORK IS ASKED ANYTHING.
//   Ninety investors means ninety-one requests: the list, then one page per book. Conditional
//   fetching already made the BYTES nearly free on a second visit — every unchanged book is a
//   bodyless 304 — but a 304 is still a round trip, and ninety-one of them four at a time is
//   twenty-three sequential waits before the grid is full. That is the delay, and no amount of
//   caching at the HTTP layer removes it, because the wait is latency and not bandwidth.
//
//   So `load()` reads what it already has before it asks for anything. The device comes first, then
//   the COMMITTED SNAPSHOT — `public/data/super-investors.json`, every book in one 414KB file
//   (69KB over the wire) written by scripts/scrape-super-investors.mjs — for whatever the device
//   does not hold. Only then does a background pass revalidate.
//
//   THE SNAPSHOT IS THE HALF THAT HELPS A FIRST VISIT, and it is the half that was missing. A
//   device cache does nothing at all for a reader who has never opened the tab, and that reader is
//   the one who waited: ninety-one requests, four at a time, each of which may be a live scrape on
//   somebody else's service. Every other bulk feed in this dashboard is served from a committed
//   file for exactly this reason.
//
//   Between them: a first visit is one request, a return visit is none, and a book the snapshot
//   could not capture is fetched live and is absent rather than empty in the meantime.
//
//   THE STORE AND THE SNAPSHOT BOTH HOLD THE SERVER'S OWN BYTES — never a locally patched copy —
//   which is the entire basis for trusting a paint that asked nobody. `meta().origin` distinguishes
//   all three: `snapshot` for the committed file, `store` for this device's cache, `live` only once
//   every painted book has been confirmed against the server in this session.
//
// A FAILED BOOK IS NOT AN EMPTY BOOK. `ok: false` from the Worker carries a `reason`, and this
// module keeps it per investor. The card says "could not be read" and names why; it never shows a
// holdings count of zero for a book that failed to load.
//
// THREE THINGS THAT MADE A RETURN VISIT SLOW, AND WHAT REPLACED THEM.
//   1. EVERY BOOK WAS RE-ASKED ON EVERY PAGE LOAD. The revalidation pass walked all ninety-one
//      unconditionally, so a reader who opened the tab twice in a minute paid ninety-one round
//      trips to be told nothing had changed. A book confirmed inside the current window is now left
//      alone, and THE WINDOW COMES FROM THE FILING CALENDAR rather than from a number of hours: a
//      book is assembled from shareholding patterns companies file once a quarter, so outside a
//      filing season there is nothing that can have changed it. See `revalidateWindowMs`. Three
//      things are always asked for regardless — a book never read, a book carrying the server's
//      `stale` flag, and a book whose confirmation predates the most recent quarter end.
//   2. NINETY-ONE INDEXEDDB TRANSACTIONS BEFORE FIRST PAINT. `readEntry` per book, each opening
//      its own transaction. `readEntries` does the lot in one.
//   3. NINETY FULL REPAINTS OF A FOUR-THOUSAND-ROW TABLE. Every arriving book emitted, and the tab
//      rebuilds its whole panel — stat strip, ninety cards and the positions table — on each emit.
//      Arrivals are now coalesced into at most one repaint per EMIT_COALESCE_MS, which turns that
//      into a handful. The walk's final emit is still immediate, so the settled state is never
//      left waiting behind a timer.
//
// NONE OF THAT MAY BUY SPEED WITH A FRESHNESS CLAIM WE CANNOT SUPPORT. `meta().origin` still reads
// `store` for as long as any painted book is unconfirmed — which, with the skip above, is the
// normal state of a quick return visit — and `meta().checkedAt` reports the OLDEST confirmation
// behind what is on screen rather than the newest. `refresh()` is the escape hatch, wired to a
// re-read control in the Live pill's modal, and it asks for everything again.

import { conditionalJson, readEntries, KEYS, isPersistent } from '../core/store.js';
import { normalisePortfolio, deriveMoves, summarise, quarterOrder, round2 } from './finology-shared.js';

const LIST_PATH = 'api/super-investors';
const bookPath = (slug) => `api/super-investors/${encodeURIComponent(slug)}`;
// Every book in one committed file, written by scripts/scrape-super-investors.mjs. See the note
// about it in the header: this is what makes a FIRST visit fast, which no device cache can.
const SNAPSHOT_PATH = 'data/super-investors.json';

// How many books are in flight at once. Each one MAY be a live scrape upstream, so this is
// politeness as much as it is throughput: four keeps a cold edge filling steadily without arriving
// as a burst of sixty simultaneous page reads on their service. Against a warm edge every one of
// these is a cache read of a few milliseconds and the ceiling stops mattering.
const CONCURRENCY = 4;

// HOW OFTEN A BOOK IS WORTH ASKING ABOUT AGAIN, WHICH IS A QUESTION ABOUT THE FILING CALENDAR.
//
// A super-investor's book is assembled from the shareholding patterns companies file with the
// exchanges, and those are filed once a quarter. Nothing else moves it. So the window is derived
// from where the calendar is rather than from a flat number of hours:
//
//   IN SEASON   a quarter has ended within FILING_SEASON_DAYS, so companies are still filing and
//               a book genuinely gains lines from one day to the next.
//   OUT OF      every company that is going to file for this quarter has, and the next thing that
//   SEASON      can change any book is the next quarter end. Asking again before then cannot learn
//               anything, so the hold is long.
//
// AND ONE HARD RULE ABOVE BOTH: a confirmation older than the most recent quarter end is always
// re-asked, whatever the elapsed time says. Without it a long hold could straddle a quarter
// boundary and keep serving last quarter's book into the new one — the exact failure the window is
// meant to prevent, arrived at by being too clever about avoiding requests.
const DAY_MS = 24 * 60 * 60 * 1000;
const FILING_SEASON_DAYS = 60;
const REVALIDATE_IN_SEASON_MS = 24 * 60 * 60 * 1000;
const REVALIDATE_OUT_OF_SEASON_MS = 30 * DAY_MS;

/** The most recent 31 Mar / 30 Jun / 30 Sep / 31 Dec, in ms. */
function lastQuarterEnd(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const ends = [Date.UTC(y - 1, 11, 31), Date.UTC(y, 2, 31), Date.UTC(y, 5, 30), Date.UTC(y, 8, 30), Date.UTC(y, 11, 31)];
  let last = ends[0];
  for (const e of ends) if (e <= now) last = e;
  return last;
}

function revalidateWindowMs(now = Date.now()) {
  const sinceQuarterEnd = now - lastQuarterEnd(now);
  return sinceQuarterEnd <= FILING_SEASON_DAYS * DAY_MS ? REVALIDATE_IN_SEASON_MS : REVALIDATE_OUT_OF_SEASON_MS;
}

// Books arrive faster than a repaint of the panel takes. Long enough to absorb a burst, short
// enough that the grid still visibly fills rather than appearing in one jump.
const EMIT_COALESCE_MS = 120;

let state = fresh();
let loading = null;
const subscribers = new Set();

function fresh() {
  return {
    loaded: false,
    listOk: false,
    reason: null, // 'no-token' | 'unauthorised' | 'unreachable' | 'upstream' | 'shape' | null
    message: null,
    investors: [],
    dropped: 0,
    books: new Map(), // slug -> normalised portfolio
    failures: new Map(), // slug -> { reason, message }
    // slug -> when the SERVER last confirmed those bytes. Read off the device entry's savedAt on
    // a seeded paint and off the response's checkedAt on a live one, so it means the same thing
    // either way: the last moment anything but this tab vouched for the figure on screen.
    confirmedAt: new Map(),
    // Slugs the Worker served from its last-good copy because the upstream was down. Real filed
    // data, labelled, and never eligible for the revalidation skip.
    staleBooks: new Set(),
    stale: false, // the LIST itself came back as a last-good copy
    staleReason: null,
    fetchedAt: null,
    checkedAt: null,
    // Books painted out of the committed snapshot rather than off this device. Tracked apart from
    // `unconfirmed` so the pill can name which of the two the reader is looking at — a file this
    // deployment ships and a copy this browser kept are different provenances.
    fromSnapshot: new Set(),
    capturedAt: null, // when the committed snapshot was taken
    origin: null, // 'live' | 'store' | 'snapshot'
    inFlight: 0,
    // Books painted from the device and not yet confirmed against the server. While this is
    // non-empty the view says the paint came from the cache, because it did.
    unconfirmed: new Set(),
    revalidating: false,
  };
}

export const isLoaded = () => state.loaded;
export const list = () => state.investors;
export const book = (slug) => state.books.get(slug) || null;
export const books = () => [...state.books.values()];
export const failureFor = (slug) => state.failures.get(slug) || null;

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Repaints, coalesced
//
// A subscriber here is the whole tab panel: stat strip, ninety investor cards and a table of every
// disclosed position across every book. Rebuilding that is tens of milliseconds, and the walk used
// to trigger one per arriving book. Ninety of them, back to back, is what a reader experienced as
// the view "taking too long" even after the data was on the device.
//
// A trailing throttle rather than a debounce, deliberately: a debounce would keep deferring while
// books kept landing and the grid would sit still until the walk finished.
// ---------------------------------------------------------------------------------------
let emitTimer = null;
const fire = () => subscribers.forEach((fn) => fn());

function emit({ now = false } = {}) {
  if (now) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    fire();
    return;
  }
  if (emitTimer) return; // one is already scheduled; this arrival rides on it
  emitTimer = setTimeout(() => {
    emitTimer = null;
    fire();
  }, EMIT_COALESCE_MS);
}

// Every derived view of the books — every holding, every move, the quarter columns — is rebuilt
// from scratch by the tab on each paint. `version` moves whenever a book does, so the work is done
// once per change instead of once per paint. See `derived()` at the foot of this file.
let version = 0;
const bump = () => {
  version++;
};

// WHICH STATE AN IN-FLIGHT REQUEST BELONGS TO.
//
// `state` is a module binding that `invalidate()` REPLACES, and the walk is ninety-one requests
// deep when a reader hits "Re-read everything now". Without this, the abandoned pass would keep
// writing into the new state as its requests landed: books and confirmation stamps from the run
// that was discarded, and — worse — its `finally` would clear `revalidating` and flip `origin` to
// `live` for a pass that had not happened yet. Every async continuation therefore checks that the
// generation it started in is still the current one before it touches anything.
let generation = 0;
const current = (gen) => gen === generation;

export function meta() {
  return {
    ok: state.listOk,
    reason: state.reason,
    message: state.message,
    total: state.investors.length,
    dropped: state.dropped,
    loadedBooks: state.books.size,
    failedBooks: state.failures.size,
    pending: Math.max(0, state.investors.length - state.books.size - state.failures.size),
    inFlight: state.inFlight,
    fetchedAt: state.fetchedAt,
    // The OLDEST confirmation behind what is on screen, not the newest. With the revalidation skip
    // most of a return visit's books are as fresh as the device copy and no fresher, and reporting
    // the list's own check would overstate every one of them.
    checkedAt: oldestCheckedAt(),
    // Where the paint came from, and never a claim beyond what was confirmed. See `originNow`.
    origin: originNow(),
    capturedAt: state.capturedAt,
    fromSnapshot: state.fromSnapshot.size,
    confirming: state.revalidating,
    // The Worker could not reach the upstream and served its last good read instead. Real filed
    // data of a known age, never invented — but it is not what the source would say right now,
    // and the panel says so.
    stale: state.stale || state.staleBooks.size > 0,
    staleReason: state.staleReason,
    staleBooks: state.staleBooks.size,
    persisted: isPersistent(),
    source: 'Ticker Finology, via devde.muns.io',
  };
}

/**
 * Where what is on screen came from.
 *
 *   live      every painted book was confirmed against the server in this session
 *   snapshot  some were not, and all of those came from the committed file
 *   store     some were not, and at least one came off this device's own cache
 *
 * The two unconfirmed cases are kept apart because they are different promises to the reader: a
 * file this deployment ships, with a capture date on it, and bytes this browser happens to have
 * kept. Neither may be called `live`, which is the whole point of the distinction.
 */
function originNow() {
  if (!state.unconfirmed.size) return state.origin;
  for (const slug of state.unconfirmed) if (!state.fromSnapshot.has(slug)) return 'store';
  return 'snapshot';
}

/** The oldest moment anything on screen was confirmed by the server. */
function oldestCheckedAt() {
  let oldest = state.checkedAt;
  for (const slug of state.unconfirmed) {
    const at = state.confirmedAt.get(slug);
    if (at != null && (oldest == null || at < oldest)) oldest = at;
  }
  return oldest;
}

/** Discard everything and re-read. Nothing calls this on a timer. */
export function invalidate() {
  state = fresh();
  loading = null;
  generation++;
  bump();
}

/**
 * Throw away every confirmation and read the whole feed again.
 *
 * This is what makes the revalidation skip honest rather than merely fast: a reader who wants to
 * know whether anything has moved in the last six hours has a control that asks. It is wired to
 * the Live pill's modal in js/investors/live.js and to nothing automatic.
 */
export async function refresh() {
  const before = state.books.size;
  invalidate();
  await load();
  // IGNORING THE WINDOW IS THE POINT. A reader who presses Refresh is saying "ask anyway", and a
  // refresh that quietly skipped every book because the committed capture was recent would be a
  // button that does nothing on the one occasion they were sure something had changed.
  await revalidate({ ignoreWindow: true });
  return { added: Math.max(0, state.books.size - before), checked: state.investors.length, failed: state.failures.size };
}

/**
 * Fetch the list, then every book.
 *
 * Resolves once the LIST has landed, not once every book has — the grid can render investors from
 * the list alone, and each card fills in as its book arrives. Waiting for all of them would leave
 * the tab blank for as long as the slowest scrape takes.
 */
export function load() {
  if (loading) return loading;
  const gen = generation;
  loading = (async () => {
    // PASS ONE — everything this device already has, with no network at all.
    //
    // A hit here means the grid is complete before the first request is even sent. A miss is not an
    // error and never has been: it means "fetch it", which is what pass two does regardless.
    const seededDevice = await seedFromStore(gen);
    if (!current(gen)) return state; // a re-read replaced everything while the device was read
    // …and then the committed snapshot, for every book the device did not have. On a FIRST visit
    // the device has nothing and this is the whole grid in one request; on a return visit it fills
    // whatever gaps an interrupted walk left behind. The device's copy always wins where both have
    // one: it was read from the server later than the file was captured.
    const seededSnapshot = await seedFromSnapshot(gen);
    if (!current(gen)) return state;
    if (seededDevice || seededSnapshot) {
      state.loaded = true;
      state.origin = 'store';
      emit({ now: true });
      // AND NOTHING IS WALKED. Confirming ninety books is ninety round trips, each of which may be
      // a live scrape upstream, and it is work nobody asked for over a grid that is already
      // complete and already labelled with where it came from. `refresh()` is what asks — the
      // header's Refresh button, and *Re-read everything now* in the Live pill's modal.
      //
      // The LIST is a single request and does tell us something a snapshot cannot: whether an
      // investor has been added or removed. That one is worth making, and it is one.
      confirmList();
      return state;
    }

    let res;
    try {
      res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
    } catch {
      res = null;
    }
    if (!current(gen)) return state;
    const body = res?.value;
    state.checkedAt = res?.checkedAt || Date.now();
    state.origin = res?.fromStore ? 'store' : 'live';

    if (!body) {
      // No route at this origin at all — a plain static server rather than the Worker.
      state.reason = 'no-route';
      state.message = 'This origin has no /api/super-investors route. The live feed needs the Cloudflare Worker.';
      state.loaded = true;
      emit({ now: true });
      return state;
    }
    if (body.ok === false) {
      state.reason = body.reason || 'upstream';
      state.message = body.message || 'The super-investor feed could not be read.';
      state.loaded = true;
      emit({ now: true });
      return state;
    }

    state.listOk = true;
    state.investors = Array.isArray(body.investors) ? body.investors : [];
    state.dropped = body.dropped || 0;
    state.fetchedAt = body.fetchedAt || null;
    state.stale = body.stale === true;
    state.staleReason = body.stale === true ? body.staleReason || null : null;
    state.loaded = true;
    bump();
    emit({ now: true });

    // Books land in the background. Deliberately not awaited: the grid is already useful.
    walkBooks();
    return state;
  })();
  return loading;
}

/**
 * Pass one: rebuild the whole view from the device, asking the network nothing.
 *
 * Returns false when the list is not on this device, in which case there is nothing to paint early
 * and the normal path runs. A PARTIAL hit is still a hit — books that are not cached simply stay
 * pending and arrive in pass two, exactly as they would on a first visit.
 */
async function seedFromStore(gen) {
  let entry;
  try {
    entry = (await readEntries([KEYS.investorList])).get(KEYS.investorList);
  } catch {
    return false;
  }
  if (!current(gen)) return false;
  const body = entry?.value;
  // A stored failure is not something to paint. `ok: false` is cached for fifteen seconds upstream
  // precisely so a corrected token takes effect at once, and replaying it from disk would undo that.
  if (!body || body.ok === false || !Array.isArray(body.investors) || !body.investors.length) return false;

  state.listOk = true;
  state.investors = body.investors;
  state.dropped = body.dropped || 0;
  state.fetchedAt = body.fetchedAt || null;
  state.checkedAt = entry.savedAt || null;
  state.stale = body.stale === true;
  state.staleReason = body.stale === true ? body.staleReason || null : null;

  // ONE transaction for every book, not one per book. Ninety-one round trips to the storage thread
  // sat directly on the critical path of the first paint, which is the paint this whole two-pass
  // arrangement exists to make fast.
  let stored;
  try {
    stored = await readEntries(state.investors.map((i) => KEYS.investorBook(i.slug)));
  } catch {
    stored = new Map();
  }
  if (!current(gen)) return false;
  for (const i of state.investors) {
    const hit = stored.get(KEYS.investorBook(i.slug));
    const value = hit?.value;
    if (!value || value.ok === false) continue;
    // Re-normalised rather than trusted: these bytes were written by whatever version of the Worker
    // was live when they were cached, and the shape guard is what makes that safe.
    state.books.set(i.slug, normalisePortfolio(value, i.slug));
    state.unconfirmed.add(i.slug);
    state.confirmedAt.set(i.slug, hit.savedAt || null);
    // A last-good copy the Worker served during an outage. It is real and it is labelled, and it
    // is the one thing the revalidation skip must never apply to.
    if (value.stale === true) state.staleBooks.add(i.slug);
  }
  bump();
  return true;
}

/**
 * Pass one and a half: the committed snapshot of every book, in one request.
 *
 * THIS IS THE ONLY THING THAT CAN MAKE A FIRST VISIT FAST. The device cache does nothing for a
 * reader who has never opened the tab, and that reader is the one who waited: ninety-one requests
 * four at a time, each of which may be a live scrape on somebody else's service, is most of a
 * minute of a grid filling in. `scripts/scrape-super-investors.mjs` pays that once on a schedule
 * and commits the result — 414KB, 69KB over the wire, one conditional GET.
 *
 * It never overwrites a book the device already holds: those bytes were confirmed by the server
 * later than the file was captured. A book the capture could not read is absent rather than empty,
 * exactly as it is in the filings snapshots, and pass two fetches it live.
 */
async function seedFromSnapshot(gen) {
  let res;
  try {
    res = await conditionalJson(SNAPSHOT_PATH, { key: KEYS.investorSnapshot, optional: true });
  } catch {
    res = null;
  }
  if (!current(gen)) return false;
  const body = res?.value;
  if (!body || !Array.isArray(body.investors) || !body.investors.length) return false;

  state.capturedAt = body.capturedAt || null;
  // The list only if the device did not already have a newer one.
  if (!state.investors.length) {
    state.investors = body.investors;
    state.listOk = true;
    state.dropped = body.dropped || 0;
  }
  // The capture time IS a real confirmation time: these are the server's own bytes, read then.
  const at = Date.parse(body.capturedAt || '') || null;
  let added = 0;
  for (const [slug, value] of Object.entries(body.books || {})) {
    if (!value || value.ok === false || state.books.has(slug)) continue;
    state.books.set(slug, normalisePortfolio(value, slug));
    state.fromSnapshot.add(slug);
    state.unconfirmed.add(slug);
    if (at) state.confirmedAt.set(slug, at);
    added++;
  }
  if (at && (state.checkedAt == null || at < state.checkedAt)) state.checkedAt = at;
  if (added) bump();
  return state.investors.length > 0;
}

/**
 * One request: has the investor LIST changed?
 *
 * Cheap enough to make on a load that otherwise asks for nothing, and it answers the one question
 * the committed snapshot genuinely cannot — an investor added or dropped upstream. It confirms no
 * BOOK, so `meta().origin` keeps saying `snapshot` / `store`, which is what it should say.
 */
async function confirmList() {
  const gen = generation;
  let res;
  try {
    res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
  } catch {
    return;
  }
  if (!current(gen)) return;
  const body = res?.value;
  if (!body || body.ok === false || !Array.isArray(body.investors)) return;
  state.checkedAt = res.checkedAt;
  state.dropped = body.dropped || 0;
  if (body.fetchedAt) state.fetchedAt = body.fetchedAt;
  state.stale = body.stale === true;
  state.staleReason = body.stale === true ? body.staleReason || null : null;
  if (body.investors.length !== state.investors.length) {
    state.investors = body.investors;
    bump();
    emit({ now: true });
  }
}

/**
 * Pass two: confirm what was painted from the device, and fill in what was not.
 *
 * Every book goes back through `conditionalJson`, so an unchanged one is a bodyless 304 and its row
 * is left alone — no repaint, no flicker, no work. Only a book whose bytes actually changed emits.
 * Nothing here can turn a painted book into an empty one: a failed revalidation leaves the cached
 * copy on screen and is recorded against the investor, because a book we HAVE is better than a gap,
 * and pretending the fund holds nothing would be worse than both.
 */
async function revalidate({ ignoreWindow = false } = {}) {
  if (state.revalidating) return;
  const gen = generation;
  state.revalidating = true;
  try {
    let res;
    try {
      res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
    } catch {
      res = null;
    }
    if (!current(gen)) return;
    const body = res?.value;
    if (body && body.ok !== false && Array.isArray(body.investors)) {
      state.checkedAt = res.checkedAt;
      state.dropped = body.dropped || 0;
      if (body.fetchedAt) state.fetchedAt = body.fetchedAt;
      state.stale = body.stale === true;
      state.staleReason = body.stale === true ? body.staleReason || null : null;
      // An investor added or removed upstream since the cached read.
      if (body.investors.length !== state.investors.length) {
        state.investors = body.investors;
        bump();
      }
    }
    await walkBooks({ force: true, ignoreWindow });
  } finally {
    // Only the pass that owns the current state may report on it. An abandoned pass finishing here
    // would clear `revalidating` and flip `origin` to `live` for a re-read that has not run yet.
    if (current(gen)) {
      state.revalidating = false;
      // NOT a blanket clear. A book the walk deliberately skipped is a book nobody confirmed, and
      // wiping it out of `unconfirmed` would let `meta().origin` report `live` for bytes that were
      // read off this device — the precise claim the store layer is built never to make. `loadBook`
      // removes each slug as the server actually vouches for it.
      if (!state.unconfirmed.size) state.origin = 'live';
      emit({ now: true });
    }
  }
}

/**
 * Fetch every book that still needs fetching, CONCURRENCY at a time, emitting as they land.
 *
 * `force` re-asks for books already in memory, which is what the revalidation pass needs; the
 * first-visit walk skips them, because a book in memory there has just been fetched.
 *
 * WHAT THE REVALIDATION PASS DOES *NOT* ASK FOR is the change that made a return visit quick. A
 * book confirmed inside the current window — see `revalidateWindowMs`, which is derived from the
 * filing calendar rather than from a number of hours — cannot have anything new to tell us, so the
 * request would spend a round trip receiving bytes already on this device. Three exceptions, each
 * of which would otherwise strand a reader on something worse than a slow paint: a book we do not
 * have at all, a book the Worker served from its last-good copy during an outage, and a book whose
 * confirmation predates the most recent quarter end.
 */
async function walkBooks({ force = false, ignoreWindow = false } = {}) {
  const gen = generation;
  const queue = state.investors.map((i) => i.slug).filter(Boolean).filter((slug) => !force || ignoreWindow || needsRevalidation(slug));
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      // A re-read abandons this walk. Ninety-one requests deep, continuing would spend them all
      // filling a state nobody is looking at any more.
      if (!current(gen)) return;
      const slug = queue.shift();
      if (!slug) return;
      state.inFlight++;
      const changed = await loadBook(slug, { force, gen });
      if (!current(gen)) return;
      state.inFlight--;
      // On the revalidation pass an unchanged book is the common case and repainting for it would
      // rebuild the grid ninety times to display exactly what is already there.
      if (!force || changed) emit();
    }
  });
  await Promise.all(workers);
  if (current(gen)) emit({ now: true });
}

function needsRevalidation(slug) {
  if (!state.books.has(slug)) return true; // never read: there is nothing to skip
  if (state.staleBooks.has(slug)) return true; // a last-good copy is exactly what wants replacing
  const at = state.confirmedAt.get(slug);
  if (at == null) return true; // no idea when it was confirmed, so treat it as unconfirmed
  const now = Date.now();
  // A quarter has ended since this copy was confirmed, so a filing season it knows nothing about
  // has begun. Elapsed time is not allowed to overrule that.
  if (at < lastQuarterEnd(now)) return true;
  return now - at >= revalidateWindowMs(now);
}

/**
 * One book. Never throws — a failure is recorded against that investor and the walk continues.
 *
 * Returns the portfolio on a first read, `true` when a revalidation found different bytes, and
 * `false` when it did not.
 */
export async function loadBook(slug, { force = false, gen = generation } = {}) {
  const had = state.books.get(slug);
  if (had && !force) return had;

  let res;
  try {
    res = await conditionalJson(bookPath(slug), { key: KEYS.investorBook(slug), optional: true });
  } catch {
    res = null;
  }
  // A re-read replaced the state while this was in flight. The bytes are already in the device
  // store, where the new pass will find them; writing them into a state they do not belong to
  // would stamp a confirmation the new pass never made.
  if (!current(gen)) return false;
  const body = res?.value;
  if (!body || body.ok === false) {
    // A revalidation that fails must not delete a book we already have. The cached copy is a real
    // read of a real filing; replacing it with "could not be read" because a later request timed
    // out would throw away good data to report a transient network event.
    //
    // It also must not be recorded as CONFIRMED. Nothing vouched for those bytes — the request
    // failed — so the slug stays in `unconfirmed`, `meta().origin` keeps saying `store`, and the
    // next visit asks again instead of resting on a six-hour skip it never earned.
    if (had) return false;
    state.failures.set(slug, {
      reason: body?.reason || 'unreachable',
      message: body?.message || 'This investor’s book could not be read.',
    });
    return null;
  }
  // The server answered, so whatever it said about these bytes is now confirmed as of this moment.
  state.confirmedAt.set(slug, res.checkedAt || Date.now());
  if (body.stale === true) state.staleBooks.add(slug);
  else state.staleBooks.delete(slug);

  if (had) {
    state.unconfirmed.delete(slug);
    // Confirmed against the server, so it is no longer the committed file's copy whatever it
    // started as. `meta().fromSnapshot` is a count of what is still unvouched-for.
    state.fromSnapshot.delete(slug);
    // `fromStore` is the conditional layer reporting a 304 — the server confirmed the bytes we
    // already had, so there is nothing to re-normalise and nothing to repaint.
    if (res.fromStore) return false;
    state.books.set(slug, normalisePortfolio(body, slug));
    state.failures.delete(slug);
    bump();
    return true;
  }
  // Re-normalise client-side rather than trusting the shape that came back. The Worker already
  // guarded it, but this module also serves values read straight out of the device store, which
  // were written by whatever version of the Worker was live when they were cached.
  const portfolio = normalisePortfolio(body, slug);
  state.books.set(slug, portfolio);
  state.failures.delete(slug);
  if (!state.fetchedAt && body.fetchedAt) state.fetchedAt = body.fetchedAt;
  bump();
  return portfolio;
}

/** Quarter-over-quarter changes for one investor. Derived — see finology-shared.js. */
export function movesFor(slug) {
  const b = state.books.get(slug);
  return b ? deriveMoves(b) : { comparable: false, latest: null, prior: null, moves: [] };
}

// ---------------------------------------------------------------------------------------
// The derived views, built once per change rather than once per paint
//
// The tab rebuilds its whole panel from these on every repaint, and with ninety books they are the
// most expensive thing it does: `allHoldings` allocates a row per investor-company pair — several
// thousand — and `allMoves` runs `deriveMoves` over every book. Both were recomputed from scratch
// on each of the ninety arrivals.
//
// `version` moves whenever a book, a failure or the investor list does, so this memo can never
// serve a view of data that has since changed. It is a cache of a pure function of `state`, which
// is the only kind of cache that needs no invalidation rules beyond that.
// ---------------------------------------------------------------------------------------
let memo = { version: -1 };

/**
 * The name to SHOW for an investor, which is the list's, not the book's.
 *
 * Finology's two endpoints disagree: the list says "Abakkus Fund - Sunil Singhania" and the book
 * says "Abakkus Fund - Sunil Singhania Portfolio, Shareholdings & Investments." — their page
 * title, SEO suffix and all. The cards were already reading the list, so the table under them and
 * its investor filter were showing a different string for the same person, and the cross-book
 * summary panels were unreadable: three of those suffixes in one line of a small card.
 *
 * Resolved here rather than by stripping the suffix with a regex — the list is the authoritative
 * display name, and a pattern match would quietly fail the day they reword it. Falls back to the
 * book's own name so a book that arrives before the list still renders something real.
 */
function displayName(b) {
  return state.investors.find((i) => i.slug === b.slug)?.name || b.name;
}

function derived() {
  if (memo.version === version) return memo;

  const moves = [];
  const holdings = [];
  const seenQuarters = [];
  for (const b of state.books.values()) {
    const investor = displayName(b);
    for (const q of b.quarters) if (!seenQuarters.includes(q)) seenQuarters.push(q);

    const [latest] = b.quarters;
    for (const h of b.holdings) {
      holdings.push({
        investor,
        slug: b.slug,
        company: h.company,
        companySlug: h.companySlug,
        quarterlyHoldings: h.quarterlyHoldings,
        quarters: b.quarters,
        latest: latest || null,
        pct: latest ? h.quarterlyHoldings[latest] : null,
        valueCr: h.valueCr,
      });
    }

    const { comparable, latest: l, prior, moves: ms } = deriveMoves(b);
    if (!comparable) continue;
    for (const m of ms) moves.push({ ...m, investor, slug: b.slug, latest: l, prior });
  }

  memo = { version, moves, holdings, quarters: orderQuarters(seenQuarters) };
  return memo;
}

/**
 * Every quarter label seen across the loaded books, newest first.
 *
 * ONE COLUMN PER QUARTER IS BUILT FROM THIS, so the order is the table's order. Collecting in
 * book-arrival order put whichever investor answered first at the left, which is a property of the
 * network rather than of the calendar — and with books published to different quarters the columns
 * came out interleaved. Sorted on the parsed label instead, falling back to arrival order for
 * labels that do not parse.
 */
function orderQuarters(seen) {
  const keyed = seen.map((q, i) => ({ q, i, n: quarterOrder(q) }));
  if (keyed.some((k) => k.n == null)) return seen;
  return keyed.sort((a, b) => b.n - a.n || a.i - b.i).map((k) => k.q);
}

/** Every move across every loaded book, tagged with whose it is. */
export function allMoves() {
  return derived().moves;
}

/** Totals for one book. */
export const totalsFor = (slug) => {
  const b = state.books.get(slug);
  return b ? summarise(b) : null;
};

/**
 * THE QUARTER, ROLLED UP ACROSS EVERY COMPARABLE BOOK.
 *
 * The page exists so a reader does not have to open ninety books one at a time, and this is the
 * function that answers that. It is a roll-up of `deriveMoves` — counting and grouping their
 * numbers — and it invents nothing beyond the percentage-point subtraction that module already
 * documents as the one derived figure here.
 *
 * FOUR THINGS IT DELIBERATELY WILL NOT DO, each of which is the obvious feature request:
 *
 *  1. **No rupee size on any move.** `valueCr` is Finology's derivation of what a position is
 *     WORTH NOW, not what was traded. Ranking "largest buys" by it would answer "who holds the
 *     biggest position that also grew", and print a rupee figure for a trade nobody disclosed.
 *     Increases and reductions are therefore ranked in PERCENTAGE POINTS of the company, which is
 *     the only size the filing actually states.
 *  2. **No size at all on a new or exited position.** `deriveMoves` leaves `deltaPp` null for both
 *     on purpose — a position appearing is a change of disclosure, not a move of "the whole
 *     holding" — so new entrants are ranked by the stake they now disclose, and exits carry no
 *     figure. Sorting them into the increase/reduction lists would fabricate the very number that
 *     module refuses to state.
 *  3. **"Exited" is not "sold".** Below the disclosure threshold a real holding vanishes from the
 *     shareholding pattern. The wording on every surface is "no longer disclosed".
 *  4. **Consensus is a COUNT, not a signal.** `consensusBuys` says how many tracked investors
 *     added or newly disclosed the same company. It is not a recommendation, it is not weighted,
 *     and it is not scored — this dashboard adds no model to somebody else's filings.
 *
 * AND THE BOOKS ARE NOT ALL ON THE SAME QUARTER. `deriveMoves` compares each book's own two most
 * recent quarters, so across ninety investors this can span several (latest, prior) pairs. That is
 * a fact about their publishing, not an error, and `pairs` reports it so the UI can say so rather
 * than implying one clean quarter boundary.
 *
 * `include(company)` narrows to the scope the view is showing. It is passed in rather than read
 * here so the summary and the table below it filter through ONE predicate — two predicates over
 * the same question is the shape that had the filings tabs reporting different companies in two
 * places on one screen.
 */
export function quarterSummary({ include = null, limit = 5 } = {}) {
  const all = derived().moves;
  const moves = include ? all.filter((m) => include(m.company)) : all;

  const counts = { new: 0, exited: 0, added: 0, trimmed: 0, held: 0 };
  for (const m of moves) if (counts[m.action] != null) counts[m.action] += 1;

  // Grouped on the company, carrying who did what — the roll-up a reader would otherwise do by
  // opening every book. `companySlug` rides along so a row can link out to Finology's own page.
  const group = (actions) => {
    const byCompany = new Map();
    for (const m of moves) {
      if (!actions.includes(m.action)) continue;
      if (!byCompany.has(m.company)) byCompany.set(m.company, { company: m.company, companySlug: m.companySlug, investors: [] });
      byCompany.get(m.company).investors.push({ investor: m.investor, slug: m.slug, action: m.action, deltaPp: m.deltaPp, now: m.now });
    }
    return [...byCompany.values()]
      .filter((c) => c.investors.length > 1)
      // Most investors first. The tie-break sums only the moves that HAVE a size — a company two
      // investors newly disclosed sums to 0pp and must not therefore rank below one with a single
      // measured +0.1pp; `sized` keeps that visible instead of letting a null read as zero.
      .map((c) => ({
        ...c,
        count: c.investors.length,
        sized: c.investors.filter((i) => i.deltaPp != null).length,
        sumPp: round2(c.investors.reduce((a, i) => a + (i.deltaPp ?? 0), 0)),
      }))
      .sort((a, b) => b.count - a.count || Math.abs(b.sumPp) - Math.abs(a.sumPp));
  };

  const byAction = (action) => moves.filter((m) => m.action === action);

  // Every (latest, prior) pair the comparable books were measured across.
  const pairs = [];
  for (const m of moves) {
    if (!pairs.some((p) => p.latest === m.latest && p.prior === m.prior)) pairs.push({ latest: m.latest, prior: m.prior });
  }

  // A book with one published quarter is not comparable and contributes nothing — counted, so the
  // panel can say so rather than letting it read as an investor who did nothing.
  let comparableBooks = 0;
  let singleQuarterBooks = 0;
  for (const b of state.books.values()) (b.quarters.length > 1 ? comparableBooks++ : singleQuarterBooks++);

  return {
    counts,
    total: moves.length,
    pairs,
    comparableBooks,
    singleQuarterBooks,
    // Books that actually contributed a move to THIS (possibly scoped) set. Under a narrowed
    // scope `comparableBooks` alone would read as though all of them had — "5 new across 87
    // comparable books" is true and sounds like 87 investors moved on five companies.
    contributingBooks: new Set(moves.map((m) => m.slug)).size,
    consensusBuys: group(['new', 'added']).slice(0, limit),
    consensusExits: group(['exited', 'trimmed']).slice(0, limit),
    // Ranked by the stake they now disclose — a filed figure — never by a change they did not make.
    newEntrants: byAction('new').sort((a, b) => (b.now ?? 0) - (a.now ?? 0)),
    topAdds: byAction('added').sort((a, b) => b.deltaPp - a.deltaPp),
    topTrims: byAction('trimmed').sort((a, b) => a.deltaPp - b.deltaPp),
    // No sort key exists for these and none is invented: an exit has no size, so they come out in
    // book order rather than ranked by a figure that would have to be made up.
    exits: byAction('exited'),
  };
}

/**
 * Companies held by more than one tracked investor, most-held first.
 *
 * A count of who discloses the same name, not a view about it. Only the latest quarter of each
 * book counts, because an overlap between one investor's 2024 position and another's 2026 one is
 * not an overlap.
 */
export function overlaps() {
  const byCompany = new Map();
  for (const b of state.books.values()) {
    const [latest] = b.quarters;
    if (!latest) continue;
    for (const h of b.holdings) {
      if (h.quarterlyHoldings[latest] == null) continue;
      const key = h.company;
      if (!byCompany.has(key)) byCompany.set(key, { company: key, companySlug: h.companySlug, holders: [] });
      byCompany.get(key).holders.push({ investor: displayName(b), slug: b.slug, pct: h.quarterlyHoldings[latest], valueCr: h.valueCr });
    }
  }
  return [...byCompany.values()]
    .filter((c) => c.holders.length > 1)
    .sort((a, b) => b.holders.length - a.holders.length || b.holders.reduce((s, h) => s + h.pct, 0) - a.holders.reduce((s, h) => s + h.pct, 0));
}

/**
 * Every holding across every loaded book, one row per investor-company pair.
 *
 * This is what the all-positions table renders, and what the export writes.
 */
export function allHoldings() {
  return derived().holdings;
}

/** Every quarter label seen across the loaded books, newest first. See `orderQuarters` above. */
export function quarterLabels() {
  return derived().quarters;
}

/** The newest quarter any loaded book publishes — what "this quarter" means across the feed. */
export function latestQuarter() {
  return derived().quarters[0] || null;
}
