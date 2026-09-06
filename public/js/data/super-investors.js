// Super-investor feed: saved books paint first, then the active investor view checks
// source freshness. General Alerts uses the bulk snapshot without per-investor fanout.
// Books are fetched four at a time; arrivals are coalesced before repainting.
//
// `load()` reads the device cache and committed snapshot, then checks the list.
// `watchFreshness()` keeps an active investor view current within the Worker's
// six-hour source cache, including late corrections, resumes and reconnects.
// `refresh()` explicitly checks every book. Failed reads retain last-good data and
// cannot overwrite good device-cache entries. Origin, source age and coverage are
// separate facts; none is a guarantee of complete upstream filings.
//
// Normalisation is shared with the Worker. Quarter comparisons, per-book moves,
// allHoldings and summaries preserve disclosure notes rather than treating blanks
// or pending filings as trades.

import { conditionalJson, readEntries, KEYS, isPersistent } from '../core/store.js';
import { normalisePortfolio, isPortfolioPayload, deriveMoves, summarise, quarterOrder, filedPair, isFiledQuarter } from './finology-shared.js';

import { summariseQuarter } from './investor-quarterly.js';

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

// Match the Worker's six-hour source cache year-round: late filings and corrections
// can arrive outside filing season. This is a freshness bound, not a completeness claim.
const REVALIDATE_MS = 6 * 60 * 60 * 1000;
const AUTO_RETRY_MS = 15 * 60 * 1000;
let lastAutoAttempt = -Infinity;

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
export const books = () => [...state.books.values()].filter((b) => state.investors.some((i) => i.slug === b.slug));
export const failureFor = (slug) => state.failures.get(slug) || null;

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Repaints, coalesced
//
// A subscriber here is the active in-page panel: ninety investor cards, the quarterly summary or a
// table of every disclosed position across every book. Rebuilding that is tens of milliseconds,
// and the walk used to trigger one per arriving book. Ninety of them, back to back, is what a reader experienced as
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
    loadedBooks: state.investors.filter((i) => state.books.has(i.slug)).length,
    failedBooks: state.investors.filter((i) => state.failures.has(i.slug)).length,
    pending: state.investors.filter((i) => !state.books.has(i.slug) && !state.failures.has(i.slug)).length,
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
  for (const { slug } of state.investors) {
    const at = state.confirmedAt.get(slug);
    if (at != null && (oldest == null || at < oldest)) oldest = at;
  }
  return oldest;
}

