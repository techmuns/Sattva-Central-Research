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
const REJECTED_KEY = 'sattva:watchlist:rejected';
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

// Keep an authoritative session copy when browser storage is denied or full. A failed
// write must never make the next read fall back to stale disk bytes (or an empty list).
const sessionValues = new Map();
const pendingStorage = new Set();
const pendingStorageBases = new Map();
const failedStorageReads = new Set();
const unreadStorage = new Set();

function storedValue(key) {
  if (pendingStorage.has(key)) return sessionValues.get(key) ?? null;
  try {
    const value = localStorage.getItem(key);
    sessionValues.set(key, value);
    failedStorageReads.delete(key);
    return value;
  } catch {
    failedStorageReads.add(key);
    if (!sessionValues.has(key)) unreadStorage.add(key);
    return sessionValues.get(key) ?? null;
  }
}

const intentKey = intent => intent.id || JSON.stringify([intent.op, intent.ticker, intent.name, intent.by, intent.at]);

function mergeStoredIntents(baseRaw, localRaw, diskRaw) {
  const base = new Set(parseArray(baseRaw).map(intentKey));
  const local = parseArray(localRaw);
  const localKeys = new Set(local.map(intentKey));
  const removed = new Set([...base].filter(key => !localKeys.has(key)));
  const merged = new Map(parseArray(diskRaw)
    .filter(intent => !removed.has(intentKey(intent)))
    .map(intent => [normTicker(intent.ticker), intent]));
  for (const intent of local) {
    // An unchanged base entry removed by a sibling is already acknowledged. Only
    // this tab's new edits may be re-applied over the current disk queue.
    if (base.has(intentKey(intent))) continue;
    const ticker = normTicker(intent.ticker);
    const sibling = merged.get(ticker);
    // Both tabs use this device's clock. Keep the newer local click when they edit
    // the same company; these times never determine ordering on the shared server.
    if (!sibling || (Date.parse(intent.at) || 0) >= (Date.parse(sibling.at) || 0)) merged.set(ticker, intent);
  }
  const next = [...merged.values()];
  return next.length ? JSON.stringify(next) : null;
}

function mergeStoredCompanies(baseRaw, localRaw, diskRaw) {
  const base = new Set(read(parseArray(baseRaw)).map(entry => entry.ticker));
  const local = new Map(read(parseArray(localRaw)).map(entry => [entry.ticker, entry]));
  const merged = new Map(read(parseArray(diskRaw)).map(entry => [entry.ticker, entry]));
  for (const intent of outbox()) {
    const ticker = normTicker(intent.ticker);
    if (intent.op === 'remove') merged.delete(ticker);
    else if (!merged.has(ticker) && (intent.op === 'add' || (local.has(ticker) && !base.has(ticker)))) {
      // Preserve new local additions, including unnamed contributions sent as
      // seeds. An old migration seed cannot override a newer sibling removal.
      merged.set(ticker, local.get(ticker) || {
        ticker, name: companyName(intent.name), addedAt: intent.at || null, addedBy: personName(intent.by),
      });
    }
  }
  return JSON.stringify([...merged.values()]);
}

function persistValue(key, authoritative = false) {
  if (unreadStorage.has(key) || (key === SEEDED_KEY && unreadStorage.has(STORAGE_KEY))) return;
  try {
    let value = sessionValues.get(key);
    if (key === OUTBOX_KEY || key === REJECTED_KEY) {
      const disk = localStorage.getItem(key);
      value = mergeStoredIntents(pendingStorageBases.get(key), value, disk);
      sessionValues.set(key, value);
      // If this write fails again, disk entries adopted by the merge are now the
      // base, so a later sibling acknowledgement cannot resurrect them.
      pendingStorageBases.set(key, disk);
    } else if (key === STORAGE_KEY) {
      const disk = localStorage.getItem(key);
      if (!authoritative && disk !== pendingStorageBases.get(key)) {
        // A sibling has advanced the mirror since this tab's last readable copy.
        // Reconcile pending clicks over it instead of replacing it with an older
        // failed write. A fresh server adoption can replace the mirror directly.
        value = mergeStoredCompanies(pendingStorageBases.get(key), value, disk);
        sessionValues.set(key, value);
      }
      pendingStorageBases.set(key, disk);
    }
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    pendingStorage.delete(key);
    pendingStorageBases.delete(key);
    failedStorageReads.delete(key);
  } catch {
    // Retain both the value and the outstanding write for the next sync.
  }
}

function saveValue(key, value, authoritative = false) {
  if (!pendingStorage.has(key)) pendingStorageBases.set(key, sessionValues.get(key) ?? null);
  sessionValues.set(key, value);
  pendingStorage.add(key);
  // Never persist "migration complete" ahead of the edits carrying the old list.
  if (key !== SEEDED_KEY || !pendingStorage.has(OUTBOX_KEY)) persistValue(key, authoritative);
}

