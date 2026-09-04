// data/chatter-live.js — the live retail-chatter feed (SentimentDash), loaded once and cached.
//
//   load()                    fetch, resolve, cache
//   companies() / uncovered() the two sections
//   forScope(scope)           narrow the covered half to the book
//   meta()                    counts, freshness, provenance
//   startLive(live) / stopLive(live) / onChange(fn) / newArrivals()
//
// WHAT THIS FEED IS
//   Companies and topics trending across ValuePickr, TradingQnA and Google News over a rolling 30
//   days, counted and keyword-scored by SentimentDash. THE COUNTS AND THE SENTIMENT ARE THEIRS and
//   are reproduced, never re-banded — the same rule the Con-call tab follows with StockScans'
//   result score. The one thing derived here is the NSE symbol, because their payload has none.
//
// TWO NUMBERS THAT ARE NOT WHAT THEY LOOK LIKE
//   `mentionsChangePct` is a change in MENTION COUNT between scrapes. There is no price anywhere
//   in this API. It is named that way in `sentiment-shared.js` precisely so nothing downstream can
//   render it as a return by reading the field name, and no surface may colour it like a P&L.
//   `sparkline` is a per-RUN series, not per-day — points are scrapes, so nothing may put a time
//   axis under it.
//
// THE SPLIT INTO TWO SECTIONS IS A COVERAGE STATEMENT, NOT A TAXONOMY
//   Entries are discovered bottom-up from forum topics, so the feed mixes companies we cover,
//   companies we do not, foreign names (`cisco`, `spacex`, `ubs`) and bare themes (`fiis`,
//   `income`). We do not attempt to say which is which — that would be a judgement we cannot
//   support. We say only what we can test: whether the slug resolves to a symbol in our own
//   coverage. Measured on a real run: 45 of 219 do.
//
// THE POLL IS HOURLY, AND THAT IS ALREADY GENEROUS
//   The upstream re-scrapes twice a day, at 01:30 and 13:30 UTC. Anything faster asks a question
//   whose answer cannot have changed, and an unchanged poll is a bodyless 304 against their ETag.

import { conditionalJson, revalidatedJson, KEYS } from '../core/store.js';
import { buildResolverIndex, resolveAll, fingerprint, normaliseDashboard, normalisePosts, SOURCE_LABEL } from './sentiment-shared.js';
import * as coverage from './coverage.js';
import { filterByScope } from './scope.js';

export const LIVE_ID = 'chatter-live';
const POLL_MS = 60 * 60 * 1000; // hourly — see the header
const STORE_KEY = KEYS.chatter;

/**
 * THE BROWSER CALLS THIS API DIRECTLY. IT IS NOT PROXIED, AND IT CANNOT BE.
 *
 * It was, through `/api/chatter` on our own Worker, for the reasons every other upstream is: one
 * fetch per cache window instead of one per reader, and somewhere to turn a failure into a named
 * state. That shipped and returned 404 in production while `curl` got 200 from the same URL.
 *
 * The cause is a platform rule, not our code. **Cloudflare refuses a subrequest from one Worker to
 * another Worker's `*.workers.dev` hostname on the same account** — error 1042, "Worker tried to
 * fetch from another Worker on the same zone, which is not allowed" — and surfaces the refusal as
 * a 404, which is indistinguishable from the upstream not being there. Our other three upstreams
 * (moneycontrol.com, stockscans.in, devde.muns.io) are all off-zone, so this is the only one that
 * could ever have hit it. The relaxation Cloudflare offers applies to custom domains, not to
 * workers.dev.
 *
 * So the browser calls it, exactly as it already calls the Concall Deep Dive Worker — also on
 * workers.dev, also direct, and working for precisely this reason.
 *
 * NOTHING IS LOST BY DOING SO, WHICH IS WHY THIS IS A FIX AND NOT A RETREAT. Verified against the
 * live endpoint: `access-control-allow-origin: *`, `access-control-expose-headers: ETag`, and
 * `If-None-Match` answered with a bodyless 304. So `conditionalJson` revalidates against their tag
 * exactly as it did against ours, and the device store still means a repeat visit costs headers.
 * Their own `cache-control: public, max-age=60, stale-while-revalidate=300` does the politeness
 * work the edge cache was there for, over data that only moves twice a day.
 */
