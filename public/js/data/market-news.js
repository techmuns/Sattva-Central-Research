// data/market-news.js — market-wide stocks news, the Universe half of the News tab.
//
//   marketNews.load()          the committed capture, from this device first
//   marketNews.rows()          every story, newest first, by the publisher's own id
//   marketNews.meta()          counts, capture time, when we last checked, where the paint came from
//   marketNews.refresh()       re-check for a newer capture — what the tab's button calls
//   marketNews.onChange(fn)    fires when the capture moves
//   marketNews.newArrivals()   stories that appeared since this page loaded (for the alert stack)
//
// TWO HALVES OF ONE TAB, ASKING TWO DIFFERENT QUESTIONS.
//   Portfolio scope asks "what has been written about each of these companies" — a search, one
//   request per company, which is why it makes the reader name them. Universe scope cannot work
//   that way at 603 companies, so it asks the other question: "what has been published". Same move
//   as the announcements feed — when the per-entity route cannot cover the universe, look for the
//   one indexed the other way round.
//
// THE BROWSER CANNOT READ MONEYCONTROL, AND NEITHER CAN THE WORKER. Measured: `curl` with a browser
// user-agent gets 200 and 598 KB; node's `fetch` gets **403 with a 24-byte body** on every header
// set tried, including the full sixteen-header browser set; and a Cloudflare Worker running under
// `wrangler dev` gets **403 as well**. It is TLS fingerprinting, so there is no proxy route and no
// header fix. A GitHub Action on a normal runner is the only thing that can read this page, and
// that is why this module reads a COMMITTED FILE rather than a live route.
//
// WHICH MAKES THE REFRESH BUTTON'S HONESTY THE WHOLE DESIGN.
//   The button cannot fetch Moneycontrol. What it can do — and does — is ask whether a newer
//   capture has been published, which is one conditional GET and usually a bodyless 304. So the two
//   times are kept apart and both are shown, because they are different facts:
//
//     capturedAt   when the Action last READ Moneycontrol
//     checkedAt    when this browser last confirmed it had the newest capture
//
//   A 304 moves the second and not the first. Collapsing them into one "last updated" would let a
//   twenty-minute-old capture read as though it had just arrived — the same error the header's two
//   competing chips made before they were removed.
//
// A STORY WITH NO PUBLISHER TIME KEEPS NULL. The listing page carries no date at all, so a date is
// fetched per article and is budgeted; the ones the budget did not reach render an em dash. They
// are never stamped with `firstSeenAt`, which is when WE saw the story and is a fact about the
// scraper, not about the story.

import { authHeaders } from '../core/host-context.js';
import { conditionalJson, KEYS } from '../core/store.js';

const SNAPSHOT = 'data/market-news.json';

let state = fresh();
let loading = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function fresh() {
  return {
    loaded: false,
    articles: [],
    byId: new Map(),
    capturedAt: null,
    checkedAt: null,
    // Ids present on the first paint. Anything outside this set arrived while the reader was here,
    // which is the only thing worth announcing — see `newArrivals`.
    baseline: null,
    arrivals: [],
    withPublishedAt: 0,
    withoutPublishedAt: 0,
    newestId: null,
    reason: null,
    message: null,
    // 'snapshot' when painted from the committed file, 'store' when this device had it already.
    origin: null,
    // Per publisher: when each was last read and whether that read worked. Carried through so the
    // provenance panel can say "Mint could not be read 20 minutes ago" rather than leaving the
    // reader to infer an outage from a story count, which cannot distinguish it from a quiet day.
    sources: [],
    // THE HEAD AND THE ARCHIVE ARE HELD APART, and `byId` above is the two of them merged.
    //
    // They have to be, because they move independently: the head is re-read every time the reader
    // asks whether a newer capture exists, and if that read rebuilt `byId` from its own 600 stories
    // alone it would silently throw away every older month the reader had scrolled back through.
    // The screen would jump from four months of history to thirteen days with nothing having
    // failed — the same shape as the subscription bug in CLAUDE.md, where nothing throws and only
    // the paint is wrong.
    head: new Map(),
    older: new Map(),
    // The manifest the head file carries, newest month first: [{ month, file, count, from, to }].
    archive: [],
    // Which shards this session has already fetched, by file. A shard is fetched once.
    loadedShards: new Set(),
    // How many stories exist across the head and every shard, as the capture reported it — the
    // number the reader is scrolling through, which is NOT the number currently in memory.
    archivedCount: 0,
    loadingMore: false,
  };
}