function retryStorage() {
  // If storage was denied at startup, its old list/outbox may never have been read.
  // Recover those bytes before a temporary session copy can overwrite them.
  for (const key of new Set([OUTBOX_KEY, REJECTED_KEY, STORAGE_KEY, ...unreadStorage])) {
    if (!unreadStorage.has(key)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (key === OUTBOX_KEY || key === REJECTED_KEY) {
        saveValue(key, mergeStoredIntents(null, sessionValues.get(key), raw));
      } else if (key === STORAGE_KEY) {
        const needsSeed = localStorage.getItem(SEEDED_KEY) !== '1';
        const recovered = read(parseArray(raw));
        if (needsSeed) {
          const queued = new Set(outbox().map(intent => normTicker(intent.ticker)));
          for (const entry of recovered) {
            if (!queued.has(entry.ticker)) queue({ op: 'seed', ticker: entry.ticker, name: entry.name });
          }
        }
        if (needsSeed || !confirmed) {
          // These are actual saved rows, not a server acknowledgement. Keep them
          // visible and durable until migration can run, even if saving its outbox
          // is still blocked. Otherwise the empty startup fallback destroys the
          // only recoverable copy when storage returns before the connection does.
          const retained = new Map([...recovered, ...read(parseArray(sessionValues.get(key)))]
            .map(entry => [entry.ticker, entry]));
          for (const intent of outbox()) {
            const ticker = normTicker(intent.ticker);
            if (intent.op === 'remove') retained.delete(ticker);
            else if (intent.op === 'add' && !retained.has(ticker)) {
              retained.set(ticker, { ticker, name: companyName(intent.name), addedAt: intent.at || null, addedBy: personName(intent.by) });
            }
          }
          saveValue(key, JSON.stringify([...retained.values()]));
        }
        // The recovery above already reconciled these previously unread bytes.
        if (pendingStorage.has(key)) pendingStorageBases.set(key, raw);
      }
      if (!pendingStorage.has(key)) sessionValues.set(key, raw);
      unreadStorage.delete(key);
      failedStorageReads.delete(key);
    } catch {
      // Still inaccessible; keep the session copy and leave the old bytes untouched.
    }
  }
  // Resolve any sibling acknowledgements before overlaying pending edits on its mirror.
  for (const key of new Set([OUTBOX_KEY, REJECTED_KEY, ...pendingStorage])) {
    if (key !== SEEDED_KEY && pendingStorage.has(key)) persistValue(key);
  }
  if (pendingStorage.has(SEEDED_KEY) && !pendingStorage.has(OUTBOX_KEY)) persistValue(SEEDED_KEY);
}

