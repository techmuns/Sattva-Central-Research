// core/store.js — the persistent client-side cache for large feeds.
//
//   const hit = await readEntry('earnings:yoy');            // { tag, savedAt, value } | null
//   writeEntry('earnings:yoy', { tag, value });             // fire-and-forget, never awaited on paint
//   const out = await conditionalJson(path, { key });       // { status, value, tag, savedAt, checkedAt }
//
// WHY THIS EXISTS
//   Two feeds on this dashboard are large and polled: the results feed (~1.1MB of JSON, 1,384
//   rows) and the con-call scan (~450KB, 877 rows). Both were fetched with `cache: 'no-store'`,
//   which disables the browser's HTTP cache outright — so a 30-second poll re-downloaded the whole
//   payload every tick whether or not a single figure had moved, and every page load re-downloaded
//   the committed snapshot from scratch. Over an hour with both tabs open that is ~34MB to say
//   "nothing changed" 120 times.
//
//   So: the payload we already have is kept on disk, and the network is asked only what it can
//   tell us that we do not already know.
//
// WHY INDEXEDDB AND NOT localStorage
//   localStorage is synchronous, string-only, and capped around 5MB for the WHOLE origin. The
//   results payload alone is 1.1MB; stringifying and writing it on every tick would block the main
//   thread, and overflowing the quota would start evicting the `sattva:*` keys that hold the
//   watchlist and the keyword sets. IndexedDB is asynchronous, stores structured values without a
//   stringify step, and its quota is measured in hundreds of megabytes.
//
// DEGRADING IS NOT FAILING
//   Private windows, disabled storage and `file://` all make IndexedDB unavailable. Every function
//   here falls back to an in-memory Map: the session still gets its cache, it just does not
//   survive a reload. Nothing in the app may treat a store miss as an error — a miss means
//   "fetch it", which is exactly what the code did before this module existed.

import { authHeaders } from './host-context.js';

const DB_NAME = 'sattva-cache';
const DB_VERSION = 1;
const STORE = 'payloads';

// Everything the store holds, so a version bump or a manual clear has one list to walk.
export const KEYS = {
  earnings: (subType) => `earnings:${subType}`,
  concalls: 'concalls',
  // The `list` half is keyed separately from the strip-only request: they are different
  // representations of the same date and storing them under one key would let a strip-only
  // response answer for a request that wanted the company list, or the reverse.
  calendar: (date, list = 'full') => (list === 'full' ? `calendar:${date}` : `calendar:${date}:${list}`),
  // One entry per investor rather than one blob for all of them. Each book has its own ETag
  // upstream, so a quarter landing for one investor must not invalidate the other fifty.
  investorList: 'investors:list',
  investorBook: (slug) => `investor:${slug}`,
  // The committed snapshot of every book — one file, so one entry, unlike the per-investor keys
  // above which mirror the upstream's one-page-per-investor shape.
  investorSnapshot: 'investors:snapshot',
  chatter: 'chatter',
  // One finished Concall Deep Dive report, under THEIR slug. Unlike every other key here it is not
  // fetched with `conditionalJson`: that dashboard's `GET /api/report` sends no ETag and wraps the
  // body in a status envelope, so there is no validator to send and nothing to 304. The reason to
  // keep it is different too — not bytes, but the fact that a report costs a metered LLM run to
  // produce, so losing our copy of one is the one cache miss the reader pays for in money.
  deepDiveReport: (slug) => `deepdive:${slug}`,
  // News, announcements and insider trades. One entry per committed snapshot and one per company
  // walked live, so a quarter landing for one company cannot invalidate the other six hundred.
  filings: (kind) => `filings:${kind}`,
  filingRow: (kind, ticker) => `filings:${kind}:${ticker}`,
  // Additive insider history is separate from the exact HTTP response and its ETag.
  insiderHistory: (ticker) => `insider-history:${ticker}`,
  // Market-wide stocks news, the Universe half of the News tab. One committed capture, refreshed
  // by a scheduled Action — neither the browser nor the Worker can read the publisher directly.
  marketNews: 'market-news',
  // One entry per ARCHIVE MONTH, not one for the whole archive. A reader who has scrolled back
  // three months holds three entries, and a story landing in the current month must not invalidate
  // the two below it — the same reasoning as the per-investor and per-company keys above.
  marketNewsMonth: (month) => `market-news:${month}`,
  // NSE's live announcements feed — one committed blob, refreshed live off /api/nse-announcements.
  nseFilings: 'nse-filings',
  // Separate from the HTTP response/ETag: a shrinking live window cannot erase retained rows.
  nseFilingsHistory: 'nse-filings:history',
  // X/Twitter posts from the monitored handles, which join the market-news list. Its own key
  // rather than a slice of `marketNews`: the two are separate captures with separate ETags, and a
  // post landing must not invalidate 600 publisher stories.
  twitterPosts: 'twitter-posts',
};

