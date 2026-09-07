// Reuse the completed Yahoo bars the technicals capture already fetched.
// One capture supplies a consistent corporate-action adjustment basis; never
// splice historical adjusted prices from different adjustment vintages.
export function researchPriceHistory(bars, { sourceSymbol, capturedAt = new Date().toISOString() } = {}) {
  const seen = new Set();
  const rows = [];
  for (const bar of bars || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date || '') || !Number.isFinite(Date.parse(bar.date)) || new Date(bar.date).toISOString().slice(0, 10) !== bar.date) continue;
    if (!Number.isFinite(bar.adjustedClose) || bar.adjustedClose <= 0) continue;
    if (seen.has(bar.date)) return null;
    seen.add(bar.date);
    rows.push([bar.date, Math.round(bar.adjustedClose * 1e6) / 1e6]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const retained = rows.slice(-120);
  if (retained.length < 2) return null;
  return { basis: 'adjusted-close', source: 'Yahoo Finance daily adjusted close', sourceSymbol,
    capturedAt, from: retained[0][0], to: retained.at(-1)[0],
    retention: 'Latest 120 captured completed sessions; not an exhaustive price archive.', rows: retained };
}

export function retainedPriceHistory(history) {
  return history ? { ...history, retainedAfterFailure: true } : null;
}