const keyOf = (a) => String(a?.id || a?.url || '');

/** A Moneycontrol id is the bare article number; every other publisher's is `<feed>:<url>`. */
const mcId = (a) => (/^\d+$/.test(String(a?.id || '')) ? Number(a.id) : null);

/**
 * Newest first across every publisher.
 *
 * ONE LIST, SEVERAL PUBLISHERS, AND ONLY ONE OF THEM HAS A SORTABLE ID.
 *   Moneycontrol's id is an article number that increases with publication, so it ordered their
 *   list correctly even for the stories whose date the per-article budget never reached. That stops
 *   working the moment a second publisher is in the list: `business-standard:www.…` does not compare
 *   with `14021956`, and no ordering over the two of them together can come from an id.
 *
 * SO THE ORDER IS THE PUBLISHED TIME — AND `firstSeenAt` IS NOT AN ACCEPTABLE STAND-IN FOR IT.
 *   That is the obvious fallback and it is measurably wrong here: all 303 undated stories in the
 *   shipped capture carry one of two `firstSeenAt` values, both from a single backfill run on 29
 *   August. Ordering by it would collapse half the archive into one instant and scramble stories
 *   whose real order their ids still describe exactly.
 *
 * SO AN UNDATED MONEYCONTROL STORY IS ANCHORED TO ITS DATED NEIGHBOURS, BY ID.
 *   An undated story takes the time of the nearest dated story above it in id order — falling back
 *   to the nearest below, and only then to when we first saw it. The id tie-break then orders a run
 *   of undated stories correctly among themselves, because they share their anchor's time and
 *   differ only by id.
 *
 *   THE ID IS ONLY APPROXIMATELY MONOTONIC, WHICH IS WHY IT ANCHORS AND NEVER ORDERS. Measured on
 *   the shipped capture: among the 296 stories that carry the publisher's own time, id order
 *   disagrees with publication order **76 times** — a quarter of them — by a median of 48 minutes
 *   and as much as 2.7 days. So the id was never the ordering it was taken for, and this list is
 *   more faithful to the publisher than the pure id sort it replaces, not less. Where a real time
 *   exists it decides; the id is used only to place stories that have none and to break exact ties.
 *
 * THIS IS AN ORDERING KEY AND IT IS NEVER A DISPLAYED TIME. The story's own `publishedAt` stays
 * null, the card still reads "time not published", the export still leaves the cell blank, and the
 * counts still say how many carry the publisher's time. Nothing derived here reaches the reader as
 * though the publisher had said it.
 */
