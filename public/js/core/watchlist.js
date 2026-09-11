// core/watchlist.js — THE COMPANIES THE DESK IS TRACKING. ONE LIST, EVERY DEVICE.
//
//   watchlist.all()               [{ ticker, name, addedAt, addedBy }], newest first
//   watchlist.tickers()           Set of upper-case NSE symbols
//   watchlist.has(ticker)         is this company tracked?
//   watchlist.toggle(t, name, by) star / unstar, returns the new state
//   watchlist.size()              how many companies
//   watchlist.onChange(fn)        fires on every mutation, in this tab
//   watchlist.meta()              where the list on screen came from, and whether it is confirmed
//   watchlist.syncNow()           revalidate against the shared list and flush queued edits
//
// WHY THIS IS A COMPANY LIST AND NOT A ROW LIST
//   The star used to live entirely inside `scoreTable` and stored whatever that table happened to
//   use as its row key. That is a different thing on every tab: Breakouts keyed on the ticker, the
//   Earnings Hub on Moneycontrol's scID, the Con-call table on `company|time|document`, the three
//   filings tabs on a composite of the row's own cells. So the set held four vocabularies at once
//   and could not answer the one question a watchlist exists to answer — WHICH COMPANIES.
//
//   The Watchlist scope needs that answer, so the star marks a company. `scoreTable` takes a
//   `watchKey(row)` (the ticker) alongside `key(row)` (the row's identity), and the two are allowed
//   to differ: three announcements from one company are three rows and one watched company, and
//   starring any of them fills the star on all three.
//
// WHY IT IS NO LONGER A LIST PER BROWSER
//   It was `localStorage` and nothing else, so it was a list per DEVICE. Two people at one desk
//   kept two different watchlists and neither could see the other's; the same person on a phone saw
//   a third. Every device held a partial answer and none of them said so. The shared list on the
//   Worker is the truth now, and this file keeps a copy of it.
//
//   THE COPY IS NOT A SECOND OPINION. It is what paints while the network is being asked, it is
//   what survives an outage, and it never claims to be the shared list: `meta().origin` reports
//   `live` only once the server has confirmed what is on screen IN THIS SESSION, `store` for bytes
//   this device kept from an earlier visit, and `pending` while an edit of the reader's own has not
//   been accepted yet. Those are three different claims and collapsing them is how a dashboard ends
//   up printing "connected" over a list nobody has checked.
//
// AN EDIT IS SENT AS WHAT IT WAS, NOT AS THE LIST IT PRODUCED.
//   Sending the whole array would make every star a silent delete of everything anyone else added
//   since this tab last read. So the outbox holds intents — add this, remove that — and the server
//   applies them to whatever the list is now. See `data/watchlist-shared.js`.
//
// A FAILED READ IS NEVER AN EMPTY LIST.
//   `adopt()` is reached only from a response that actually carried companies. A 503, an aborted
//   fetch and a static origin with no Worker at all leave the list exactly as it was and say so
//   through `meta()`. Rendering a failed read as "nobody is watching anything" would be the same
//   error as a count of zero from a failing endpoint, on the one list the reader owns.
//
// THE LEGACY SET IS PRUNED, NOT REINTERPRETED.
//   An upgrading reader has an array of old row keys under this same storage key. Reading them all
//   back as tickers would file `RELIANCE|2026-08-12|3` as a company — a value that meant something
//   else, read as a measurement, which is the error this codebase is built to avoid. So the
//   migration keeps only entries SHAPED like an NSE symbol and drops the rest, once, recording that
//   it ran. A dropped entry was never a company; it was a row.

import { conditionalJson, KEYS } from './store.js';
import * as people from './watchlist-people.js';
import {
  SYMBOL_RE, WATCHLIST_INTENT_BATCH, companyName, isNewerWatchlist, normTicker, personName,
} from '../data/watchlist-shared.js';