const DEFAULT_BASE = 'https://sentimentdash-api.tech-441.workers.dev/v1';

/** `localStorage` first so a verification run can point the whole feed at a stub. */
function baseUrl() {
  try {
    const override = localStorage.getItem('sattva:chatter-base');
    if (override) return override.replace(/\/+$/, '');
  } catch { /* storage disabled — fall through */ }
  const configured = typeof window !== 'undefined' ? window.SATTVA_CHATTER_URL : null;
  return String(configured || DEFAULT_BASE).replace(/\/+$/, '');
}

let loadPromise = null;
let cache = null;
let resolverIndex = null;
let seenSlugs = null; // populated on first load; anything new after that is an arrival
let arrivals = [];
const listeners = new Set();
const postsCache = new Map();
const postsInFlight = new Map();

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
  await buildIndex();
  ingest(await fetchFeed(), { origin: 'live' });
  return cache;
}

/**
 * One read of the feed, with every failure mode NAMED rather than thrown.
 *
 * Returns the normalised payload with `ok: true`, or `{ ok: false, reason }`. The reasons matter
 * because the fixes differ: `no-url` and `not-found` are things somebody corrects, `unreachable`,
 * `upstream` and `timeout` are things to wait for, and `shape` means their contract moved.
 *
 * A FAILED READ IS NEVER AN EMPTY ONE. `entries: []` only ever travels with `ok: false` beside it.
 */