function parseArray(raw, fallback = []) {
  try {
    const parsed = JSON.parse(raw || 'null');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readRaw(key, fallback) {
  return parseArray(storedValue(key), fallback);
}

function read(parsed = readRaw(STORAGE_KEY, [])) {
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

function write(entries, authoritative = false) {
  saveValue(STORAGE_KEY, JSON.stringify(entries), authoritative);
  saveValue(MIGRATED_KEY, '3');
}

/**
 * Rewrite the stored array in the current shape once, dropping whatever could never have been a
 * symbol. Called on first read so an upgrading reader's star count matches what the app can show.
 */
function migrateOnce() {
  if (storedValue(MIGRATED_KEY) !== '3') write(read());
}
migrateOnce();

// ---------------------------------------------------------------------------------------------
// The outbox — edits this device has made and the shared list has not accepted yet.
// It is persisted because the alternative is losing somebody's star to a closed tab or a tunnel.

function outbox() {
  return readRaw(OUTBOX_KEY, []).filter((i) => i && SYMBOL_RE.test(normTicker(i.ticker)));
}

function writeOutbox(list) {
  saveValue(OUTBOX_KEY, list.length ? JSON.stringify(list) : null);
}

const rejected = () => readRaw(REJECTED_KEY, []);
function writeRejected(list) {
  saveValue(REJECTED_KEY, list.length ? JSON.stringify(list) : null);
}

function identifiedOutbox() {
  const list = outbox();
  if (list.some(intent => !intent.id)) {
    // Older releases persisted no IDs. Assign them once before sending, so an
    // acknowledgement can distinguish that edit from a later edit to the same ticker.
    const identified = list.map(intent => intent.id ? intent : { ...intent, id: crypto.randomUUID() });
    writeOutbox(identified);
    return identified;
  }
  return list;
}

function queue(intent) {
  // One pending edit per company: starring, unstarring and starring again is one state to send,
  // not three to replay. The newest intent is the one that describes what the reader wants.
  const next = outbox().filter((i) => normTicker(i.ticker) !== intent.ticker);
  next.push({ ...intent, id: crypto.randomUUID(), at: new Date().toISOString() });
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
  const count = size();
  const pending = outbox().length;
  const refused = rejected();
  const storageUnavailable = pendingStorage.size > 0 || failedStorageReads.size > 0;
  const connectionError = storageUnavailable && lastError === UNREACHABLE
    ? 'The shared watchlist could not be reached. Keep this tab open until your changes have been sent.'
    : lastError;
  const capacityError = refused.length
    ? `The shared watchlist is full, so ${refused.map(entry => entry.ticker).join(', ')} could not be added. Remove a company and try adding again.`
    : null;
  const storageError = storageUnavailable
    ? 'Browser storage is unavailable. This tab keeps a temporary copy; keep it open while changes are pending.'
    : null;
  return {
    shared: confirmed,
    origin: pending ? 'pending' : confirmed ? 'live' : 'store',
    checkedAt,
    revision: shared.revision,
    updatedAt: shared.updatedAt,
    pending,
    error: [connectionError, capacityError, storageError].filter(Boolean).join(' ') || null,
    storageAvailable: !storageUnavailable,
    rejected: refused,
    count,
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
  queue(contributor ? { op: 'add', ticker: t, name: companyName(name), by: contributor } : { op: 'seed', ticker: t, name: companyName(name) });
  write(entries);
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
  queue({ op: 'remove', ticker: t, by: contributor || null });
  write(next);
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
  const refused = rejected();
  const unresolved = refused.filter(entry => !byTicker.has(normTicker(entry.ticker)));
  if (unresolved.length !== refused.length) writeRejected(unresolved);
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
  write([...byTicker.values()], true);
  return true;
}

async function flush() {
  const attempted = new Set();
  while (true) {
    const batch = identifiedOutbox().filter(intent => !attempted.has(intent.id)).slice(0, WATCHLIST_INTENT_BATCH);
    if (!batch.length) break;
    for (const intent of batch) attempted.add(intent.id);
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
    // Re-read the CURRENT queue after the await. Its contents may have changed in
    // this tab or another tab. Only the exact acknowledged edit leaves the queue.
    const done = new Set((body.outcomes || []).map(outcome => normTicker(outcome.ticker)));
    const acknowledged = new Set(batch.filter(intent => done.has(intent.ticker)).map(intent => intent.id));
    writeOutbox(outbox().filter(intent => !acknowledged.has(intent.id)));
    const refusals = new Map(rejected().map(intent => [intent.ticker, intent]));
    for (const outcome of body.outcomes || []) {
      const ticker = normTicker(outcome.ticker);
      const intent = batch.find(entry => entry.ticker === ticker);
      if (!intent) continue;
      if (outcome.outcome === 'full') refusals.set(ticker, intent);
      else refusals.delete(ticker);
    }
    writeRejected([...refusals.values()]);
    shared = { revision: null, updatedAt: null }; // a write always supersedes what we held
    adopt(body);
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
  // Assign the in-flight promise before any early return can clear it in finally.
  syncing = Promise.resolve().then(async () => {
    try {
      retryStorage();
      // A queued edit can be left by an interrupted first visit. Preserve the old
      // device list BEFORE its acknowledgement adopts the server's smaller list.
      if (outbox().length && !seedOnce({ companies: [] })) {
        confirmed = false;
        lastError = null;
        retryAt = 0;
        return meta();
      }
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
      if (!seedOnce(read0.value)) {
        confirmed = false;
        lastError = null;
        retryAt = 0;
        return meta();
      }
      if (outbox().length) await flush();
      adopt(read0.value);
      checkedAt = read0.checkedAt || Date.now();
      confirmed = true;
      retryAt = 0;
      lastError = null;
      retryStorage();
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
  });
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
  // An unread list is protected from persistence until retryStorage recovers it,
  // so the tab can still work online. A readable legacy list needs its migration
  // status established before any server response can replace those saved rows.
  if (unreadStorage.has(STORAGE_KEY)) return true;
  if (unreadStorage.has(SEEDED_KEY)) return false;
  const seeded = storedValue(SEEDED_KEY);
  if (failedStorageReads.has(SEEDED_KEY)) return false;
  if (seeded === '1') return true;
  const remote = new Set((snapshot.companies || []).map((c) => normTicker(c.ticker)));
  const queued = new Set(outbox().map((i) => normTicker(i.ticker)));
  for (const entry of read()) {
    if (remote.has(entry.ticker) || queued.has(entry.ticker)) continue;
    queue({ op: 'seed', ticker: entry.ticker, name: entry.name });
  }
  saveValue(SEEDED_KEY, '1');
  return true;
}

let stopPoll = null;

/** Keep the list in step with whatever anyone else is doing, while this tab is visible. */
export function startWatchlistSync() {
  if (stopPoll) return stopPoll;
  const tick = () => {
    if ((document.hidden || innerWidth === 0) || navigator.onLine === false) return;
    void syncNow();
  };
  const timer = setInterval(tick, POLL_MS);
  const onVisible = () => {
    if (!(document.hidden || innerWidth === 0)) void syncNow({ force: true });
  };
  const onOnline = () => void syncNow({ force: true });
  // Another tab on this device edited the same list. Re-read rather than re-fetch — those bytes
  // are already correct, and the poller covers what happened elsewhere.
  const onStorage = (event) => {
    if ([STORAGE_KEY, OUTBOX_KEY, REJECTED_KEY].includes(event.key)) emit();
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