function sortRows(list) {
  const rows = [...list];
  const at = new Map();
  const time = (v) => {
    const t = Date.parse(v || '');
    return Number.isFinite(t) ? t : null;
  };

  const mc = rows.filter((r) => mcId(r) !== null).sort((a, b) => mcId(b) - mcId(a));
  const anchorAbove = [];
  let seen = null;
  for (const r of mc) {
    seen = time(r.publishedAt) ?? seen;
    anchorAbove.push(seen);
  }
  let below = null;
  for (let i = mc.length - 1; i >= 0; i -= 1) {
    below = time(mc[i].publishedAt) ?? below;
    at.set(mc[i], time(mc[i].publishedAt) ?? anchorAbove[i] ?? below ?? time(mc[i].firstSeenAt) ?? 0);
  }
  for (const r of rows) {
    if (!at.has(r)) at.set(r, time(r.publishedAt) ?? time(r.firstSeenAt) ?? 0);
  }

  return rows.sort((a, b) => {
    const d = at.get(b) - at.get(a);
    if (d) return d;
    // Same instant: Moneycontrol's own id where both have one — this is what keeps a run of
    // undated stories sharing an anchor in the publisher's order rather than in Map order.
    const am = mcId(a);
    const bm = mcId(b);
    if (am !== null && bm !== null) return bm - am;
    if (am !== null) return -1;
    if (bm !== null) return 1;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/** Rebuild the merged view. The head wins on a collision: it is the newer read of the same story. */
function remerge() {
  const merged = new Map(state.older);
  for (const [k, a] of state.head) merged.set(k, a);
  state.byId = merged;
  state.articles = sortRows([...merged.values()]);
  // COUNTED HERE, so a month landing moves them. These two describe the list on screen — the export
  // banner and the provenance modal both print them against it — and leaving them on the head's own
  // figures would have the page say "147 of 600 carry the publisher's time" over a list where 297
  // do. Measured on the first archive load, which is how it was caught.
  state.withPublishedAt = state.articles.filter((a) => a.publishedAt).length;
  state.withoutPublishedAt = state.articles.length - state.withPublishedAt;
}

function absorb(body, { fromStore = false } = {}) {
  const list = Array.isArray(body?.articles) ? body.articles : [];
  if (!list.length) return false;

  const before = state.head;
  const next = new Map();
  for (const a of list) {
    const k = keyOf(a);
    if (k) next.set(k, a);
  }

  // The FIRST paint sets the baseline and announces nothing. Everything in the committed file was
  // published before the reader arrived, so replaying it through the alert stack would announce
  // history and teach them to ignore the component — the same rule watch.js follows for the two
  // polled feeds.
  if (state.baseline === null) {
    state.baseline = new Set(next.keys());
  } else {
    const added = [...next.keys()].filter((k) => !before.has(k) && !state.baseline.has(k));
    if (added.length) state.arrivals = [...added.map((k) => next.get(k)), ...state.arrivals].slice(0, 80);
  }

  state.head = next;
  state.sources = Array.isArray(body.sources) ? body.sources : [];
  state.archive = Array.isArray(body.archive) ? body.archive : [];
  // A capture written before the archive existed reports no total, and the honest fallback is what
  // we can actually count rather than a zero that would read as "no history".
  state.archivedCount = Number.isFinite(body.archivedCount) ? body.archivedCount : next.size;
  remerge();
  state.capturedAt = body.capturedAt || null;
  state.newestId = body.newestId || state.articles[0]?.id || null;
  state.origin = fromStore ? 'store' : 'snapshot';
  state.reason = null;
  state.message = null;
  return true;
}

async function read() {
  try {
    // No "force" needed: `conditionalJson` fetches with `cache: 'no-cache'`, which revalidates on
    // every call and reuses the bytes only when the server confirms them. A manual re-check and an
    // automatic one are therefore the same request — the difference is only who asked for it.
    const res = await conditionalJson(SNAPSHOT, { key: KEYS.marketNews, optional: true });
    // `fromStore` means the server answered 304 and these are bytes this device already held. The
    // check still happened, so `checkedAt` moves either way — that is the point of the two fields.
    state.checkedAt = Date.now();
    state.lastReadFailed = !Array.isArray(res?.value?.articles);
    if (!state.lastReadFailed) {
      const changed = absorb(res.value, { fromStore: !!res.fromStore });
      return changed;
    }
    if (!state.articles.length) {
      state.reason = 'no-capture';
      state.message = 'No market-news capture has been committed yet.';
    }
    return false;
  } catch (err) {
    state.checkedAt = Date.now();
    state.lastReadFailed = true;
    if (!state.articles.length) {
      state.reason = 'unreachable';
      state.message = String(err?.message || err);
    }
    return false;
  }
}

export function load() {
  if (loading) return loading;
  loading = (async () => {
    await read();
    state.loaded = true;
    emit();
    return state;
  })();
  return loading;
}

/**
 * Ask whether a newer capture exists. One conditional GET, usually a bodyless 304.
 *
 * IT DOES NOT AND CANNOT FETCH MONEYCONTROL — see the header. The reader is owed that distinction,
 * so the tab's control says "check for a newer capture" rather than anything that implies this
 * reaches the publisher.
 */
export async function refresh() {
  // COUNT THE IDS THAT ARE NEW, NEVER THE DIFFERENCE IN LENGTH.
  //
  // The capture is trimmed to KEEP (600). Once it is full, one story arriving pushes the oldest
  // off the end and the LENGTH DOES NOT MOVE — measured: capture 10:24 -> 10:41 added id
  // 14019028, dropped one, count 600 both times. So `articles.length - before` is zero for every
  // real arrival on a warm cache, and the button that exists to announce arrivals could never
  // announce one. Same lesson this codebase already carries twice over (see *Performance on large
  // tables* in CLAUDE.md): a count is not a comparison, and only a comparison can catch this.
  const before = new Set(state.byId.keys());
  const changed = await read();
  const added = [...state.byId.keys()].filter((k) => !before.has(k)).length;
  emit();
  return { changed, added, total: state.articles.length, capturedAt: state.capturedAt };
}

/**
 * The ids in the HEAD, for a caller that needs to compare two moments rather than count one.
 *
 * The head and not the merged list, because the question this answers is "did the capture move".
 * A reader scrolling back a month adds hundreds of ids to `byId` without a single story having been
 * published, and a comparison over that set would report the scroll as news arriving.
 */
export const idsHeld = () => new Set(state.head.keys());

// ---------------------------------------------------------------------------------------
// SCROLLING PAST THE HEAD — the archive
// ---------------------------------------------------------------------------------------
//
// The capture is two things: a bounded head every visitor downloads on arrival, and a shard per
// month that nobody downloads until they have read to the end of the head. That split is what lets
// the first paint stay at ~400 KB while the history behind it grows without limit.
//
// THREE RULES, and the third is the one that is easy to get wrong.
//
//   1. A SHARD IS FETCHED ONCE PER SESSION, and stored on the device under its own key, so a reader
//      who scrolls back through four months and returns tomorrow revalidates four small files
//      rather than downloading them again.
//   2. NOTHING HERE RUNS ON ITS OWN. It is called by the reader reaching the end of the list, which
//      is the demand signal — the same narrowing CLAUDE.md draws for the News tab's own fetch.
//   3. A SHARD THAT ADDS NOTHING IS NOT THE END OF THE ARCHIVE. The head is a window onto the same
//      stories, so the newest month or two are usually already held in full; a `loadMore` that
//      stopped at the first shard adding zero would report "that is everything" with months still
//      unread below it. It walks on until something lands or the manifest is spent — bounded, so
//      one gesture can never turn into an unbounded run of requests.

const SHARDS_PER_CALL = 3;

/**
 * The next shards worth fetching, newest month first.
 *
 * A shard the head already carries in FULL is skipped rather than downloaded, and the capture is
 * what says so — `inHead` is counted by the writer, which is the only place holding both sets. On a
 * young archive the head is a window onto every month there is, so this is the difference between
 * the first scroll to the end costing 400 KB to add nothing and costing no request at all. A shard
 * from a capture written before `inHead` existed reports undefined, which is not equal to `count`,
 * so it is fetched — the safe direction.
 */
const pendingShards = () =>
  state.archive.filter((a) => a && a.file && !state.loadedShards.has(a.file) && a.inHead !== a.count);

export function archiveMeta() {
  const pending = pendingShards();
  return {
    // Every story the capture says exists, head and archive together.
    total: Math.max(state.archivedCount, state.articles.length),
    held: state.articles.length,
    months: state.archive.length,
    monthsLoaded: state.loadedShards.size,
    remaining: pending.length,
    exhausted: pending.length === 0,
    loading: state.loadingMore,
    // The oldest date anything held actually carries, for a footer that says how far back you are.
    oldest: state.articles.length
      ? state.articles.reduce((min, a) => {
          const d = a.publishedAt || a.firstSeenAt;
          return d && (!min || d < min) ? d : min;
        }, null)
      : null,
  };
}

/**
 * Pull the next month (or three) of older stories in.
 *
 * Resolves to what actually happened rather than to a boolean, because the caller has three
 * different things to say: stories landed, the archive is spent, or a shard could not be read —
 * and "could not be read" must never be drawn as "there is nothing older", which is the same
 * outage-as-absence error the filings snapshot rules exist to prevent.
 */
export async function loadMore() {
  if (state.loadingMore) return { added: 0, busy: true, exhausted: false, failed: 0 };
  state.loadingMore = true;
  emit();
  let added = 0;
  let failed = 0;
  let reason = null;
  try {
    for (let i = 0; i < SHARDS_PER_CALL; i += 1) {
      const next = pendingShards()[0];
      if (!next) break;
      try {
        const res = await conditionalJson(`data/${next.file}`, { key: KEYS.marketNewsMonth(next.month), optional: true });
        const list = Array.isArray(res?.value?.articles) ? res.value.articles : null;
        if (!list) {
          // A shard named by the manifest that will not load is a real failure, and it is recorded
          // as one. It is NOT marked loaded: leaving it pending is what lets a later attempt — a
          // reader scrolling again after the network came back — pick it up.
          failed += 1;
          reason = res?.status ? `HTTP ${res.status}` : 'unreachable';
          break;
        }
        state.loadedShards.add(next.file);
        for (const a of list) {
          const k = keyOf(a);
          // The head's copy of a story is the newer read of it, so it is never overwritten here.
          if (k && !state.head.has(k) && !state.older.has(k)) {
            state.older.set(k, a);
            added += 1;
          }
        }
        if (added) break;
      } catch (err) {
        failed += 1;
        reason = String(err?.message || err);
        break;
      }
    }
    if (added) remerge();
  } finally {
    state.loadingMore = false;
  }
  emit();
  return { added, failed, reason, exhausted: pendingShards().length === 0, busy: false };
}

export const isLoaded = () => state.loaded;
export const rows = () => state.articles;
export const byId = (id) => state.byId.get(String(id)) || null;

/** Stories that appeared after this page's first paint. Consumed by core/watch.js. */
export const newArrivals = () => state.arrivals;

export function meta() {
  return {
    lastReadFailed: !!state.lastReadFailed,
    loaded: state.loaded,
    count: state.articles.length,
    withPublishedAt: state.withPublishedAt,
    withoutPublishedAt: state.withoutPublishedAt,
    capturedAt: state.capturedAt,
    checkedAt: state.checkedAt,
    newestId: state.newestId,
    arrivals: state.arrivals.length,
    origin: state.origin,
    reason: state.reason,
    message: state.message,
    // How many stories arrived in the first paint, kept apart from `count` — which grows as the
    // reader scrolls back. The provenance modal needs both to describe the capture honestly.
    headCount: state.head.size,
    sources: state.sources,
    archive: archiveMeta(),
  };
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Test seam: forget everything so a check can drive a first paint again. */
export function invalidate() {
  state = fresh();
  loading = null;
}

// ---------------------------------------------------------------------------------------
// STARTING A SCRAPE — the half of "refresh" that costs somebody something
// ---------------------------------------------------------------------------------------
//
// `refresh()` above asks whether a newer CAPTURE exists: one conditional GET, usually a bodyless
// 304, free. `startScrape()` asks the GitHub runner to go and READ MONEYCONTROL: a real Action run
// and a real request to the publisher. They are different acts and this module keeps them apart,
// the same way js/data/deep-dive.js keeps a metered POST apart from a free GET.
//
// FOUR THINGS THIS MUST NOT DO, all of them learned elsewhere in this codebase:
//
//   1. NEVER FIRE ON ITS OWN. No poller calls `startScrape`, nothing calls it on render, and the
//      route behind it is POST-only so a prefetcher cannot trip it. It happens on a click.
//   2. NEVER CLAIM THE NEWS HAS ARRIVED WHEN A RUN HAS MERELY FINISHED. The scrape commits only if
//      it found something, and `public/` reaches readers only after deploy.yml then runs. So a
//      completed run is not new stories on screen — `watchScrape` keeps checking the capture and
//      reports what it actually observed.
//   3. NEVER TRANSLATE THEIR VOCABULARY. `status` and `conclusion` are GitHub's words, passed
//      through. The view reproduces them; it does not invent a progress model for their pipeline.
//   4. NEVER TURN A NAMED FAILURE INTO "SOMETHING WENT WRONG". `no-token` is one command for an
//      operator; `unauthorised` is a token to reissue; `no-worker` means this origin is a plain
//      static server. Those have different fixes and the view says which.

// WHO ASKED, CARRIED INTO THE RUN NAME. `button` is a person pressing Fetch; `auto` is this tab
// fetching for a reader who opened it on a stale capture; an external scheduler sends `cron`. The
// last two are what `lastAutomatic` counts — see worker/index.js, which allowlists all three, so a
// value invented here would silently become `button` rather than reaching GitHub.
const DISPATCH_BASE = 'api/market-news/refresh';
const DISPATCH_SOURCES = new Set(['button', 'auto']);
const RUN_ROUTE = 'api/market-news/run';

// Long enough for a queue, a ~40s scrape and a ~90s deploy, and no longer: past this the watch
// stops and SAYS it stopped rather than spinning on a run that may never report.
const WATCH_BUDGET_MS = 6 * 60 * 1000;
const WATCH_EVERY_MS = 6000;
const REQUEST_TIMEOUT_MS = 12000;
// HOW LONG TO WAIT FOR THIS RUN'S CAPTURE TO REACH THE BROWSER, and the number has to be bigger
// than the thing it is waiting for. Measured: a push takes ~110 seconds to be served by
// Cloudflare's Git integration. At 45 seconds the grace expired first almost every time, so the
// watch reported `published` — "a new capture exists that you have not received" — when waiting
// another minute would have produced the real answer. That is not wrong, but it is the least
// informative true thing available, and it crowded out `nothing-new`, which is the one verdict on
// this tab that no other control can ever give.
//
// 150s clears a measured deploy with room to spare and still sits well inside WATCH_BUDGET_MS. A
// parameter, so a test can scale it rather than wait out the real one.
const PUBLISH_GRACE_MS = 150000;

async function askWorker(path, { method = 'GET' } = {}) {
  try {
    const res = await fetch(path, { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json', ...authHeaders(path) } });
    // A STATIC ORIGIN HAS NO WORKER, and that is a configuration fact rather than a failure of the
    // scrape. Saying "could not start" there would send an operator looking for a broken token
    // that does not exist.
    //
    // THE STATUS TO EXPECT IS NOT THE OBVIOUS ONE. `python3 -m http.server` answers a POST with
    // **501 Unsupported method**, not 404 — measured, and the first version of this check missed
    // it and reported the sandbox as an upstream failure. So all three of the answers a static
    // file server can give here are named, and the content type is checked as well: our Worker
    // always replies JSON, so an HTML error page is proof there is no Worker behind this origin
    // whatever number it came with.
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { ok: false, reason: 'no-worker', message: `This origin serves static files only — there is no Worker to start a scrape (HTTP ${res.status}).`, requested: path };
    }
    const type = res.headers.get('content-type') || '';
    if (!/json/i.test(type)) {
      return { ok: false, reason: 'no-worker', message: `This origin answered ${res.status} with ${type || 'no content type'}, not JSON — there is no Worker behind it.`, requested: path };
    }
    if (!res.ok) return { ok: false, reason: 'upstream', message: `The Worker answered ${res.status}.`, requested: path };
    return await res.json();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'unreachable', message: String(err?.message || err), requested: path };
  }
}

/** Ask the runner to read Moneycontrol. THE ONE CALL HERE THAT STARTS WORK. */
export function startScrape(source = 'button') {
  const who = DISPATCH_SOURCES.has(source) ? source : 'button';
  // The route owns its own query string, so it is built here and never patched onto by a caller —
  // the two-question-marks bug that made every News search ask for the same thing.
  return askWorker(`${DISPATCH_BASE}?source=${who}`, { method: 'POST' });
}

/** How the run is going. Free, so this is the half that may be polled. */
export function runStatus() {
  return askWorker(RUN_ROUTE);
}

/**
 * Watch a dispatched run through to an outcome, reporting each step to `onStep`.
 *
 * The outcome is a STATEMENT ABOUT WHAT WAS OBSERVED, never a freshness claim bought on credit:
 *
 *   'landed'     new article ids arrived. `added` counts them — BY IDENTITY, never by length,
 *                because a full capture drops one story for each it gains.
 *   'nothing-new' the run's own capture reached this browser and carried no id we did not already
 *                hold. Measured, not inferred from the absence of a deploy — the scrape restamps
 *                `capturedAt` and so commits on every run, which makes a following deploy evidence
 *                of nothing at all.
 *   'publishing' the scrape finished and a deploy is running, so stories are on their way but are
 *                not on screen yet. Different from both of the above.
 *   'published'  the run finished and its capture has not reached this browser inside the grace.
 *                Neither "nothing new" (nothing measured that) nor "landed" (nothing arrived).
 *   'failed'     GitHub reports the run as failed. Theirs to fix, and it says so.
 *   'timed-out'  the budget ran out with the run still going. NOT a failure — see CLAUDE.md's
 *                "Still reading… is a fourth outcome": reporting an unfinished check as failed is
 *                a failure claim about work that has not failed.
 */
export async function watchScrape({ onStep = () => {}, budgetMs = WATCH_BUDGET_MS, everyMs = WATCH_EVERY_MS, publishGraceMs = PUBLISH_GRACE_MS, now = Date.now } = {}) {
  const startedAt = now();
  // Identity, not length — see `refresh()`. On a full capture a new story replaces an old one and
  // the count never moves, so counting would report every arrival as "nothing new".
  const idsBefore = new Set(state.byId.keys());
  const capturedBefore = state.capturedAt;
  let sawRunFinish = null;

  while (now() - startedAt < budgetMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const st = await runStatus();

    if (st.ok === false) {
      // A blip must not end the watch — but a configuration failure will not fix itself.
      if (['no-worker', 'no-token', 'no-repo', 'unauthorised', 'forbidden'].includes(st.reason)) return { outcome: 'failed', ...st };
      onStep({ phase: 'checking', error: st.reason });
      continue;
    }

    const { scrape, publish } = st;

    if (!scrape || scrape.status !== 'completed') {
      onStep({ phase: 'scraping', scrape, publish });
      continue;
    }
    if (scrape.conclusion && scrape.conclusion !== 'success') {
      return { outcome: 'failed', scrape, publish, message: `The scrape run finished as "${scrape.conclusion}".` };
    }
    if (!sawRunFinish) sawRunFinish = now();

    await refresh();
    const added = [...state.byId.keys()].filter((k) => !idsBefore.has(k)).length;
    if (added > 0) return { outcome: 'landed', added, scrape, publish };

    // ZERO NEW IDS IS ONLY AN ANSWER ONCE WE ARE LOOKING AT THIS RUN'S OWN OUTPUT.
    //
    // The scrape stamps `capturedAt` on every run and therefore commits on every run, so a deploy
    // following the run proves nothing about whether stories were found — the first version read
    // it as proof and concluded "nothing new" from its absence, seconds after the run ended and
    // long before any deploy could have appeared. The honest gate is the capture itself: until
    // `capturedAt` moves past what we held, the bytes on screen predate the run and say nothing
    // about it.
    const movedOn = state.capturedAt && state.capturedAt !== capturedBefore;
    if (movedOn) return { outcome: 'nothing-new', scrape, publish };

    if (publish && publish.status !== 'completed') {
      onStep({ phase: 'publishing', scrape, publish });
      continue;
    }
    if (publish && publish.conclusion && publish.conclusion !== 'success') {
      return { outcome: 'publish-failed', scrape, publish, message: `The run finished, but the deploy after it finished as "${publish.conclusion}", so the new capture is not on the site yet.` };
    }
    // The run is done and its capture has not reached this browser. Give it a bounded grace, then
    // say exactly that — neither "nothing new" (unmeasured) nor "landed" (untrue).
    if (now() - sawRunFinish >= publishGraceMs) return { outcome: 'published', scrape, publish };
    onStep({ phase: 'publishing', scrape, publish });
  }
  return { outcome: 'timed-out' };
}

// ---------------------------------------------------------------------------------------
// The twenty-minute poll
// ---------------------------------------------------------------------------------------

export const LIVE_ID = 'market-news';

// TWENTY MINUTES, AND THE REASON IS NO LONGER "THAT IS THE ACTION'S CADENCE".
//
// It was, and the measurement killed that rationale: a `*/20` cron fired 12 times in 41 hours, and
// the job now runs every 30 minutes across the window the publisher answers and hourly outside it.
// So this interval is no longer matched to anything upstream — it is simply a floor on how stale a
// mounted tab can be, chosen because an unchanged poll is a bodyless 304 and therefore nearly free.
// Polling faster would not surface a story sooner; polling slower would only delay one that landed.
// The capture's own `capturedAt` is what the page reports, so this number is never a freshness
// claim — it only decides how quickly a published capture is noticed.
export const POLL_MS = 20 * 60 * 1000;

/**
 * Register and start the poll. Returns a stop function.
 *
 * Resolving with a value is what makes `live.js` notify subscribers, so this returns the state only
 * when the capture actually moved. A tick that finds the same capture repaints nothing — otherwise
 * the table would rebuild every twenty minutes and throw away the reader's search and sort for a
 * tick that carried nothing.
 */
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const changed = await read();
      if (!changed) return null;
      emit();
      return state;
    },
  });
  live.start(LIVE_ID, { fresh: true });
  return () => live.stop(LIVE_ID);
}
