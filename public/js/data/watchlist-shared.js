// data/watchlist-shared.js — THE ONE DEFINITION OF WHAT A SHARED WATCHLIST RECORD IS.
//
// Pure and dependency-free, so `worker/watchlist-store.mjs` imports the identical rules the
// browser applies. Same arrangement, and the same reason, as `finology-shared.js` and
// `stockscans-shared.js`: the edge and the page must not be able to drift about what a company
// is, who a contributor is, or which of two conflicting edits happened last.
//
// WHY THE WATCHLIST BECAME SHARED
//   It was `localStorage`, so it was a list per BROWSER. Two people at one desk kept two different
//   watchlists and neither could see what the other had added; the same person on a phone saw a
//   third. A list that exists to answer "which companies is this desk tracking" cannot be device
//   local — every device held a partial answer and none of them said so.
//
//   So the shared list is the truth and the device keeps a copy of it. The copy is what paints
//   when the network is unreachable, and it never pretends to be the shared list: see `meta()` in
//   `core/watchlist.js`, which reports `live` / `store` / `pending` rather than one "connected".
//
// WHY AN EDIT IS AN INTENT AND NOT A LIST
//   The obvious wire shape is "PUT the whole array". It silently deletes: a device that loaded the
//   list an hour ago and stars one company would PUT its stale array over everything anyone else
//   added since, and nothing anywhere would report a loss. So a device sends what it DID — add
//   this ticker, remove that one — and the server applies it to whatever the list is now. A
//   concurrent add by somebody else survives an unrelated remove because they touch different
//   rows, which is the whole property a shared list needs and a whole-list write cannot have.

// NSE symbols may start with a digit (20MICRONS); BSE-only companies use six-digit codes.
// Composite row keys containing `|`, a space, a slash or a colon remain invalid — the star marks a
// COMPANY, and a row id filed as one would match nothing for ever.
export const SYMBOL_RE = /^(?:(?=[A-Z0-9&._-]*[A-Z])[A-Z0-9][A-Z0-9&._-]{0,49}|\d{6})$/;

// Bounds. A shared list is small by nature — this is a working set for a desk, not a database —
// and every one of these is a ceiling on what one request may cost, never an editorial judgement.
export const WATCHLIST_COMPANY_LIMIT = 600;
export const WATCHLIST_PEOPLE_LIMIT = 200;
export const WATCHLIST_INTENT_BATCH = 50;
export const WATCHLIST_TOMBSTONE_LIMIT = 400;
export const WATCHLIST_REQUEST_BYTES = 16384;
export const WATCHLIST_NAME_MAX = 200;
export const WATCHLIST_PERSON_MAX = 60;

// Control characters are stripped by code point rather than by a regex literal, so this file
// carries none of them itself. A name arriving over the network is somebody else's text.
const printable = (value) =>
  String(value ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('');

export const normTicker = (value) => String(value ?? '').trim().toUpperCase();
export const isSymbolShaped = (value) => SYMBOL_RE.test(normTicker(value));

/** A display name for a company, or null. Never the ticker — printing a symbol where a name
 *  belongs would be inventing one, which is the error this codebase is built to avoid. */
export function companyName(value) {
  const name = printable(value).replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, WATCHLIST_NAME_MAX) : null;
}

/**
 * A contributor's name as they typed it — trimmed, control characters removed, length bounded.
 * Returns null for anything that is not a name, so a blank box can never be filed as a person.
 */
export function personName(value) {
  const name = printable(value).replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, WATCHLIST_PERSON_MAX) : null;
}

/**
 * The identity behind a typed name. Case and spacing are how one person becomes two entries in a
 * dropdown that exists to stop them retyping it, so "Ravi Kumar", "ravi kumar" and "Ravi  Kumar"
 * are one person. The DISPLAY name stays as typed — the key decides who, the name decides what
 * everyone reads.
 */
