// core/twitter-handles.js — THE LIST OF X/TWITTER ACCOUNTS WHOSE POSTS JOIN THE NEWS FEED.
//
//   handles.load()            read the committed list once
//   handles.all()             every monitored handle, with its status
//   handles.add(raw)          '@Reuters' | 'Reuters' | 'https://x.com/Reuters' -> one entry
//   handles.remove(handle)    stop monitoring it
//   handles.onChange(fn)
//
// TWO LISTS, ONE ANSWER — the same arrangement as core/scope-lists.js.
//   `public/data/twitter-handles.json` is committed and is what the ingestion job reads. A reader's
//   edits are a DEVICE-LOCAL overlay in localStorage on top of it, so adding a handle takes effect
//   on this screen immediately and survives a reload, and removing a committed one hides it here
//   without rewriting a file in the repository.
//
// WHICH MAKES "ADDED" AND "ACTIVE" DIFFERENT CLAIMS, AND THE UI MUST NOT MERGE THEM. A handle the
// reader has just added is monitored by THIS BROWSER; it is being ingested only once the job has
// picked it up and committed a capture that names it. Until then its status is `adding` and it says
// so — the same rule the filings tabs follow with "63 companies have not been checked since". A
// handle nobody could resolve comes back as `not-found` from the capture, which is a fact the job
// established rather than a guess made here.
//
// NORMALISATION IS THE WHOLE OF THE INPUT VALIDATION, and it is deliberately strict: X's own rule
// is 1-15 characters of [A-Za-z0-9_]. Anything else is refused with a reason rather than sent on,
// because this value reaches a workflow input — see the note on `/api/twitter/refresh` in
// worker/index.js. Handles are case-insensitive upstream, so `key` is the lower-cased form and is
// what dedupes; `handle` keeps the casing the reader typed, which is how the account displays.

import { revalidatedJson } from './store.js';

const STORAGE_KEY = 'sattva:twitter-handles:v1';
const COMMITTED = 'data/twitter-handles.json';

/** X's own rule. Kept here so the browser, the Worker and the scraper cannot disagree about it. */
export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

let committed = null; // { handles: [{ handle, addedAt }], capturedAt }
let loading = null;

/**
 * `@Reuters`, `Reuters`, `https://x.com/Reuters?s=20`, `twitter.com/Reuters/` -> `Reuters`.
 *
 * Returns `{ handle, key }`, or `{ error }` naming what was wrong in words a reader can act on.
 * A URL for some other host is refused rather than having its last path segment taken: `.../news`
 * off any site would otherwise "normalise" to a plausible-looking handle that is not one.
 */
export function normaliseHandle(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return { error: 'Enter a handle.' };

  if (/^(https?:)?\/\//i.test(value) || /^(www\.)?(x|twitter)\.com\//i.test(value)) {
    const m = /^(?:https?:)?\/\/?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(value) || /^(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i.exec(value);
    if (!m) return { error: 'That link is not an X profile address.' };
    value = m[1];
  }

  value = value.replace(/^@+/, '').replace(/[/?#].*$/, '').trim();
  if (!value) return { error: 'Enter a handle.' };
  if (!HANDLE_RE.test(value)) {
    return { error: 'A handle is 1–15 letters, numbers or underscores.' };
  }
  return { handle: value, key: value.toLowerCase() };
}

// ---- The device-local overlay ---------------------------------------------------------------

const emptyOverlay = () => ({ version: 1, added: [], removed: [] });

function readOverlay() {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return emptyOverlay();
  }
  const out = emptyOverlay();
  if (Array.isArray(parsed?.added)) {
    for (const e of parsed.added) {
      const n = normaliseHandle(e?.handle);
      if (n.handle && !out.added.some((x) => x.key === n.key)) out.added.push({ ...n, addedAt: e?.addedAt || null });
    }
  }
  if (Array.isArray(parsed?.removed)) {
    for (const k of parsed.removed) {
      const n = normaliseHandle(k);
      if (n.key && !out.removed.includes(n.key)) out.removed.push(n.key);
    }
  }
  return out;
}

function writeOverlay(next) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A private window with storage disabled still gets a working list for this session — the same
    // fallback core/store.js makes. It is not an error state and must not be reported as one.
  }
  emit();
}

// ---- The committed list ----------------------------------------------------------------------

export function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      committed = (await revalidatedJson(COMMITTED)) || {};
    } catch {
      // A deployment that has never run the job has no file. That is "nothing is monitored yet",
      // not a failure, and the overlay still works.
      committed = {};
    }
    emit();
    return committed;
  })();
  return loading;
}

