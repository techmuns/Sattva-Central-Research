// data/coverage.js — WHAT THE FAMILY ACTUALLY OWNS, and what the Portfolio toggle means.
//
//   prime(payload)     seeded from portfolio-companies.json at bootstrap
//   baseHoldings()     the latest names-only Family snapshot
//   holdings()         the authenticated Family book, or its labelled saved snapshot
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
// EVERY LINE IS KEPT, INCLUDING THE ONES MOST FEEDS CANNOT COVER.
//   Some holdings have no NSE symbol: unlisted private holdings, warrant lines, demerged entities,
//   BSE-only companies and names whose symbol could not be resolved. They are still owned. Dropping
//   them would make "Portfolio" quietly mean "the names we happen to have a ticker feed for". They
//   travel with a `reason`; ticker-keyed tabs surface them as held-but-not-covered, while company
//   News searches their stable ISIN identity by legal name.

import { readEntry, writeEntry } from '../core/store.js';
import { boundedJson, validateResolvedPortfolio, assertBookChange, assertRecentCheck } from './family-book-contract.js';

let raw = null;
let syncStatus = 'snapshot';
let syncError = null;
let pending = null;
let controller = null;
let generation = 0;
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const CACHE_KEY = 'family-portfolio:active:v1';

function validPortfolio(p) {
  try { validateResolvedPortfolio(p, { fresh: false }); return true; } catch { return false; }
}

const notify = changed => {
  // A tab repaint error must not stop the sync or leave its promise stuck.
  for (const fn of listeners) { try { fn({ changed }); } catch (error) { console.error('Portfolio repaint failed', error); } }
};

/** Resume/offline events revoke the old success immediately, before any I/O. */
export function invalidate(reason = null) {
  generation++;
  controller?.abort();
  controller = null;
  pending = null;
  syncStatus = reason ? 'unavailable' : 'snapshot';
  syncError = reason;
  notify(false);
}

function currentStatus() {
  if (syncStatus !== 'live') return syncStatus;
  try { assertRecentCheck(raw?.syncedAt); return 'live'; } catch { return 'stale'; }
}

export async function restoreLastGood() {
  const cached = await readEntry(CACHE_KEY);
  // A newly deployed fallback may be newer than this device's last successful
  // check. Never roll it back merely because an older browser cache exists.
  const currentCheck = Date.parse(raw?.syncedAt);
  if (validPortfolio(cached?.value) &&
      (!Number.isFinite(currentCheck) || Date.parse(cached.value.syncedAt) > currentCheck)) {
    try { assertBookChange(cached.value, raw); raw = cached.value; } catch { /* keep the newer known source */ }
  }
  // Restored data is a snapshot, never a successful check in this session.
  syncStatus = 'snapshot';
  syncError = null;
}

export function refresh() {
  if (pending) return pending;
  const startedGeneration = generation;
  controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
  const operation = (async () => {
    const before = identitySignature(holdings());
    try {
      const response = await fetch('/api/family-portfolio', { cache: 'no-store', signal });
      const payload = await boundedJson(response, 2 * 1024 * 1024);
      validateResolvedPortfolio(payload);
      assertBookChange(payload, raw);
      if (startedGeneration !== generation) return { cancelled: true };
      raw = payload;
      syncStatus = 'live';
      syncError = null;
      void writeEntry(CACHE_KEY, { value: payload, tag: payload.sourceRevision });
    } catch {
      if (startedGeneration !== generation) return { cancelled: true };
      syncStatus = 'unavailable';
      syncError = 'Family Office sync unavailable — showing the last saved portfolio, which may be out of date.';
    }
    const changed = before !== identitySignature(holdings());
    notify(changed);
    return { added: changed ? 1 : 0, checked: raw?.holdings?.length || 0, ...(syncError ? { error: syncError } : {}) };
  })().finally(() => { if (startedGeneration === generation) { pending = null; controller = null; } });
  pending = operation;
  return pending;
}

export function syncLabel() {
  if (family?.error) return 'Family Office is temporarily unavailable — showing the last verified holdings. Refresh to try again.';
  if (family) return family.checking ? 'Checking Family Office for changes — showing the last verified holdings.' : 'Using holdings supplied by the authenticated Family Office session. These private session identities are not saved to the public portfolio snapshot.';
  const checked = raw?.syncedAt ? new Date(raw.syncedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'unknown';
  const source = `Workbook: ${raw?.sourceWorkbook?.label || 'saved baseline'} · stated period end: ${raw?.asOf || 'unknown'} · last successful check: ${checked} IST`;
  const periodDays = Math.floor((Date.now() - Date.parse(raw?.asOf)) / 86400000);
  const periodAge = !Number.isFinite(periodDays) ? ' · workbook period is unknown' : periodDays < 0
    ? ' · stated period end is in the future; it does not verify holdings as of today'
    : ` · ${periodDays} day(s) since the stated period end; later trades need a workbook update`;
  const status = currentStatus();
  const lead = syncError || (status === 'stale' ? 'Portfolio check expired — showing saved holdings, which may be out of date.' :
    status !== 'live' ? 'Portfolio is a saved snapshot — checking Family Office…' : 'Family Office connection checked.');
  return `${lead} ${source}${periodAge} · Holdings are workbook-based, not live broker trades.`;
}
let family = null;

const identitySignature = entries => JSON.stringify(entries.map(h => [h.isin, h.ticker, h.name, h.sector]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/** One in-memory Family book for every view. Only membership/identity changes
 * require re-filtering feeds; a quote refresh must not tear down an answer. */
export function useFamilyBook(entries, asOf, checkedAt = null) {
  const before = identitySignature(holdings());
  if (!Array.isArray(entries)) family = null;
  else {
    const known = new Map(baseHoldings().map(h => [h.isin, h]));
    family = { asOf, checkedAt, holdings: entries.map(h => ({ ...h, ticker: h.ticker || known.get(h.isin)?.ticker || null })) };
  }
  notify(before !== identitySignature(holdings()));
}

/** Keep the last verified identity set visible during revalidation. A routine
 * check must not briefly swap the current book for an older public fallback. */
export function invalidateFamilyBook() {
  if (family) { family.checking = true; notify(false); }
}

/** A transport/read failure changes freshness, not ownership. Explicit sign-out
 * still clears the private session via useFamilyBook(null). */
export function failFamilyBook() {
  if (family) { family.checking = false; family.error = true; notify(false); }
}

export function prime(payload) {
  invalidate();
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

/** Family Office alone controls ownership. Watchlist holds personal selections. */
export const holdings = () => family ? family.holdings : baseHoldings();

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
    sourceWorkbook: family ? null : raw?.sourceWorkbook || null,
    syncedAt: family ? family.checkedAt : raw?.syncedAt || null,
    syncStatus: family ? (family.error ? 'family-unavailable' : family.checking ? 'family-checking' : 'family-session') : currentStatus(),
    syncError,
    manualEdits: 0,
    count: current.length,
    tracked: current.length - currentUncovered.length,
    uncovered: currentUncovered.length,
    // Detailed reason buckets belong to the names-only export.
    unlisted: family ? null : raw?.unlisted ?? 0,
    bseOnly: family ? null : raw?.bseOnly ?? 0,
    unresolved: family ? null : raw?.unresolved ?? 0,
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