const STORAGE_KEY = 'sattva:watchlist';
const MIGRATED_KEY = 'sattva:watchlist:shape';
const OUTBOX_KEY = 'sattva:watchlist:outbox';
const SEEDED_KEY = 'sattva:watchlist:seeded';
const ROUTE = 'api/watchlist';

// The shared list is small and changes when a person acts, so this is a safety net behind the
// write-through — not the mechanism. An edit reaches the server immediately; this catches what
// somebody ELSE did on another device.
const POLL_MS = 60000;
const RETRY_MS = 15000;

// A star is a keystroke, not a transaction. Somebody working down a screener stars four companies
// in a couple of seconds, and firing a request on each one sends four writes where one carrying
// four intents would do — wasteful against our own rate limit, and against a list that ends up in
// the same state either way. The outbox is persisted, so a few hundred milliseconds of batching
// risks nothing: a tab closed inside the window still sends the edits on its next visit.
const WRITE_DEBOUNCE_MS = 400;

// One wording for one condition, so the editor's status line and any future surface cannot give
// the reader two different accounts of the same outage.
const UNREACHABLE =
  'The shared watchlist could not be reached. Your changes are saved on this device and will be sent when it is.';

export { SYMBOL_RE };

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

let shared = { revision: null, updatedAt: null };
let checkedAt = null;      // when the server last confirmed what is on screen, in this session
let confirmed = false;     // has a read in THIS session vouched for the painted list?
let lastError = null;
let syncing = null;
let retryAt = 0;
let writeTimer = null;

/** Batch a burst of edits into one write. `syncNow()` cancels any pending one, so an awaited sync
 *  leaves no scheduled work behind — which is what makes settling this deterministic. */
function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void syncNow({ force: true });
  }, WRITE_DEBOUNCE_MS);
}

function readRaw(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback; // private mode / storage disabled — the session still works, it just won't persist
  }
}

function read() {
  const parsed = readRaw(STORAGE_KEY, []);
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    // v2/v3 entries are objects; the legacy shape is a bare string.
    const ticker = normTicker(typeof item === 'string' ? item : item?.ticker);
    // Legacy numeric row IDs were never accepted as companies; do not reinterpret them now
    // that new, explicit company entries can use verified six-digit BSE identifiers.
    if (typeof item === 'string' && /^\d+$/.test(ticker)) continue;
    if (!ticker || seen.has(ticker) || !SYMBOL_RE.test(ticker)) continue;
    seen.add(ticker);
    out.push({
      ticker,
      // A legacy entry has no name. It is left null rather than filled with the ticker, so the
      // views can say "name not recorded" instead of printing a symbol as though it were one.
      name: typeof item === 'string' ? null : companyName(item?.name),
      addedAt: typeof item === 'string' ? null : item?.addedAt || null,
      // Likewise for the contributor: null means nothing ever recorded who, which is a different
      // claim from "nobody" and must never be printed as a name.
      addedBy: typeof item === 'string' ? null : personName(item?.addedBy),
    });
  }
  return out;
}

function write(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(MIGRATED_KEY, '3');
  } catch {
    // Nothing to do: the toggle still works for this session.
  }
}

/**
 * Rewrite the stored array in the current shape once, dropping whatever could never have been a
 * symbol. Called on first read so an upgrading reader's star count matches what the app can show.
 */
function migrateOnce() {
  let done;
  try {
    done = localStorage.getItem(MIGRATED_KEY);
  } catch {
    return;
  }
  if (done === '3') return;
  write(read());
}
migrateOnce();

// ---------------------------------------------------------------------------------------------
// The outbox — edits this device has made and the shared list has not accepted yet.
// It is persisted because the alternative is losing somebody's star to a closed tab or a tunnel.

const outbox = () => readRaw(OUTBOX_KEY, []).filter((i) => i && SYMBOL_RE.test(normTicker(i.ticker)));

function writeOutbox(list) {
  try {
    if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    /* The edit still applies locally and will be re-derived on the next mutation. */
  }
}

function queue(intent) {
  // One pending edit per company: starring, unstarring and starring again is one state to send,
  // not three to replay. The newest intent is the one that describes what the reader wants.
  const next = outbox().filter((i) => normTicker(i.ticker) !== intent.ticker);
  next.push(intent);
  writeOutbox(next);
}