// The in-memory tier. Always written, so a reader that lands during an IndexedDB round trip still
// gets the value, and so the whole module keeps working when IndexedDB does not.
const memory = new Map();

let dbPromise = null;
let unavailable = false;

function openDb() {
  if (unavailable) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      unavailable = true;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      unavailable = true;
      resolve(null);
    };
    // Safari in a private window can hang the open request rather than erroring. Six seconds is
    // long enough for a cold disk and short enough that first paint never waits on it.
    setTimeout(() => resolve(null), 6000);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    let out;
    try {
      const t = db.transaction(STORE, mode);
      out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** True once IndexedDB has answered and answered usefully. Drives the "cached on this device" copy. */
export function isPersistent() {
  return !unavailable;
}

/**
 * Read one entry. Resolves to `{ tag, savedAt, value }` or null — never rejects, because a store
 * that cannot be read is indistinguishable, to every caller, from a store that is empty.
 */
export async function readEntry(key) {
  const mem = memory.get(key);
  if (mem) return mem;
  const db = await openDb();
  if (!db) return null;
  const row = await tx(db, 'readonly', (s) => s.get(key));
  if (!row || !row.value) return null;
  memory.set(key, row);
  return row;
}

/**
 * Read many entries at once, in ONE transaction, resolving to a Map of key -> entry.
 *
 * `readEntry` in a loop is correct and slow in a specific way: each call opens its own IndexedDB
 * transaction, and a transaction is a round trip to the storage thread. The super-investor feed
 * reads ninety-one keys before it can paint anything, and ninety-one transactions is ninety-one
 * of those round trips on the critical path of the first paint. One transaction serving ninety-one
 * `get`s is a single round trip.
 *
 * Missing keys are simply absent from the Map — a miss is never an error here either.
 */
export async function readEntries(keys) {
  const out = new Map();
  const wanted = [];
  for (const key of keys) {
    const mem = memory.get(key);
    if (mem) out.set(key, mem);
    else wanted.push(key);
  }
  if (!wanted.length) return out;

  const db = await openDb();
  if (!db) return out;

  // Not `tx()`: that helper resolves with one request's `.result`, and this needs every request's.
  // The transaction stays open across all of them and completes when the last one settles.
  await new Promise((resolve) => {
    let t;
    try {
      t = db.transaction(STORE, 'readonly');
    } catch {
      return resolve();
    }
    const s = t.objectStore(STORE);
    for (const key of wanted) {
      let req;
      try {
        req = s.get(key);
      } catch {
        continue;
      }
      req.onsuccess = () => {
        const row = req.result;
        if (!row || !row.value) return;
        memory.set(key, row);
        out.set(key, row);
      };
    }
    t.oncomplete = resolve;
    t.onerror = resolve;
    t.onabort = resolve;
  });
  return out;
}

/**
 * Write one entry. NOT awaited by callers on the paint path: a 1.1MB structured clone costs a few
 * milliseconds and there is nothing to do with the result. The in-memory tier is updated
 * synchronously so a read that follows immediately sees the new value either way.
 */
export function writeEntry(key, { tag, value, savedAt = Date.now() }) {
  const row = { tag: tag || null, savedAt, value };
  memory.set(key, row);
  return openDb()
    .then((db) => (db ? tx(db, 'readwrite', (s) => s.put(row, key)) : null))
    .catch(() => null);
}

export function deleteEntry(key) {
  memory.delete(key);
  return openDb()
    .then((db) => (db ? tx(db, 'readwrite', (s) => s.delete(key)) : null))
    .catch(() => null);
}

/** Drop everything. Exposed for the Sources modal's "clear cached data" affordance. */
export function clearAll() {
  memory.clear();
  return openDb()
    .then((db) => (db ? tx(db, 'readwrite', (s) => s.clear()) : null))
    .catch(() => null);
}

/**
 * A conditional GET backed by the store.
 *
 *   { status: 200, value, tag, savedAt, checkedAt }   fresh payload, already written to the store
 *   { status: 304, value, tag, savedAt, checkedAt }   unchanged; `value` is our copy, never parsed
 *   { status: 0,   value: null }                      unreachable / not JSON — caller decides
 *
 * WHY THE VALIDATOR IS NOT SENT BY HAND
 *   The obvious implementation is `cache: 'no-store'` with our own `If-None-Match` header, so that
 *   our stored body and our stored tag are always paired. It does not survive contact with
 *   Chromium: a hand-rolled conditional request whose response is a 304 is killed with
 *   `net::ERR_ABORTED` a couple of seconds later. The fetch rejects, and because a poller swallows
 *   optional errors, the symptom is not an error — it is a feed that quietly stops updating.
 *   Measured: ticks kept firing every 32s and every one of them was aborted.
 *
 *   So the browser drives the revalidation instead — `cache: 'no-cache'` means "always ask, but
 *   reuse what you have if the answer is 304". The browser sends the validator, handles the 304,
 *   and hands us back a 200 carrying the stored body.
 *
 * WHICH LEAVES ONE THING TO RECOVER: NOT PARSING WHAT WE ALREADY HAVE.
 *   The response's ETag is readable before its body is. If it matches the tag we stored alongside
 *   our copy, nothing changed — so we return our copy and never touch `res.json()`. That keeps the
 *   450KB parse off the main thread on every unchanged tick, which is the only benefit the manual
 *   version had left.
 */
export async function conditionalJson(path, { key, optional = false, signal } = {}) {
  const stored = key ? await readEntry(key) : null;

  let res;
  try {
    // `no-cache`, NOT `no-store`: revalidate on every call, but let the browser reuse the bytes it
    // already holds when the server says they are still good. `no-store` would forbid that reuse
    // and put the whole payload back on the wire every single tick.
    // `authHeaders(path)` is an ALLOW-LIST and spreads to nothing for everything that is not a
    // Munshot API — every `data/*.json` committed file goes through here too, and a static asset
    // neither needs the reader's JWT nor should carry it. See js/core/host-context.js.
    res = await fetch(path, { headers: { accept: 'application/json', ...authHeaders(path) }, cache: 'no-cache', signal });
  } catch (err) {
    if (optional) return miss(0);
    throw err;
  }

  const checkedAt = Date.now();
  if (!res.ok) {
    // The status travels with the miss. An optional fetch that fails is not always the same event:
    // a 404 is a route that is not there and a 503 is one to wait for, and a caller that wants to
    // NAME the failure on screen cannot do it from `value === null` alone.
    if (optional) return miss(res.status);
    throw new Error(`${path} (${res.status})`);
  }

  // The tag travels in the body as well as the header. The header is authoritative where it can be
  // read; the body copy is what survives a cross-origin response whose ETag is not exposed.
  const headerTag = res.headers.get('etag');
  if (headerTag && stored?.tag === headerTag && stored.value) {
    return { status: 304, value: stored.value, tag: stored.tag, savedAt: stored.savedAt, checkedAt, fromStore: true };
  }

  let value;
  try {
    value = await res.json();
  } catch (err) {
    if (optional) return miss(res.status);
    throw err;
  }

  const tag = headerTag || value?.meta?.contentTag || null;
  // Same short-circuit, for the case where the ETag header was unreadable and the tag had to come
  // out of the body. The parse is already paid for, but the caller still learns nothing changed.
  if (tag && stored?.tag === tag && stored.value) {
    return { status: 304, value: stored.value, tag: stored.tag, savedAt: stored.savedAt, checkedAt, fromStore: true };
  }

  if (key) writeEntry(key, { tag, value, savedAt: checkedAt });
  return { status: 200, value, tag, savedAt: checkedAt, checkedAt, fromStore: false };

  // `status: 0` means the request never completed (network, CORS, abort); any other value is what
  // the server actually said.
  function miss(status = 0) {
    return { status, value: null, tag: null, savedAt: null, checkedAt: Date.now(), fromStore: false, missed: true };
  }
}

/**
 * A plain JSON fetch that is allowed to use the browser cache, for the committed snapshots under
 * `data/`. Those are static assets served with an ETag, so `no-cache` means "revalidate, do not
 * re-download" — a 304 on a 1.1MB file costs a couple of hundred bytes. They were being fetched
 * with `no-store`, which forbids reuse entirely and made every reload pay full price.
 *
 * IN-FLIGHT REQUESTS ARE SHARED, AND THAT IS NOT THE SAME AS BEING CACHED.
 * Two modules ask for `universe.json` on the same page load and two ask for `mc-ticker-map.json`.
 * The browser's cache cannot help there: both requests are issued in the same tick, so neither has
 * anything to revalidate against and both download in full — 163KB and 249KB, twice. Keying the
 * promise by path collapses each pair into one request. It is deliberately only the promise that
 * is shared, not the parsed value: a later, separate call still revalidates, so this cannot serve
 * a stale file — it can only stop the same file being fetched twice at once.
 */
const inFlightJson = new Map();

export function revalidatedJson(path, { optional = false } = {}) {
  const existing = inFlightJson.get(path);
  if (existing) return optional ? existing.catch(() => null) : existing;

  const p = fetch(path, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`${path} (${res.status})`);
      return res.json();
    })
    .finally(() => inFlightJson.delete(path));

  inFlightJson.set(path, p);
  return optional ? p.catch(() => null) : p;
}
