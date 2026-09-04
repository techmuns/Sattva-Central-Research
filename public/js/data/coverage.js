// data/coverage.js — WHAT THE FAMILY ACTUALLY OWNS, and what the Portfolio toggle means.
//
//   prime(payload)     seeded from portfolio-companies.json at bootstrap
//   baseHoldings()     the committed book, before this device's edits
//   holdings()         the committed book plus this device's additions/removals
//   tracked()          only the lines that carry an NSE ticker — what a feed can match
//   uncovered()        the lines no NSE-keyed feed can ever carry, each with its reason
//   meta()             counts, as-of date and provenance for the "N of 142" notes
//
// THE PUBLIC SNAPSHOT HOLDS names and sectors, synced from the family's own repository. No
// quantity, cost, valuation or P&L. The authenticated Family bridge may also supply ephemeral
// holding percentages for AI Alerts; these are never written to public assets or storage.
// There used to be a second
// file — `portfolio.json`, an ILLUSTRATIVE twelve-position ledger with invented quantities and
// costs — feeding a Portfolio Analytics workspace and an Ask Research evidence source. It is
// deleted (see js/ui/shell.js), so "Portfolio" now means exactly one thing here: this book, used
// to answer "is this one of mine?" in the research tabs.
//
// EVERY LINE IS KEPT, INCLUDING THE ONES NO FEED COVERS.
//   Nineteen of the 142 have no NSE symbol: unlisted private holdings, warrant lines, the Vedanta
//   demerger entities, four BSE-only companies and three whose symbol could not be found at all.
//   They are still owned. Dropping them would make "Portfolio" quietly mean "the 123 we happen to
//   have a feed for", and nothing on screen would say so. They travel with a `reason` instead, and
//   the tabs surface them as held-but-not-covered.

import * as scopeLists from '../core/scope-lists.js';

let raw = null;
let family = null;

/** Authenticated, per-question identities only. Never write these to storage or
 * mix device edits into what the active Family book says is owned. */
export function useFamilyBook(holdings, asOf) {
  if (!Array.isArray(holdings)) { family = null; return; }
  const known = new Map(baseHoldings().map((h) => [h.isin, h]));
  family = { asOf, holdings: holdings.map((h) => ({ ...h, ticker: h.ticker || known.get(h.isin)?.ticker || null })) };
}

export function prime(payload) {
  if (payload && Array.isArray(payload.holdings)) raw = payload;
  return isLoaded();
}

export const isLoaded = () => !!raw;

/**
 * The whole book, in the shape `forScope()` implementations already read: `{ ticker, name,
 * sector }`. Lines with no NSE symbol carry `ticker: null` — every filter here keys on ticker and
 * skips a null one, which is correct: they cannot match a feed. `uncovered()` is how they are
 * shown rather than lost.
 */
export const baseHoldings = () => (raw ? raw.holdings : []);

/** The book the reader asked to use on this device. The committed file remains the reset point. */
export const holdings = () => family ? family.holdings : scopeLists.apply('portfolio', baseHoldings());

/** The subset a feed can actually match. */
export const tracked = () => holdings().filter((h) => h.ticker);

/** The subset no NSE-keyed feed can carry, each with the reason it cannot. */
export const uncovered = () => holdings().filter((h) => !h.ticker);

/** Is this ticker one of ours? */
export function has(ticker) {
  if (!ticker) return false;
  const t = String(ticker).toUpperCase();
  return tracked().some((h) => h.ticker.toUpperCase() === t);
}

export function meta() {
  const current = holdings();
  const currentUncovered = current.filter((h) => !h.ticker);
  return {
    asOf: family?.asOf || raw?.asOf || null,
    source: family ? 'Active Sattva Family book' : raw?.source || null,
    count: current.length,
    tracked: current.length - currentUncovered.length,
    uncovered: currentUncovered.length,
    // The committed source's three reason buckets are only exact before a reader edits it. Once
    // edited, keep the honest total above and do not pretend the old split still describes it.
    unlisted: family || scopeLists.added('portfolio').length || scopeLists.removed('portfolio').length ? null : raw?.unlisted ?? 0,
    bseOnly: family || scopeLists.added('portfolio').length || scopeLists.removed('portfolio').length ? null : raw?.bseOnly ?? 0,
    unresolved: family || scopeLists.added('portfolio').length || scopeLists.removed('portfolio').length ? null : raw?.unresolved ?? 0,
  };
}

/**
 * One line for the tabs to print under a scoped table.
 *
 * The point of saying it everywhere is that a reader looking at a Portfolio-scoped view should
 * never have to wonder whether the count in front of them is the whole book. It never is: no feed
 * covers every holding, and the gap is named here rather than left to be discovered.
 */
export function coverageNote(shown, noun = 'holdings') {
  const m = meta();
  if (!m.count) return '';
  const parts = [`${shown} of ${m.count} book ${noun} on this feed`];
  if (m.uncovered) parts.push(`${m.uncovered} carry no NSE symbol and cannot appear on any feed here`);
  return parts.join(' · ');
}
