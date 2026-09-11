// data/row-ticker-index.js — "does this feed hold any row for this company?", asked cheaply.
//
// WHY THIS EXISTS: `wasAskedEmpty(ticker)` is asked once per company in scope, and every
// implementation of it answered by scanning the whole retained row set — `rows().some(row =>
// String(row.ticker || row.entityId || '').toUpperCase() === ticker.toUpperCase())`. That is
// O(companies x rows) with two string allocations per row, over feeds that retain tens of
// thousands of rows. Measured at 4x CPU throttle on one warm tab switch, with no network at all:
// 1,033ms in news-history, 734ms in tradingview-news and 581ms in portfolio-publisher-news —
// 2.3 seconds of a reader's wait spent re-deriving a set that had not changed.
//
// THE CACHE KEY IS THE ROW ARRAY ITSELF, which is what makes this safe to drop into a hot path.
// Every one of these feeds already memoises `rows()` and returns a NEW array whenever anything
// changes, so a changed feed is a different object and misses. There is no invalidation rule for
// a future change to forget, and no way for the index to outlive or disagree with the rows it
// describes — a WeakMap entry dies with the array.
//
// It answers "is there a row filed under this company", which is emphatically NOT "was this
// company checked and found empty". The callers keep that distinction: each still consults its own
// base feed's record of what was actually asked. Narrowing this helper to the membership question
// is deliberate — an absence here is our bookkeeping, never a statement about the upstream.
const indexes = new WeakMap();

/** The uppercased set of company keys the given rows carry. Built once per row-set identity. */
export function tickerIndex(rows) {
  if (!Array.isArray(rows)) return new Set();
  const hit = indexes.get(rows);
  if (hit) return hit;
  const set = new Set();
  // Exactly the key the callers' own scans built — `String(row.ticker || row.entityId || '')`
  // uppercased, INCLUDING the empty string for a row carrying neither. Dropping that case would
  // make `holdsTicker(rows, '')` answer differently from the loop it replaces, and a predicate
  // that is "the same except for an input nobody passes" is the kind of assumption that quietly
  // stops being true. Same set in, same answer out.
  for (const row of rows) set.add(String(row?.ticker || row?.entityId || '').toUpperCase());
  indexes.set(rows, set);
  return set;
}

/**
 * True when `rows` carries at least one row filed under `ticker`.
 *
 * `String(ticker)` rather than `String(ticker ?? '')` on purpose: the scans this replaces wrote
 * `String(ticker).toUpperCase()`, so a null lookup asked for the literal "NULL" and matched
 * nothing. Normalising it to '' here would instead match rows carrying no company at all — a
 * behaviour change smuggled in under a performance fix. Faithful beats tidy.
 */
export function holdsTicker(rows, ticker) {
  return tickerIndex(rows).has(String(ticker).toUpperCase());
}