// ---------------------------------------------------------------------------------------------
// Reads. All synchronous, because every scope filter in the dashboard calls them during a render.

/** Every tracked company. Most recently added first — a watchlist is a working set, not a ledger. */
export function all() {
  return read().sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

/** Upper-case symbols, for the scope filters. */
export function tickers() {
  return new Set(read().map((e) => e.ticker));
}

export function has(ticker) {
  const t = normTicker(ticker);
  return !!t && read().some((e) => e.ticker === t);
}

/** The name recorded when this company was starred, or null if it was starred before names were. */
export function nameFor(ticker) {
  const t = normTicker(ticker);
  return read().find((e) => e.ticker === t)?.name || null;
}

/** Who added this company, or null where nothing ever recorded it. Never a guess. */
export function addedByFor(ticker) {
  const t = normTicker(ticker);
  return read().find((e) => e.ticker === t)?.addedBy || null;
}

export function size() {
  return read().length;
}

/**
 * Where the list on screen came from, and what has actually been confirmed about it.
 *
 * `origin` is DERIVED from what has happened, never assigned — the same rule the filings feeds
 * follow, and for the same reason: a field four call sites can write is a field that will read
 * `live` over bytes nobody checked.
 */
export function meta() {
  const pending = outbox().length;
  return {
    shared: confirmed,
    origin: pending ? 'pending' : confirmed ? 'live' : 'store',
    checkedAt,
    revision: shared.revision,
    updatedAt: shared.updatedAt,
    pending,
    error: lastError,
    count: size(),
  };
}

// ---------------------------------------------------------------------------------------------
// Writes. Local first so the star fills on the click, then queued for the shared list.

export function add(ticker, name = null, by = null) {
  const t = normTicker(ticker);
  if (!t || !SYMBOL_RE.test(t)) return false;
  // Whoever the caller named, else whoever this device last added under. A call site with neither
  // is not asked to invent one — the edit travels as a `seed`, which records no contributor and
  // reads as "added before names were recorded" rather than crediting the wrong person.
  const contributor = personName(by) || people.me();
  const entries = read();
  const hit = entries.find((e) => e.ticker === t);
  if (hit) {
    // Re-starring an already-tracked company is not an event, but a NAME arriving for an entry that
    // had none is worth keeping — that is how a legacy entry acquires one. The contributor is NOT
    // overwritten: whoever added it added it.
    const nextName = hit.name || companyName(name);
    if (nextName !== hit.name) {
      hit.name = nextName;
      write(entries);
      emit();
    }
    if (contributor) people.remember(contributor);
    return true;
  }
  entries.push({ ticker: t, name: companyName(name), addedAt: new Date().toISOString(), addedBy: contributor || null });
  write(entries);
  queue(contributor ? { op: 'add', ticker: t, name: companyName(name), by: contributor } : { op: 'seed', ticker: t, name: companyName(name) });
  if (contributor) people.remember(contributor);
  emit();
  scheduleWrite();
  return true;
}

export function remove(ticker, by = null) {
  const t = normTicker(ticker);
  const entries = read();
  const next = entries.filter((e) => e.ticker !== t);
  if (next.length === entries.length) return false;
  const contributor = personName(by) || people.me();
  write(next);
  queue({ op: 'remove', ticker: t, by: contributor || null });
  if (contributor) people.remember(contributor);
  emit();
  scheduleWrite();
  return true;
}

/** Star / unstar. Returns whether the company is tracked AFTER the toggle. */
export function toggle(ticker, name = null, by = null) {
  const t = normTicker(ticker);
  if (!t) return false;
  if (has(t)) {
    remove(t, by);
    return false;
  }
  return add(t, name, by);
}

export function clear(by = null) {
  for (const entry of read()) remove(entry.ticker, by);
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Exported for the tests and for anything that needs to know what shape a symbol has. */
export const isSymbolShaped = (t) => SYMBOL_RE.test(normTicker(t));

// ---------------------------------------------------------------------------------------------
// The shared list.

/**
 * Replace the device copy with the shared list, then re-apply this device's un-accepted edits.
 *
 * The re-application is what stops a star flickering off half a second after it was clicked: the
 * server has not been told yet, so its answer legitimately does not contain the company, and
 * painting that answer raw would show the reader their own edit being undone.
 */
function adopt(snapshot) {
  if (!Array.isArray(snapshot?.companies)) return false;
  if (!isNewerWatchlist(snapshot, shared)) return false;
  const byTicker = new Map();
  for (const row of snapshot.companies) {
    const ticker = normTicker(row?.ticker);
    if (!ticker || !SYMBOL_RE.test(ticker)) continue;
    byTicker.set(ticker, { ticker, name: companyName(row?.name), addedAt: row?.addedAt || null, addedBy: personName(row?.addedBy) });
  }
  for (const intent of outbox()) {
    const ticker = normTicker(intent.ticker);
    // A `seed` IS NOT RE-APPLIED, and that distinction is the whole of this loop's honesty.
    //
    // `add` and `remove` are the reader's own click a moment ago: the server has not been told yet,
    // so its answer legitimately does not reflect them, and painting it raw would show somebody
    // their own edit being undone. A `seed` is not a click — it is this device GUESSING that a
    // company it still holds locally belongs on the shared list, and the server is entitled to
    // refuse it, which it does for anything already removed. Painting a seed before it is accepted
    // put a company somebody had deliberately dropped back on screen for a whole cycle.
    if (intent.op === 'seed') continue;
    if (intent.op === 'remove') byTicker.delete(ticker);
    else if (!byTicker.has(ticker)) {
      byTicker.set(ticker, {
        ticker,
        name: companyName(intent.name),
        addedAt: intent.at || new Date().toISOString(),
        addedBy: personName(intent.by),
      });
    }
  }
  shared = { revision: snapshot.revision ?? null, updatedAt: snapshot.updatedAt || null };
  people.ingest(snapshot.people);
  write([...byTicker.values()]);
  return true;
}

async function flush() {
  const queued = outbox();
  if (!queued.length) return true;
  let remaining = [...queued];
  while (remaining.length) {
    const batch = remaining.slice(0, WATCHLIST_INTENT_BATCH);
    const response = await fetch(ROUTE, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // `at` is this device's note to itself for the optimistic repaint above; the SERVER stamps
      // the time it accepted the edit, because ordering two devices by either one's clock means
      // trusting whichever is furthest wrong.
      body: JSON.stringify({ intents: batch.map(({ op, ticker, name, by }) => ({ op, ticker, name, by })) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`watchlist ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body.companies)) throw new Error('Invalid watchlist response');
    // Only what the server acknowledged leaves the outbox, so a partial batch retries the rest
    // rather than reporting an edit that never landed.
    const done = new Set((body.outcomes || []).map((o) => normTicker(o.ticker)));
    remaining = remaining.slice(batch.length);
    writeOutbox([...remaining, ...batch.filter((i) => !done.has(normTicker(i.ticker)))]);
    shared = { revision: null, updatedAt: null }; // a write always supersedes what we held
    adopt(body);
    // A company refused for capacity is NOT on the list, and the local copy must not pretend it is.
    const full = (body.outcomes || []).filter((o) => o.outcome === 'full').map((o) => normTicker(o.ticker));
    lastError = full.length ? `The shared watchlist is full, so ${full.join(', ')} could not be added.` : null;
  }
  return true;
}

/**
 * Revalidate against the shared list and send anything queued.
 *
 * One in flight at a time: the star, the poller, a returning tab and the scope editor can all ask
 * at once, and three simultaneous reads of one small list is waste that also races itself.
 */
export function syncNow({ force = false } = {}) {
  // Any batched write is folded into this pass rather than firing again behind it.
  clearTimeout(writeTimer);
  writeTimer = null;
  if (syncing) return syncing;
  if (!force && Date.now() < retryAt) return Promise.resolve(meta());
  syncing = (async () => {
    try {
      await flush();
      const read0 = await conditionalJson(ROUTE, { key: KEYS.sharedWatchlist, optional: true });
      if (!read0 || !read0.value) {
        confirmed = false;
        // THREE ABSENCES, AND ONLY TWO OF THEM ARE FAULTS.
        //   404 — this deployment serves no Worker at all, which is a supported way to run this
        //         dashboard (the verification suite runs it that way). The list is this device's
        //         and nothing is wrong, so nothing is reported.
        //   0   — the request never completed: offline, or a tunnel that dropped it.
        //   any other status — a server that answered, badly.
        // Collapsing them would either cry wolf on a static origin or stay silent through an
        // outage, and the status travels on the miss for exactly this reason.
        lastError = read0?.status === 404 ? null : UNREACHABLE;
        retryAt = Date.now() + RETRY_MS;
        return meta();
      }
      if (read0.value.ok === false) throw new Error(read0.value.reason || 'watchlist-unavailable');
      // Carrying this device's old list across happens BEFORE the adopt, and anything it queues is
      // sent in the same pass — otherwise a seeded company would wait a whole cycle to be decided
      // on, and `meta()` would report a pending edit nobody had made.
      seedOnce(read0.value);
      if (outbox().length) await flush();
      adopt(read0.value);
      checkedAt = read0.checkedAt || Date.now();
      confirmed = true;
      retryAt = 0;
      lastError = outbox().length ? lastError : null;
      return meta();
    } catch (error) {
      // A failed re-check is not a failed read: the list already on screen is a real list and stays.
      confirmed = false;
      lastError = UNREACHABLE;
      retryAt = Date.now() + RETRY_MS;
      return meta();
    } finally {
      syncing = null;
      emit();
    }
  })();
  return syncing;
}

/**
 * Carry this device's existing watchlist into the shared list, once.
 *
 * These companies are real and nobody's name was ever recorded against them, so they travel as
 * `seed` — which the server refuses to apply over ANY row it already holds, watched or removed. A
 * browser last opened a month ago therefore cannot resurrect a company somebody has since dropped,
 * which is the one way a well-meaning migration could quietly undo a deliberate edit.
 */
function seedOnce(snapshot) {
  let done;
  try {
    done = localStorage.getItem(SEEDED_KEY);
  } catch {
    return;
  }
  if (done === '1') return;
  const remote = new Set((snapshot.companies || []).map((c) => normTicker(c.ticker)));
  const queued = new Set(outbox().map((i) => normTicker(i.ticker)));
  for (const entry of read()) {
    if (remote.has(entry.ticker) || queued.has(entry.ticker)) continue;
    queue(entry.addedBy ? { op: 'add', ticker: entry.ticker, name: entry.name, by: entry.addedBy } : { op: 'seed', ticker: entry.ticker, name: entry.name });
  }
  try {
    localStorage.setItem(SEEDED_KEY, '1');
  } catch {
    /* It will be attempted again next visit, and `seed` is idempotent by design. */
  }
}

let stopPoll = null;

/** Keep the list in step with whatever anyone else is doing, while this tab is visible. */
export function startWatchlistSync() {
  if (stopPoll) return stopPoll;
  const tick = () => {
    if (document.hidden || navigator.onLine === false) return;
    void syncNow();
  };
  const timer = setInterval(tick, POLL_MS);
  const onVisible = () => {
    if (!document.hidden) void syncNow({ force: true });
  };
  const onOnline = () => void syncNow({ force: true });
  // Another tab on this device edited the same list. Re-read rather than re-fetch — those bytes
  // are already correct, and the poller covers what happened elsewhere.
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY || event.key === OUTBOX_KEY) emit();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('storage', onStorage);
  void syncNow({ force: true });
  stopPoll = () => {
    clearTimeout(writeTimer);
    writeTimer = null;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('storage', onStorage);
    stopPoll = null;
  };
  return stopPoll;
}

export { people };
