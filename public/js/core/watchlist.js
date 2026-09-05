// core/watchlist.js — THE COMPANIES THE READER IS TRACKING.
//
//   watchlist.all()            [{ ticker, name, addedAt }], newest first
//   watchlist.tickers()        Set of upper-case NSE symbols
//   watchlist.has(ticker)      is this company tracked?
//   watchlist.toggle(t, name)  star / unstar, returns the new state
//   watchlist.size()           how many companies
//   watchlist.onChange(fn)     fires on every mutation, in this tab
//
// WHY THIS IS A COMPANY LIST AND NOT A ROW LIST
//   The star used to live entirely inside `scoreTable` and stored whatever that table happened to
//   use as its row key. That is a different thing on every tab: Breakouts keyed on the ticker, the
//   Earnings Hub on Moneycontrol's scID, the Con-call table on `company|time|document`, the three
//   filings tabs on a composite of the row's own cells. So the set held four vocabularies at once
//   and could not answer the one question a watchlist exists to answer — WHICH COMPANIES.
//
//   The Watchlist scope needs that answer, so the star now marks a company. `scoreTable` takes a
//   `watchKey(row)` (the ticker) alongside `key(row)` (the row's identity), and the two are allowed
//   to differ: three announcements from one company are three rows and one watched company, and
//   starring any of them fills the star on all three.
//
// THE LEGACY SET IS PRUNED, NOT REINTERPRETED.
//   An upgrading reader has an array of old row keys under this same storage key. Reading them all
//   back as tickers would file `RELIANCE|2026-08-12|3` as a company — a value that meant something
//   else, read as a measurement, which is the error this codebase is built to avoid. So the
//   migration keeps only entries SHAPED like an NSE symbol and drops the rest, once, recording that
//   it ran. A dropped entry was never a company; it was a row.

const STORAGE_KEY = 'sattva:watchlist';
const MIGRATED_KEY = 'sattva:watchlist:shape';

// NSE symbols may start with a digit (20MICRONS); BSE-only companies use six-digit codes.
// Composite row keys containing `|`, a space, a slash or a colon remain invalid.
const SYMBOL_RE = /^(?:(?=[A-Z0-9&._-]*[A-Z])[A-Z0-9][A-Z0-9&._-]{0,49}|\d{6})$/;

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

const normTicker = (t) => String(t ?? '').trim().toUpperCase();

function read() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return []; // private mode / storage disabled — the session still works, it just won't persist
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    // v2 entries are objects; the legacy shape is a bare string.
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
      name: typeof item === 'string' ? null : item?.name || null,
      addedAt: typeof item === 'string' ? null : item?.addedAt || null,
    });
  }
  return out;
}

function write(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(MIGRATED_KEY, '2');
  } catch {
    // Nothing to do: the toggle still works for this session.
  }
}

/**
 * Rewrite the stored array in the v2 shape once, dropping whatever could never have been a symbol.
 * Called on first read so an upgrading reader's star count matches what the app can actually show.
 */
function migrateOnce() {
  let done;
  try {
    done = localStorage.getItem(MIGRATED_KEY);
  } catch {
    return;
  }
  if (done === '2') return;
  write(read());
}
migrateOnce();

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

export function add(ticker, name = null) {
  const t = normTicker(ticker);
  if (!t || !SYMBOL_RE.test(t)) return false;
  const entries = read();
  const hit = entries.find((e) => e.ticker === t);
  if (hit) {
    // Re-starring an already-tracked company is not an event, but a NAME arriving for an entry that
    // had none is worth keeping — that is how a legacy entry acquires one.
    if (!hit.name && name) {
      hit.name = String(name);
      write(entries);
      emit();
    }
    return true;
  }
  entries.push({ ticker: t, name: name ? String(name) : null, addedAt: new Date().toISOString() });
  write(entries);
  emit();
  return true;
}

export function remove(ticker) {
  const t = normTicker(ticker);
  const entries = read();
  const next = entries.filter((e) => e.ticker !== t);
  if (next.length === entries.length) return false;
  write(next);
  emit();
  return true;
}

/** Star / unstar. Returns whether the company is tracked AFTER the toggle. */
export function toggle(ticker, name = null) {
  const t = normTicker(ticker);
  if (!t) return false;
  if (has(t)) {
    remove(t);
    return false;
  }
  return add(t, name);
}

export function size() {
  return read().length;
}

export function clear() {
  write([]);
  emit();
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Exported for the tests and for anything that needs to know what shape a symbol has. */
export const isSymbolShaped = (t) => SYMBOL_RE.test(normTicker(t));
