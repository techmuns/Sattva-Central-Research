// Captured history is additive. Absence from NSE's latest RSS window is not a deletion.
export const HISTORY_DAYS = [7, 30, 90];
const DAY_MS = 86400000;
const IST_MS = 19800000;

export function filingDay(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time + IST_MS).toISOString().slice(0, 10) : null;
}

export function firstHistoryDay(days, now = Date.now()) {
  return new Date(now + IST_MS - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

// Company, not ticker: resolving an unlinked notice later must not give it a second identity.
export const filingKey = (row) => row.url || `${row.company}|${row.publishedAt || ''}|${row.subject || ''}`;

// Observation time is not filing time. Preserve it across browser reloads and archived revisions.
export function capturedRows(payload) {
  return (Array.isArray(payload?.rows) ? payload.rows : []).filter(Boolean)
    .map((row) => ({ ...row, observedAt: row.observedAt || payload.capturedAt || null }));
}

export function mergeFilings(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || typeof row.company !== 'string' || !row.company.trim()) continue;
      const key = filingKey(row);
      const previous = byId.get(key);
      const older = (Date.parse(row.observedAt || '') || 0) < (Date.parse(previous?.observedAt || '') || 0);
      const preferred = older ? previous : row;
      const other = older ? row : previous;
      const merged = { ...other, ...preferred };
      // A poorer resolver response must not erase an already-known identity.
      if (!preferred.ticker && other?.ticker) {
        merged.ticker = other.ticker;
        merged.resolvedBy = other.resolvedBy;
      }
      byId.set(key, merged);
    }
  }
  return [...byId.values()].sort((a, b) =>
    (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0) ||
    a.company.localeCompare(b.company) || filingKey(a).localeCompare(filingKey(b)));
}

export function inHistoryRange(row, from) {
  const day = filingDay(row.publishedAt);
  // Keep undated notices visible, without pretending they happened today.
  return !day || day >= from;
}
