// Insider disclosures are events: a later response may omit an event we already captured.
// Share the same additive merge between the scheduled capture and the browser.

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};

/** Keep every distinct disclosure and the greatest observed count of identical rows.
 * Match all source fields, including Source, rather than guessing an identity from date/size.
 * `raw` repeats the cells and is stripped by the capture, so it is not part of the identity.
 * Unknown dates survive; only readable dates outside the requested window are removed.
 */
export function mergeInsiderTrades(previous = [], incoming = [], { from = null, to = null } = {}) {
  const inWindow = (row) => {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(row?.date || '')?.[0];
    return !date || ((!from || date >= from) && (!to || date <= to));
  };
  const identity = ({ raw, ...row }) => JSON.stringify(canonical(row));
  const rows = incoming.filter(inWindow);
  const counts = new Map();
  for (const row of rows) {
    const key = identity(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const row of previous.filter(inWindow)) {
    const key = identity(row);
    const remaining = counts.get(key) || 0;
    if (remaining) counts.set(key, remaining - 1);
    else rows.push(row);
  }
  return rows;
}

/** Keep the source's headings and order, appending columns supplied by other responses. */
export const mergeInsiderHeaders = (...lists) => [...new Set(lists.flat())];