export const isLoaded = () => committed !== null;

/** The handles the committed file names — what the ingestion job is actually reading. */
function committedEntries() {
  const list = Array.isArray(committed?.handles) ? committed.handles : [];
  const out = [];
  for (const e of list) {
    const n = normaliseHandle(typeof e === 'string' ? e : e?.handle);
    if (n.handle && !out.some((x) => x.key === n.key)) {
      out.push({ ...n, addedAt: (typeof e === 'object' && e?.addedAt) || null, committed: true });
    }
  }
  return out;
}

/**
 * Every monitored handle, committed and local, in one list.
 *
 * `status` is derived, never stored: `active` once a collection run has actually read the account,
 * `adding` while it is monitored and nothing has read it, `not-found` only for an explicit
 * missing-account reason, and `unreadable` for a request that could not establish that.
 *
 * `collected` IS WHAT SEPARATES THE FIRST TWO, AND BEING IN THE COMMITTED FILE IS NOT ENOUGH.
 * A dispatch may name a handle, and the collector writes it to the list BEFORE it tries to read
 * it — so a run that added the handle and then failed to sign in leaves it in the committed file
 * having never been read. Reading that as `active` is the same overclaim as a green Live pill over
 * data nobody confirmed. So the caller passes whether any capture exists at all (data/twitter-news
 * .js owns that: `capturedAt`), and with none, every handle is `adding`, which is exactly true.
 *
 * `postCount` is supplied by the caller for the same reason — that module owns the posts, and this
 * one stays about the list alone.
 */
export function all({ failed = new Map(), collected = true } = {}) {
  const overlay = readOverlay();
  const removed = new Set(overlay.removed);
  const seen = new Map();
  const failureStatus = (key) => failed.get(key) === 'account not found' ? 'not-found' : 'unreadable';

  for (const e of committedEntries()) {
    if (removed.has(e.key)) continue;
    const status = failed.has(e.key) ? failureStatus(e.key) : collected ? 'active' : 'adding';
    seen.set(e.key, { ...e, status, reason: failed.get(e.key) || null });
  }
  for (const e of overlay.added) {
    if (removed.has(e.key) || seen.has(e.key)) continue;
    seen.set(e.key, { ...e, committed: false, status: failed.has(e.key) ? failureStatus(e.key) : 'adding', reason: failed.get(e.key) || null });
  }
  return [...seen.values()].sort((a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase()));
}

export const has = (raw) => {
  const n = normaliseHandle(raw);
  return !!n.key && all().some((e) => e.key === n.key);
};

/** The keys the news feed should show posts for — a removed handle stops appearing at once. */
export const activeKeys = () => new Set(all().map((e) => e.key));

/**
 * Add one. Returns `{ handle }`, or `{ error }` — including for a duplicate, which is not silently
 * swallowed: a reader who pastes `x.com/Reuters` over an existing `@Reuters` is owed the reason the
 * list did not grow.
 */
export function add(raw) {
  const n = normaliseHandle(raw);
  if (n.error) return { error: n.error };
  const overlay = readOverlay();
  const wasRemoved = overlay.removed.includes(n.key);
  if (!wasRemoved && all().some((e) => e.key === n.key)) return { error: `@${n.handle} is already on the list.` };

  overlay.removed = overlay.removed.filter((k) => k !== n.key);
  // A handle the committed file already names needs no local copy — undoing its removal is enough.
  if (!committedEntries().some((e) => e.key === n.key) && !overlay.added.some((e) => e.key === n.key)) {
    overlay.added.push({ handle: n.handle, key: n.key, addedAt: new Date().toISOString() });
  }
  writeOverlay(overlay);
  return { handle: n.handle, key: n.key };
}

export function remove(raw) {
  const n = normaliseHandle(raw);
  if (!n.key) return { error: n.error || 'Not a handle.' };
  const overlay = readOverlay();
  overlay.added = overlay.added.filter((e) => e.key !== n.key);
  if (committedEntries().some((e) => e.key === n.key) && !overlay.removed.includes(n.key)) overlay.removed.push(n.key);
  writeOverlay(overlay);
  return { handle: n.handle };
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const meta = () => ({
  loaded: committed !== null,
  capturedAt: committed?.capturedAt || null,
  committedCount: committedEntries().length,
  total: all().length,
});

/** Test seam, matching every other module here. */
export function invalidate() {
  committed = null;
  loading = null;
}

export const storageKey = () => STORAGE_KEY;
