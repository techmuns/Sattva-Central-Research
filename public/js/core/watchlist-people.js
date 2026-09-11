// core/watchlist-people.js — WHO IS ADDING TO THE SHARED WATCHLIST.
//
//   people.roster()        [{ name, lastUsedAt, uses, origin }], most recently used first
//   people.me()            the name this device last added under, or null
//   people.setMe(name)     remember it, so the next add is a selection rather than typing
//   people.remember(name)  record a name locally AND make it this device's default
//   people.ingest(list)    merge the shared roster from a server snapshot
//   people.onChange(fn)
//
// WHY THE ROSTER IS SHARED AND `me` IS NOT.
//   The list of names everyone picks from has to be shared, or the dropdown on a new phone is
//   empty and the person retypes a name that is already on the list — which is the exact friction
//   this exists to remove, and it would quietly create "Ravi Kumar" beside "ravi kumar".
//
//   Which of those names is MINE is the opposite: it is a fact about this browser, not about the
//   desk. Storing it on the server would mean the last person to add anything anywhere became
//   everybody's default, so a colleague's phone would pre-select someone else's name and quietly
//   file their next add under it. So the roster travels and the default stays here.
//
// A LOCAL NAME IS `pending`, NOT `active`, AND THE DIFFERENCE IS THE SAME ONE THE X HANDLES DRAW.
//   A name typed while the shared list is unreachable is real and must appear in the dropdown at
//   once. It is not yet a name anybody else can see, and the roster says which is which rather than
//   showing them identically and being wrong about one of them until a sync happens.

import { personKey, personName, WATCHLIST_PEOPLE_LIMIT } from '../data/watchlist-shared.js';

const ROSTER_KEY = 'sattva:watchlist:people';
const ME_KEY = 'sattva:watchlist:me';

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function readLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROSTER_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // private mode — the dropdown still works for this session, it just will not persist
  }
}

function writeLocal(list) {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(list.slice(0, WATCHLIST_PEOPLE_LIMIT)));
  } catch {
    /* Nothing to do: the session keeps working without persistence. */
  }
}

// name -> { name, lastUsedAt, uses, origin }. Keyed by identity so one person cannot become two
// entries through capitalisation, which is the failure that makes a suggestion list useless.
let cache = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  for (const entry of readLocal()) {
    const key = personKey(entry?.name);
    const name = personName(entry?.name);
    if (!key || !name) continue;
    cache.set(key, {
      name,
      lastUsedAt: entry?.lastUsedAt || null,
      uses: Number.isFinite(entry?.uses) ? entry.uses : 1,
      origin: entry?.origin === 'shared' ? 'shared' : 'pending',
    });
  }
  return cache;
}

const sorted = () =>
  [...load().values()].sort(
    (a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')) || b.uses - a.uses || a.name.localeCompare(b.name),
  );

function persist() {
  writeLocal(sorted());
  emit();
}

/** Everyone who has added to this watchlist, most recently used first. */
export function roster() {
  return sorted();
}

/** The name this device adds under, or null the first time anybody uses it. */
export function me() {
  try {
    return personName(localStorage.getItem(ME_KEY));
  } catch {
    return null;
  }
}

export function setMe(name) {
  const clean = personName(name);
  try {
    if (clean) localStorage.setItem(ME_KEY, clean);
    else localStorage.removeItem(ME_KEY);
  } catch {
    /* The selection still applies to this session. */
  }
  emit();
  return clean;
}

/**
 * Record a name this device just used. It joins the dropdown immediately as `pending` — a name
 * nobody else can see yet — and becomes `shared` when a snapshot comes back carrying it.
 */
export function remember(name) {
  const key = personKey(name);
  const clean = personName(name);
  if (!key || !clean) return null;
  const entries = load();
  const existing = entries.get(key);
  entries.set(key, {
    name: clean,
    lastUsedAt: new Date().toISOString(),
    uses: (existing?.uses || 0) + 1,
    origin: existing?.origin === 'shared' ? 'shared' : 'pending',
  });
  persist();
  setMe(clean);
  return clean;
}

/**
 * Merge the roster the server holds.
 *
 * A shared entry WINS on spelling and on counts, because it is the desk's record rather than this
 * browser's. A local name the server has not seen is kept rather than deleted — it is either still
 * queued or was typed offline, and dropping it would take a name out of the dropdown that this
 * device is about to send.
 */
export function ingest(list) {
  if (!Array.isArray(list)) return; // absent is not empty: a failed read must not clear the roster
  const entries = load();
  const shared = new Set();
  for (const person of list) {
    const key = personKey(person?.name);
    const name = personName(person?.name);
    if (!key || !name) continue;
    shared.add(key);
    entries.set(key, {
      name,
      lastUsedAt: person?.lastUsedAt || entries.get(key)?.lastUsedAt || null,
      uses: Number.isFinite(person?.uses) ? person.uses : entries.get(key)?.uses || 1,
      origin: 'shared',
    });
  }
  // A name that was pending and is now in the shared roster has been accepted; one the server has
  // never seen stays pending rather than being promoted on the strength of an unrelated read.
  for (const [key, entry] of entries) if (!shared.has(key) && entry.origin === 'shared') entries.set(key, { ...entry, origin: 'pending' });
  persist();
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Cross-tab: another tab on this device recorded a name or changed who it is. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== ROSTER_KEY && event.key !== ME_KEY) return;
    cache = null;
    emit();
  });
}
