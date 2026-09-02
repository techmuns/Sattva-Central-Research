// Merge a new per-company filings walk with the previous committed snapshot.
//
// A universe walk is hundreds of independent requests. Treating its output as one indivisible
// object means one extra timeout can freeze every company on yesterday's data. The durable unit is
// the company: a fresh answer (including a fresh empty answer) wins; a company that failed or was
// not reached keeps its last-known-good answer; only a company with neither is unresolved.

const upper = (value) => String(value || '').trim().toUpperCase();

const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const strings = (value) => (Array.isArray(value) ? value.map(upper).filter(Boolean) : []);
const keyed = (value) => Object.fromEntries(Object.entries(object(value)).map(([key, item]) => [upper(key), item]).filter(([key]) => key));

/**
 * Return a new payload; neither input is mutated.
 *
 * `tickers` is the complete walk order. It matters when an expired credential stops a run early:
 * companies left in the queue appear in neither `byTicker`, `empty`, nor `failed`, but they still
 * need their previous answer carried forward.
 */
export function mergeLastGoodFilings(payload, previous, tickers = []) {
  if (!previous || typeof previous !== 'object') return payload;

  const next = structuredClone(payload);
  next.byTicker = keyed(next.byTicker);
  next.failed = keyed(next.failed);

  const previousRows = keyed(previous.byTicker);
  const previousFailed = keyed(previous.failed);
  const previousFallback = keyed(previous.fallback);
  const empty = new Set(strings(next.empty));
  const previousEmpty = new Set(strings(previous.empty));

  // Some upstreams encode a confirmed empty answer as `[]`; make that equivalent to the explicit
  // empty list. A malformed overlap is resolved in favour of rows, the most informative answer.
  for (const [ticker, rows] of Object.entries(next.byTicker)) {
    if (Array.isArray(rows) && rows.length) empty.delete(ticker);
    else if (Array.isArray(rows)) {
      delete next.byTicker[ticker];
      empty.add(ticker);
    } else {
      // A malformed row collection is not evidence that the company had no filings.
      delete next.byTicker[ticker];
      if (!next.failed[ticker]) {
        next.failed[ticker] = {
          reason: 'shape',
          message: 'The refresh returned an invalid row collection; it will be retried.',
        };
      }
    }
  }
  const universe = new Set([
    ...tickers.map((ticker) => upper(ticker?.ticker ?? ticker)),
    ...Object.keys(next.byTicker).map(upper),
    ...empty,
    ...Object.keys(next.failed).map(upper),
  ].filter(Boolean));

  const fallback = {};
  const fresh = new Set([...Object.keys(next.byTicker).map(upper), ...empty]);
  for (const ticker of fresh) delete next.failed[ticker];

  for (const ticker of universe) {
    if (fresh.has(ticker)) continue;

    const oldRows = previousRows[ticker];
    const hadEmptyAnswer = previousEmpty.has(ticker);
    if (!Array.isArray(oldRows) && !hadEmptyAnswer) {
      if (!next.failed[ticker]) {
        next.failed[ticker] = {
          reason: 'not-reached',
          message: 'The refresh ended before this company was reached; it will be retried.',
        };
      }
      continue;
    }

    const failure = next.failed[ticker];
    if (Array.isArray(oldRows) && oldRows.length) next.byTicker[ticker] = structuredClone(oldRows);
    else empty.add(ticker);
    delete next.failed[ticker];

    const olderFallback = previousFallback[ticker];
    fallback[ticker] = {
      capturedAt: olderFallback?.capturedAt || previous.capturedAt || null,
      reason: failure?.reason || previousFailed[ticker]?.reason || 'last-good',
    };
  }

  next.empty = [...empty].sort();
  next.fallback = fallback;
  next.fallbackCount = Object.keys(fallback).length;
  next.freshCovered = fresh.size;
  next.covered = Object.keys(next.byTicker).length + next.empty.length;
  next.withRows = Object.keys(next.byTicker).length;
  next.emptyCount = next.empty.length;
  next.failedCount = Object.keys(next.failed).length;
  next.rowCount = Object.values(next.byTicker).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  next.oldestDataAt = next.fallbackCount
    ? Object.values(fallback)
        .map((entry) => entry?.capturedAt)
        .filter(Boolean)
        .sort()[0] || previous.oldestDataAt || previous.capturedAt || null
    : next.capturedAt;
  return next;
}