async function fetchFeed() {
  const base = baseUrl();
  if (!/^https?:\/\//i.test(base)) return { ok: false, reason: 'no-url' };

  let out;
  try {
    out = await conditionalJson(`${base}/dashboard?limit=all`, { key: STORE_KEY, optional: true });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (!out.value) {
    // THE URL TRAVELS WITH THE FAILURE. The first version of this recorded only a status code, and
    // a bare "404" cost a long investigation: the upstream was healthy and answering 200 to curl
    // the whole time, and nothing on screen or in the payload said which address had actually been
    // requested. A failure that cannot be diagnosed from its own artefact is half a failure state.
    const url = `${base}/dashboard`;
    // `status: 0` from the store means the request never completed at all — DNS, TLS, a blocked
    // CORS preflight, or an offline device. Anything else is what the server actually said.
    if (out.status === 0) return { ok: false, reason: 'unreachable', url };
    if (out.status === 404) return { ok: false, reason: 'not-found', status: 404, url };
    return { ok: false, reason: 'upstream', status: out.status, url };
  }

  const shaped = normaliseDashboard(out.value);
  if (!shaped.entries.length && !shaped.overview) return { ok: false, reason: 'shape' };

  // Their /health carries `ageSeconds` — how stale the scrape is on the clock that is authoritative
  // about it, rather than a subtraction between their timestamp and ours. Asked alongside and never
  // instead: a healthy /health with an unreadable /dashboard is still a failure, so this one is
  // allowed to fail quietly.
  const health = await fetchHealth(base);

  return {
    ok: true,
    reason: null,
    ...shaped,
    health,
    checkedAt: out.checkedAt,
    fromStore: out.status === 304,
  };
}

async function fetchHealth(base) {
  try {
    const res = await fetch(`${base}/health`, { headers: { accept: 'application/json' }, cache: 'no-cache' });
    if (!res.ok) return null;
    const body = await res.json();
    // `ageSeconds` is nested under `data`, not at the top level — the integration spec describes it
    // as available "directly" and reading it that way silently produced null. Found against the
    // real endpoint; the flat fallback stays in case they hoist it later.
    const d = body?.data || {};
    const age = Number(d.ageSeconds ?? body?.ageSeconds);
    return { status: body?.status ?? null, ageSeconds: Number.isFinite(age) ? age : null };
  } catch {
    return null;
  }
}

/**
 * The slug → NSE symbol lookup.
 *
 * Three sources, widest last. `universe.json` and the book give 603 symbols and resolved 26 of a
 * real 219-entry run; adding `mc-ticker-map.json` — 1,722 Indian listed companies, already in the
 * repo for the Earnings Hub — takes that to 45, and every one of the extra nineteen is a genuine
 * listed company (NRB Bearings, JNK India, Balu Forge, Northern Arc…). All three files are fetched
 * elsewhere in the app, so on a warm cache this costs a revalidation, not a download.
 */
async function buildIndex() {
  if (resolverIndex) return resolverIndex;
  const sources = [];

  for (const h of coverage.holdings()) if (h.ticker) sources.push({ ticker: h.ticker, name: h.name });

  // Through `revalidatedJson`, not a bare fetch: the Earnings Hub reads these same two files, and
  // when both tabs are visited in one session the in-flight sharing there turns two downloads of
  // 163KB and 249KB into one each. Same headers, same revalidation — only the duplication goes.
  const [uni, mc] = await Promise.all([revalidatedJson('data/universe.json', { optional: true }), revalidatedJson('data/mc-ticker-map.json', { optional: true })]);

  for (const row of Array.isArray(uni) ? uni : []) {
    const t = String(row['Screener URL'] || '').match(/\/company\/([^/]+)/)?.[1];
    if (t) sources.push({ ticker: t, name: row.Company });
  }
  for (const v of Object.values(mc?.map || {})) if (v?.ticker) sources.push({ ticker: v.ticker, name: v.fullName });

  resolverIndex = buildResolverIndex(sources);
  return resolverIndex;
}

function ingest(payload, { origin, checkedAt } = {}) {
  const ok = !!payload?.ok;
  const entries = ok ? resolveAll(payload.entries || [], resolverIndex) : [];
  if (cache?.meta?.generatedAt && payload?.generatedAt && cache.meta.generatedAt !== payload.generatedAt) postsCache.clear();

  // Arrivals: an entry the feed did not carry last time we looked. The first load seeds the set
  // rather than announcing 219 things that have been sitting there for a fortnight — the same
  // backlog rule the results and con-call watchers follow.
  if (seenSlugs === null) {
    seenSlugs = new Set(entries.map((e) => e.slug));
  } else {
    for (const e of entries) {
      if (seenSlugs.has(e.slug)) continue;
      seenSlugs.add(e.slug);
      arrivals.unshift({ ...e, seenAt: Date.now() });
    }
    arrivals = arrivals.slice(0, 40);
  }

  const companies = entries.filter((e) => e.ticker).sort(byMentions);
  const uncovered = entries.filter((e) => !e.ticker).sort(byMentions);

  cache = {
    ok,
    reason: payload?.reason || null,
    entries,
    companies,
    uncovered,
    byTicker: new Map(companies.map((e) => [e.ticker.toUpperCase(), e])),
    overview: payload?.overview || null,
    meta: {
      ok,
      reason: payload?.reason || null,
      url: payload?.url || null,
      // Their scrape time, and their own view of how stale it is. `ageSeconds` comes from their
      // /health route — the only clock authoritative about their data — rather than a subtraction
      // between their timestamp and ours, which are two different clocks.
      generatedAt: payload?.generatedAt || null,
      ageSeconds: payload?.health?.ageSeconds ?? null,
      window: payload?.window || '30d',
      total: entries.length,
      companies: companies.length,
      uncovered: uncovered.length,
      totalPosts: payload?.overview?.totalPosts ?? null,
      sourceTotals: payload?.overview?.sourceTotals || null,
      origin: payload?.fromStore ? 'store' : origin || 'live',
      checkedAt: payload?.checkedAt || checkedAt || Date.now(),
    },
  };
}

const byMentions = (a, b) => b.mentions - a.mentions || String(a.name).localeCompare(String(b.name));

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.entries : []);
export const companies = () => (cache ? cache.companies : []);
export const uncovered = () => (cache ? cache.uncovered : []);
export const loadedPosts = () => [...postsCache.values()];
export const overview = () => (cache ? cache.overview : null);
export const meta = () => (cache ? cache.meta : null);
export const byTicker = (t) => (cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null);
export const newArrivals = () => arrivals;
export const sourceLabel = (k) => SOURCE_LABEL[k] || k;

/**
 * Load the actual items behind one dashboard mention count, only after the reader asks for them.
 * The detail endpoint is public and already linked by every dashboard row. A per-slug in-memory
 * cache keeps reopening a row instant without turning a table paint into hundreds of requests.
 */
export function postsFor(slug) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) return Promise.reject(new Error('No chatter topic was supplied.'));
  if (postsCache.has(key)) return Promise.resolve(postsCache.get(key));
  if (postsInFlight.has(key)) return postsInFlight.get(key);

  const pending = fetchPosts(key).finally(() => postsInFlight.delete(key));
  postsInFlight.set(key, pending);
  return pending;
}

