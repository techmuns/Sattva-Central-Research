// core/scope-lists.js — DEVICE-LOCAL UNIVERSE EDITS AND LEGACY PORTFOLIO MIGRATION.
//
// The committed files remain the defaults. A reader's edits are an overlay kept in localStorage:
// base entries can be removed, and companies found through the Muns search can be added. This is
// the same persistence boundary as the watchlist — personal to this browser, never written back to
// the repository and never sent to an upstream.
//
// Watchlist is deliberately not duplicated here. core/watchlist.js already owns that list and its
// legacy migration; the scope editor delegates to it directly.

const STORAGE_KEY = 'sattva:scope-lists:v1';
import * as watchlist from './watchlist.js';

const EDITABLE = new Set(['universe']);

const subscribers = new Set();
const emit = (scope) => subscribers.forEach((fn) => fn(scope));

const clean = (v) => String(v ?? '').trim();
const upper = (v) => clean(v).toUpperCase();
const nameKey = (v) => clean(v).toLowerCase().replace(/\s+/g, ' ');

export function keyFor(entry) {
  const ticker = upper(entry?.ticker);
  if (ticker) return `ticker:${ticker}`;
  const name = nameKey(entry?.name);
  return name ? `name:${name}` : '';
}

function normaliseEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ticker = upper(entry.ticker) || null;
  const name = clean(entry.name) || ticker;
  if (!name) return null;
  return {
    ticker,
    name,
    sector: clean(entry.sector || entry.industry) || null,
    industry: clean(entry.industry || entry.sector) || null,
    country: clean(entry.country) || null,
    listed: entry.listed !== false,
    addedAt: entry.addedAt || null,
    source: entry.source || null,
    isin: upper(entry.isin) || null,
    bseCode: clean(entry.bseCode) || null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.map(upper) : [],
    matchTickers: Array.isArray(entry.matchTickers) ? entry.matchTickers.map(upper) : [],
    exchanges: Array.isArray(entry.exchanges) ? entry.exchanges : [],
    status: entry.status || null,
  };
}

const emptyState = () => ({
  version: 1,
  portfolio: { added: [], removed: [] },
  universe: { added: [], removed: [] },
});

function read() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return emptyState();
  }
  const out = emptyState();
  for (const scope of ['portfolio', 'universe']) {
    const src = parsed?.[scope] || {};
    const seenAdded = new Set();
    const seenRemoved = new Set();
    for (const raw of Array.isArray(src.added) ? src.added : []) {
      const entry = normaliseEntry(raw);
      const key = keyFor(entry);
      if (!key || seenAdded.has(key)) continue;
      seenAdded.add(key);
      out[scope].added.push(entry);
    }
    for (const raw of Array.isArray(src.removed) ? src.removed : []) {
      const entry = normaliseEntry(raw);
      const key = keyFor(entry);
      if (!key || seenRemoved.has(key)) continue;
      seenRemoved.add(key);
      out[scope].removed.push(entry);
    }
  }
  return out;
}

function write(state, scope) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be disabled. The edit still fails closed rather than mutating committed data.
  }
  emit(scope);
}

function baseMap(base = []) {
  const map = new Map();
  for (const raw of base) {
    const entry = normaliseEntry(raw);
    const key = keyFor(entry);
    if (key && !map.has(key)) map.set(key, raw);
  }
  return map;
}

export function apply(scope, base = []) {
  if (!EDITABLE.has(scope)) return [...base];
  const state = read()[scope];
  const removed = new Set(state.removed.map(keyFor));
  const out = [];
  const seen = new Set();
  for (const raw of base) {
    const key = keyFor(raw);
    if (!key || removed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  for (const raw of state.added) {
    const key = keyFor(raw);
    if (!key || removed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

export function contains(scope, entry, base = []) {
  const key = keyFor(entry);
  return !!key && apply(scope, base).some((item) => keyFor(item) === key);
}

export function isRemoved(scope, entry) {
  if (!EDITABLE.has(scope)) return false;
  const key = keyFor(entry);
  return !!key && read()[scope].removed.some((item) => keyFor(item) === key);
}

export function removed(scope) {
  if (!EDITABLE.has(scope)) return [];
  return read()[scope].removed;
}

export function added(scope) {
  if (!EDITABLE.has(scope)) return [];
  return read()[scope].added;
}

export function add(scope, rawEntry, base = []) {
  if (!EDITABLE.has(scope)) return false;
  const entry = normaliseEntry(rawEntry);
  const key = keyFor(entry);
  if (!key) return false;

  const state = read();
  const list = state[scope];
  list.removed = list.removed.filter((item) => keyFor(item) !== key);
  const inBase = baseMap(base).has(key);
  const existing = list.added.find((item) => keyFor(item) === key);
  if (!inBase && !existing) {
    list.added.push({ ...entry, addedAt: new Date().toISOString(), source: entry.source || 'search' });
  } else if (existing && entry.name && existing.name !== entry.name) {
    Object.assign(existing, entry, { addedAt: existing.addedAt });
  }
  write(state, scope);
  return true;
}

export function remove(scope, rawEntry, base = []) {
  if (!EDITABLE.has(scope)) return false;
  const entry = normaliseEntry(rawEntry);
  const key = keyFor(entry);
  if (!key) return false;

  const state = read();
  const list = state[scope];
  const inBase = baseMap(base).has(key);
  list.added = list.added.filter((item) => keyFor(item) !== key);
  if (inBase && !list.removed.some((item) => keyFor(item) === key)) list.removed.push(entry);
  write(state, scope);
  return true;
}

export function reset(scope) {
  if (!EDITABLE.has(scope)) return false;
  const state = read();
  state[scope] = { added: [], removed: [] };
  write(state, scope);
  return true;
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const storageKey = () => STORAGE_KEY;

/** Preserve manual selections as Watchlist entries before retiring the old
 * overlay. Failed storage writes leave the legacy additions available to retry. */
export function migratePortfolioToWatchlist() {
  const state = read();
  const legacy = state.portfolio;
  for (const entry of legacy.added) {
    if (watchlist.isSymbolShaped(entry.ticker)) watchlist.add(entry.ticker, entry.name);
  }
  legacy.added = legacy.added.filter(entry => !watchlist.has(entry.ticker));
  legacy.removed = []; // A browser exclusion cannot sell a Family holding.
  write(state, 'portfolio');
}