export function personKey(value) {
  const name = personName(value);
  if (!name) return null;
  const folded = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
  return folded || name.toLowerCase();
}

/**
 * One edit, validated. Throws rather than silently dropping a field the caller meant to send.
 *
 * THREE OPERATIONS, AND `seed` IS THE ONE THAT EARNS ITS KEEP.
 *   `add` and `remove` are somebody's deliberate edit and must say who made it. `seed` is the
 *   companies a device was already watching before the list was shared at all — real entries, with
 *   nobody's name attached, because nothing ever recorded one. Filing them under whoever happens to
 *   be at the keyboard would credit them with work they did not do, and inventing a person is worse
 *   than admitting the record is missing. So `seed` carries no contributor, never joins the roster,
 *   and reads as "carried over · contributor not recorded" rather than as anybody's add.
 */
export function watchlistIntent(input) {
  const op = String(input?.op ?? '');
  if (!['add', 'remove', 'seed'].includes(op)) throw new Error('Invalid watchlist operation');
  const ticker = normTicker(input?.ticker);
  if (!SYMBOL_RE.test(ticker)) throw new Error('Invalid watchlist company');
  const name = companyName(input?.name);
  if (op === 'seed') return { op, ticker, name, by: null, byKey: null };
  const by = personName(input?.by);
  // ADDING IS THE ACT THE DESK ASKED TO HAVE A NAME ON, so `add` refuses without one: that rule is
  // enforced here rather than in the UI, where a second entry point could quietly skip it.
  // REMOVING MAY BE UNATTRIBUTED, and the difference is not an oversight. A remove reaches the
  // contract from paths that genuinely have nobody to name — a legacy call site, a scope-list
  // migration — and the choice there is between recording the removal with no name and inventing
  // one. An invented name is the worse answer every time, so `removedBy` is simply allowed to be
  // null and every surface reads it as "not recorded" rather than as somebody.
  if (op === 'add' && !by) throw new Error('Invalid watchlist contributor');
  return { op, ticker, name, by: by || null, byKey: by ? personKey(by) : null };
}

/** Validate a whole batch, rejecting one that is empty, oversized or self-contradictory. */
export function watchlistIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > WATCHLIST_INTENT_BATCH) throw new Error('Invalid watchlist batch');
  const intents = input.map(watchlistIntent);
  const seen = new Set();
  for (const intent of intents) {
    // Two edits to one company in one batch cannot be ordered by anything the wire carries, so the
    // batch is refused rather than resolved by arrival order — the caller knows which it meant.
    if (seen.has(intent.ticker)) throw new Error('Duplicate company in watchlist batch');
    seen.add(intent.ticker);
  }
  return intents;
}

/**
 * Reader-facing shape of one watched company.
 *
 * `addedBy` is null for a seeded row and the view says so in words. A null here means "nothing ever
 * recorded who", which is a different claim from "nobody" and must never be printed as a name.
 */
export function watchlistEntry(row) {
  return {
    ticker: normTicker(row?.ticker),
    name: companyName(row?.name),
    addedAt: row?.addedAt || null,
    addedBy: personName(row?.addedBy),
  };
}

/** How a row's origin reads to a human. Kept here so the editor and any export cannot disagree. */
export function attributionLabel(entry) {
  const by = personName(entry?.addedBy);
  if (by) return `Added by ${by}`;
  return 'Added before names were recorded';
}

/**
 * Is a snapshot newer than the one already held?
 *
 * `revision` is the server's own counter, so this orders two readings of the SAME shared list
 * without trusting any device's clock. An unnumbered snapshot cannot be ordered and is taken as
 * given, exactly as `isNewerThanHeld` refuses to rank an unstamped capture elsewhere.
 */
export function isNewerWatchlist(incoming, held) {
  if (!Number.isFinite(incoming?.revision) || !Number.isFinite(held?.revision)) return true;
  return incoming.revision >= held.revision;
}