async function fetchPosts(slug) {
  const base = baseUrl();
  if (!/^https?:\/\//i.test(base)) throw new Error('The chatter feed has no usable address.');

  const url = `${base}/stocks/${encodeURIComponent(slug)}/posts?limit=1000&sort=newest`;
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-cache' });
  } catch {
    throw new Error('The mentions could not be reached.');
  }
  if (!response.ok) throw new Error(`The mentions endpoint returned HTTP ${response.status}.`);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('The mentions endpoint returned an unreadable response.');
  }
  const normalised = normalisePosts(body);
  const result = { ...normalised, slug: normalised.slug || slug, endpoint: url };
  postsCache.set(slug, result);
  for (const fn of listeners) fn();
  return result;
}

/**
 * Portfolio scope narrows the COVERED half only.
 *
 * The uncovered half has no ticker by definition, so it cannot be filtered by one — and filtering
 * it to nothing would be a silent claim that the book is not discussed, when the truth is that we
 * could not tell. The tab keeps that section whole in both scopes and says so.
 */
export function forScope(scope, rows = companies()) {
  return filterByScope(rows, scope, coverage.tracked());
}

// ---------------------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------------------

export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const feed = await fetchFeed();
      // A tick that fails leaves whatever is on screen alone. The tab reported the failure the
      // first time it happened; replacing a good table with an error because one poll missed
      // would be worse than saying nothing.
      if (!feed.ok) return null;
      if (feed.fromStore) {
        // Revalidated, unchanged. Move "last checked" and nothing else — that is a different fact
        // from "last scraped", and conflating them would age the data backwards.
        // A failed first load also creates a cache object, but it does not contain the stored rows.
        // Recover that case by ingesting the confirmed device payload rather than blessing the
        // empty failure shell as though it were the payload that received the 304.
        if (cache?.meta?.ok === true) {
          cache.meta = { ...cache.meta, ok: true, reason: null, checkedAt: feed.checkedAt || Date.now() };
          return null;
        }
        ingest(feed, { origin: 'store' });
        return cache;
      }
      const before = cache ? fingerprint(cache.entries) : null;
      ingest(feed);
      // Repaint only on a real change, so a tick that carried nothing new never throws away the
      // reader's sort and search.
      return before !== fingerprint(cache.entries) ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[chatter-live] listener failed', err);
      }
    }
  });
  live.start(LIVE_ID, { fresh: true });
  return () => {
    off();
    live.stop(LIVE_ID);
  };
}

/** Revalidate once for General Alerts without mounting the hourly poller. */
export async function refresh() {
  await buildIndex();
  const feed = await fetchFeed();
  if (!feed.ok) {
    if (!cache) ingest(feed, { origin: 'live' });
    else {
      // Keep the last good rows visible, but make the failed confirmation explicit to consumers.
      cache.meta = {
        ...cache.meta,
        ok: false,
        reason: feed.reason || 'upstream',
        url: feed.url || cache.meta.url || null,
        checkedAt: Date.now(),
      };
    }
    return cache;
  }
  if (feed.fromStore) {
    if (cache?.meta?.ok === true) cache.meta = { ...cache.meta, ok: true, reason: null, checkedAt: feed.checkedAt || Date.now() };
    else ingest(feed, { origin: 'store' });
    return cache;
  }
  const before = cache ? fingerprint(cache.entries) : null;
  ingest(feed, { origin: 'live' });
  if (before !== fingerprint(cache.entries)) {
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[chatter-live] listener failed', err);
      }
    }
  }
  return cache;
}

export function stopLive(live) {
  live?.stop?.(LIVE_ID);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
