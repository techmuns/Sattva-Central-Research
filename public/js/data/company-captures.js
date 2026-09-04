import { conditionalJson, readEntry } from '../core/store.js';

let index = null, indexError = null, pending = null, checkedAt = 0;
export async function capturedJson(path) {
  const key = `capture:${path}`;
  const response = await conditionalJson(path, { key, optional: true, signal: AbortSignal.timeout(12000) });
  if (response.value) return { value: response.value, stale: false };
  const saved = await readEntry(key);
  if (saved?.value) return { value: saved.value, stale: true };
  throw new Error('Shared capture is unavailable. No empty result has been assumed.');
}
export async function loadCompanyCaptureIndex({ force = false } = {}) {
  if (pending) return pending;
  if (!force && checkedAt && Date.now() - checkedAt < 60000) return index;
  pending = (async () => {
    try {
      const result = await capturedJson('data/filing-capture/index.json');
      if (result.value?.version !== 1 || !result.value.sources) throw new Error('Shared capture has an unfamiliar format.');
      index = result.value;
      indexError = result.stale ? 'Showing a saved coverage report; the shared capture could not be checked.' : null;
    } catch (error) { indexError = error.message; }
    finally { checkedAt = Date.now(); pending = null; }
    return index;
  })();
  return pending;
}
export function companyCaptureStatus(kind, tickers = null, now = Date.now()) {
  const entries = index?.sources?.[kind] || {};
  const wanted = tickers ? [...new Set(tickers)] : (index?.companies || []).map((c) => c.ticker);
  const gaps = [], tally = { checked: 0, failed: 0, never: 0, stale: 0, backfill: 0, unregistered: 0, unavailableLinks: 0 };
  for (const ticker of wanted) {
    const entry = entries[ticker];
    let reason = null;
    if (!entry) { tally.unregistered++; reason = 'Not registered for automatic capture'; }
    else {
      tally.unavailableLinks += entry.unavailableLinks || 0;
      if (entry.error) { tally.failed++; reason = entry.error.message || 'Source read failed'; }
      else if (!entry.lastSuccessAt) { tally.never++; reason = 'Not checked yet'; }
      else if (now - Date.parse(kind === 'announcements' ? entry.recentCheckedAt || entry.lastSuccessAt : entry.lastSuccessAt) > 48 * 3600000) { tally.stale++; reason = 'Source check is overdue'; }
      else {
        tally.checked++;
        if (kind === 'announcements' && !entry.ranges?.some((r) => r.from <= index.requestedFrom && r.to >= index.requestedTo)) {
          tally.backfill++; reason = 'Historical date windows remain unchecked';
        }
      }
    }
    if (reason) gaps.push({ ticker, reason, lastSuccessAt: entry?.lastSuccessAt || null });
  }
  return { ...tally, total: wanted.length, gaps, available: !!index, error: indexError,
    from: index?.requestedFrom, to: index?.requestedTo, updatedAt: index?.updatedAt,
    unresolved: index?.unresolved || [], portfolio: index?.portfolio || null, registration: index?.registration || null, identitySources: index?.identitySources || {}, entries };
}
export async function capturedCompany(kind, ticker) {
  if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker)) throw new Error('Choose a valid company ticker.');
  const result = await capturedJson(`data/filing-capture/${kind}/${encodeURIComponent(ticker)}.json`);
  if (!Array.isArray(result.value?.rows)) throw new Error('Shared company history has an unfamiliar format.');
  return result;
}