/** Discard everything and re-read. Nothing calls this on a timer. */
export function invalidate() {
  state = fresh();
  loading = null;
  lastAutoAttempt = -Infinity;
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
let refreshPromise = null;
export function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const before = state.books.size;
    // Keep the current books visible while revalidating. Invalidating first
    // erased the table and could discard good books during an upstream outage.
    await refreshSnapshot();
    await revalidate({ ignoreWindow: true });
    return { added: Math.max(0, state.books.size - before), checked: state.investors.length, failed: state.failures.size };
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

/**
 * Revalidate only the one committed bulk snapshot.
 *
 * General Alerts must not turn one header refresh into the ninety-one-request live book walk. This
 * picks up a newer deployment's scheduled snapshot in one conditional request and replaces only
 * books that are not known to have been confirmed later on this device.
 */
export async function refreshSnapshot() {
  await load();
  const gen = generation;
  let res;
  try {
    res = await conditionalJson(SNAPSHOT_PATH, { key: KEYS.investorSnapshot, optional: true });
  } catch {
    return state;
  }
  if (!current(gen)) return state;
  const body = res?.value;
  const incomingAt = Date.parse(body?.capturedAt || '');
  const heldAt = Date.parse(state.capturedAt || '');
  if (!body || !Array.isArray(body.investors) || !body.investors.length || !Number.isFinite(incomingAt)) return state;
  if (Number.isFinite(heldAt) && incomingAt <= heldAt) return state;

  const incomingSlugs = new Set(body.investors.map((i) => i?.slug).filter(Boolean));
  const incomingBooks = new Set(Object.entries(body.books || {}).filter(([slug, value]) => isPortfolioPayload(value, slug)).map(([slug]) => slug));
  // A deployment snapshot can be newer than the file that seeded this page and still older than
  // a book the Worker confirmed on this device. Preserve any list entry backed by such a book;
  // otherwise an intermediate deploy rolls a newly added investor and its moves backwards.
  const deviceNewerInvestors = state.investors.filter((i) => {
    if (!i?.slug || incomingSlugs.has(i.slug)) return false;
    const confirmed = Number(state.confirmedAt.get(i.slug));
    return Number.isFinite(confirmed) && confirmed > incomingAt;
  });
  const acceptedSlugs = new Set([...incomingSlugs, ...deviceNewerInvestors.map((i) => i.slug)]);
  // The list in the newer capture is authoritative for this replacement. Keeping a book whose
  // investor disappeared would leave `allMoves()` emitting rows the current source no longer
  // contains. Clear every piece of per-book state together so provenance cannot outlive the data;
  // the union includes failed books, which have no entry in `state.books` to drive the cleanup.
  const knownSlugs = new Set([
    ...state.books.keys(),
    ...state.confirmedAt.keys(),
    ...state.failures.keys(),
    ...state.fromSnapshot,
    ...state.unconfirmed,
    ...state.staleBooks,
  ]);
  for (const slug of knownSlugs) {
    const confirmed = Number(state.confirmedAt.get(slug));
    const removedInvestor = !acceptedSlugs.has(slug);
    const unreadInCapture = !incomingBooks.has(slug) && (!Number.isFinite(confirmed) || confirmed <= incomingAt);
    if (!removedInvestor && !unreadInCapture) continue;
    state.books.delete(slug);
    state.confirmedAt.delete(slug);
    state.fromSnapshot.delete(slug);
    state.unconfirmed.delete(slug);
    state.failures.delete(slug);
    state.staleBooks.delete(slug);
  }

  state.capturedAt = body.capturedAt;
  state.investors = [...body.investors, ...deviceNewerInvestors];
  state.listOk = true;
  state.dropped = body.dropped || 0;
  // `oldestCheckedAt()` starts with this feed-wide floor. Every book accepted below is confirmed
  // at the capture or is a device book confirmed later, so leaving the old floor in place would
  // make a fully replaced snapshot look stale after a successful refresh.
  state.checkedAt = incomingAt;
  for (const [slug, value] of Object.entries(body.books || {})) {
    if (!isPortfolioPayload(value, slug)) continue;
    const confirmed = Number(state.confirmedAt.get(slug));
    if (Number.isFinite(confirmed) && confirmed > incomingAt) continue;
    state.books.set(slug, normalisePortfolio(value, slug));
    state.confirmedAt.set(slug, incomingAt);
    state.fromSnapshot.add(slug);
    state.unconfirmed.add(slug);
    state.failures.delete(slug);
    if (value.stale === true) state.staleBooks.add(slug);
    else state.staleBooks.delete(slug);
  }
  for (const slug of state.books.keys()) {
    const confirmed = Number(state.confirmedAt.get(slug));
    if (Number.isFinite(confirmed) && confirmed < state.checkedAt) state.checkedAt = confirmed;
  }
  bump();
  emit({ now: true });
  return state;
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
      // Bulk consumers stop at the list; the active investor view separately binds
      // watchFreshness() to revalidate due books without blocking this cached paint.
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
    if (!isPortfolioPayload(value, i.slug)) continue;
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
    if (!isPortfolioPayload(value, slug) || state.books.has(slug)) continue;
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
  if (JSON.stringify(body.investors) !== JSON.stringify(state.investors)) {
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
      if (JSON.stringify(body.investors) !== JSON.stringify(state.investors)) {
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
 * Books within the six-hour source window are skipped. Missing books and failed/stale
 * reads are always eligible; lifecycle retries remain bounded by AUTO_RETRY_MS.
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
  if (!state.books.has(slug) || state.staleBooks.has(slug) || state.failures.has(slug)) return true;
  const sourceAt = Date.parse(state.books.get(slug).sourceCheckedAt || state.books.get(slug).fetchedAt || '');
  const confirmedAt = state.confirmedAt.get(slug);
  if (!Number.isFinite(sourceAt) || confirmedAt == null) return true;
  return Date.now() - Math.min(sourceAt, confirmedAt) >= REVALIDATE_MS;
}

/** Active-view lifecycle only; General Alerts' snapshot reads do not fan out over books. */
export function watchFreshness() {
  const check = () => {
    if (document.visibilityState !== 'visible' || !state.loaded || !state.listOk || state.revalidating) return;
    if (Date.now() - lastAutoAttempt < AUTO_RETRY_MS) return;
    const listDue = !state.checkedAt || Date.now() - state.checkedAt >= REVALIDATE_MS;
    if (!listDue && !state.investors.some((i) => needsRevalidation(i.slug))) return;
    lastAutoAttempt = Date.now();
    void revalidate();
  };
  const events = ['pageshow', 'focus', 'online'];
  for (const event of events) window.addEventListener(event, check);
  document.addEventListener('visibilitychange', check);
  const interval = setInterval(check, 60_000);
  check();
  return () => {
    clearInterval(interval);
    for (const event of events) window.removeEventListener(event, check);
    document.removeEventListener('visibilitychange', check);
  };
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

  let res, readFailure;
  try {
    res = await conditionalJson(bookPath(slug), {
      key: KEYS.investorBook(slug), optional: true,
      validate: (body) => {
        if (!isPortfolioPayload(body, slug)) {
          const error = new Error(body?.message || 'The investor book could not be read.');
          error.code = body?.reason || 'shape';
          throw error;
        }
      },
    });
  } catch (error) {
    readFailure = error;
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
    state.failures.set(slug, {
      reason: readFailure?.code || body?.reason || 'unreachable',
      message: readFailure?.message || body?.message || 'This investor’s book could not be read.',
    });
    return had ? false : null;
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
    state.failures.delete(slug);
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
 * title, SEO suffix and all. The cards were already reading the list, so the Data Table and
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
  // A quarter can close while the same cached bytes remain loaded.
  const now = new Date(Date.now());
  const period = `${now.getUTCFullYear()}-${Math.floor(now.getUTCMonth() / 3)}`;
  if (memo.version === version && memo.period === period) return memo;

  const moves = [];
  const holdings = [];
  const seenQuarters = [];
  for (const b of books()) {
    const investor = displayName(b);
    for (const q of b.quarters) if (!seenQuarters.includes(q)) seenQuarters.push(q);

    // THE LATEST *FILED* QUARTER, NOT THE LATEST COLUMN. An open "Filing Due" period carries a
    // figure for a handful of early filers and a blank for everyone else, so reading `pct` off it
    // blanked the current stake of most of the book — see `isFiledQuarter` in finology-shared.js.
    const [latest] = filedPair(b.quarters);
    for (const h of b.holdings) {
      holdings.push({
        investor,
        slug: b.slug,
        company: h.company,
        companySlug: h.companySlug,
        quarterlyHoldings: h.quarterlyHoldings,
        quarterlyNotes: h.quarterlyNotes,
        fetchedAt: b.fetchedAt,
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

  memo = { version, period, moves, holdings, quarters: orderQuarters(seenQuarters) };
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

/** The confirmation represented by one investor's current book. */
export const confirmedAtFor = (slug) => state.confirmedAt.get(slug) || null;

/** Totals for one book. */
export const totalsFor = (slug) => {
  const b = state.books.get(slug);
  return b ? summarise(b) : null;
};

/** Compare the same consecutive closed quarters across the active investor list. */
export function quarterSummary({ include = null, limit = 5 } = {}) {
  return summariseQuarter(books().filter((b) => state.investors.some((i) => i.slug === b.slug)), {
    include, limit, investors: state.investors,
  });
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
  for (const b of books()) {
    const [latest] = filedPair(b.quarters);
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

/**
 * The newest FILED quarter any loaded book publishes — what "this quarter" means across the feed.
 *
 * An open period is a column, not a quarter: it exists as soon as one company files into it, so
 * taking it would have the whole feed announce itself as of a quarter almost nobody has filed.
 */
export function latestQuarter() {
  return derived().quarters.find((q) => isFiledQuarter(q)) || null;
}
