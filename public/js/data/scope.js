// data/scope.js — THE THREE SCOPES, IN ONE PLACE.
//
//   SCOPES              the ordered vocabulary: portfolio, watchlist, universe
//   isScope(v)          is this a scope id?
//   scopeLabel(v)       'Portfolio' | 'Watchlist' | 'Universe'
//   scopeTickers(scope, holdings)   the Set a feed filters by, or null for "everything"
//   scopeBook(scope)    { count, uncovered, noun } — the denominator a scoped view must print
//
// THE ORDER IS THE PRIORITY THE READER ASKED FOR: what you own, then what you are watching, then
// everything. Portfolio is the default because the first question on opening a dashboard about
// your own money is what your own money did.
//
// WHY THE FILTER IS A SET OF TICKERS AND NOT A PREDICATE
//   Every `forScope()` in `js/data/` was written as "if not portfolio, return everything", which
//   made a third scope a change in eight modules with eight chances to get it subtly different.
//   They now all ask this one function for the set and filter on it, so a fourth scope is a change
//   here. `null` means unfiltered, which is NOT the same as an empty Set: an empty Set is a real,
//   correct answer (nothing is watched yet) and must narrow the feed to nothing, while `null` is
//   "this scope does not narrow". Collapsing the two would make an empty watchlist show the whole
//   universe — a scope silently meaning its own opposite.

import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';

export const PORTFOLIO = 'portfolio';
export const WATCHLIST = 'watchlist';
export const UNIVERSE = 'universe';

export const SCOPES = [PORTFOLIO, WATCHLIST, UNIVERSE];

export const isScope = (v) => SCOPES.includes(v);

const LABELS = { [PORTFOLIO]: 'Portfolio', [WATCHLIST]: 'Watchlist', [UNIVERSE]: 'Universe' };
export const scopeLabel = (scope) => LABELS[scope] || LABELS[UNIVERSE];

/**
 * The tickers a scope narrows to, or `null` for the whole feed.
 *
 * `holdings` is passed by the callers that already hold the book (they take it as an argument so
 * the data modules stay free of a dependency on which list is "the" book); it defaults to
 * `coverage.holdings()`, which is the same list.
 */
export function scopeTickers(scope, holdings = null) {
  if (scope === PORTFOLIO) {
    const book = holdings || coverage.holdings();
    return new Set(book.filter((h) => h.ticker).map((h) => String(h.ticker).toUpperCase()));
  }
  if (scope === WATCHLIST) return watchlist.tickers();
  return null;
}

/**
 * A scope predicate for consumers that need Universe exclusions as well as narrowed-scope sets.
 * `scopeTickers('universe')` deliberately remains null for its long-standing "not narrowed"
 * contract; this predicate is the editable-list-aware form new code should use.
 */
export function scopeAllowsTicker(scope, ticker, holdings = null) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return false;
  const wanted = scopeTickers(scope, holdings);
  if (wanted) return wanted.has(t);
  return !scopeLists.isRemoved('universe', { ticker: t });
}

export function scopeMatcher(scope, holdings = null) {
  // A matcher belongs to one filtering pass. Build membership once, not once per row: the
  // retained alert pool has tens of thousands of rows and a 100+ company portfolio. Re-reading
  // storage or allocating that entire Set for every row stalls the browser during feed updates.
  // A new pass takes a fresh snapshot, so portfolio/watchlist edits still apply immediately.
  const wanted = scopeTickers(scope, holdings);
  const removed = wanted ? null : new Set(scopeLists.removed('universe').map(scopeLists.keyFor));
  return { has: (ticker) => {
    const t = String(ticker || '').trim().toUpperCase();
    return !!t && (wanted ? wanted.has(t) : !removed.has(`ticker:${t}`));
  } };
}

/**
 * Filter any ticker-bearing row set by a scope. The single implementation every `forScope()` uses.
 *
 * A row with no ticker cannot be matched, so it drops out of a narrowed scope — which is right,
 * and is why the two feeds carrying rows that legitimately have no ticker (public chatter's
 * unresolved half, market-wide news) keep those sections whole and SAY they are unscopable rather
 * than filtering them to nothing.
 */
export function filterByScope(rows, scope, holdings = null, tickerOf = (r) => r.ticker) {
  const wanted = scopeMatcher(scope, holdings);
  return rows.filter((r) => {
    const t = tickerOf(r);
    // A tickerless row cannot match a narrowed list, but it remains part of Universe: there is no
    // symbol by which the editor could exclude it, and dropping it would turn an edit feature into
    // a silent data-loss rule for unresolved fund holdings and chatter rows.
    return t ? wanted.has(t) : scope === UNIVERSE;
  });
}

/**
 * "your holdings" / "your watchlist companies" — the phrase an empty-state sentence needs.
 *
 * Returns null for Universe, which has no possessive: nothing there is yours in particular. Every
 * "nothing matched" message on a scoped tab is built from this rather than spelling the two out,
 * because the failure mode is a message that still says "none of your holdings" to a reader who is
 * looking at their watchlist — a sentence that is quietly about a different list.
 */
export function scopePossessive(scope) {
  if (scope === PORTFOLIO) return 'your holdings';
  if (scope === WATCHLIST) return 'your watchlist companies';
  return null;
}

/**
 * The denominator a scoped view has to print, per the rule in CLAUDE.md: ninety-six rows look
 * complete until you know the list is a hundred and forty-two.
 *
 * Returns null for Universe, which has no denominator to print — it IS the denominator.
 */
export function scopeBook(scope) {
  if (scope === PORTFOLIO) {
    const m = coverage.meta();
    return { count: m.count, uncovered: m.uncovered, noun: 'book companies', label: 'Portfolio' };
  }
  if (scope === WATCHLIST) {
    // A watchlist entry is a ticker the reader starred, so none of them is "uncovered" the way a
    // book line with no NSE symbol is: they came FROM a feed. The gap a watchlist view has to
    // report is the other one — companies watched that THIS feed does not carry — and that is the
    // `count` vs shown difference the pill already prints.
    return { count: watchlist.size(), uncovered: 0, noun: 'watched companies', label: 'Watchlist' };
  }
  return null;
}
