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
const verifiedBseCode = (value) => /^\d{6}$/.test(String(value || '')) ? String(value) : null;

export function companyCaptureStatusFromIndex(captureIndex, kind, tickers = null, now = Date.now(), error = null) {
  const entries = captureIndex?.sources?.[kind] || {};
  const wanted = tickers ? [...new Set(tickers)] : (captureIndex?.companies || []).map((c) => c.ticker);
  const companies = new Map((captureIndex?.companies || []).map((company) => [company.ticker, company]));
  const authenticatedOutage = kind === 'announcements' && captureIndex?.sourceOutages?.authenticatedAnnouncements;
  const gaps = [], tally = { checked: 0, failed: 0, never: 0, stale: 0, backfill: 0, unregistered: 0, unavailableLinks: 0 };
  const bse = { checked: 0, failed: 0, never: 0, stale: 0, backfill: 0, total: 0, unavailableLinks: 0, gaps: [] };
  for (const ticker of wanted) {
    const entry = entries[ticker];
    let reason = null;
    if (!entry) { tally.unregistered++; reason = 'Not registered for automatic capture'; }
    else {
      tally.unavailableLinks += entry.unavailableLinks || 0;
      if (authenticatedOutage) { tally.failed++; reason = 'Authenticated announcement source is unavailable'; }
      else if (entry.error) { tally.failed++; reason = entry.error.message || 'Source read failed'; }
      else if (!entry.lastSuccessAt) { tally.never++; reason = 'Not checked yet'; }
      else {
        const successAt = Date.parse(entry.lastSuccessAt);
        const checkedAt = Date.parse(kind === 'announcements' ? entry.recentCheckedAt || entry.lastSuccessAt : entry.lastSuccessAt);
        if (!Number.isFinite(successAt) || successAt > now + 600000 || !Number.isFinite(checkedAt) || checkedAt > now + 600000 || now - checkedAt > 48 * 3600000) {
          tally.stale++;
          reason = Number.isFinite(successAt) && successAt <= now + 600000 && Number.isFinite(checkedAt) && checkedAt <= now + 600000
            ? 'Source check is overdue' : 'Source check time is invalid';
        } else {
          tally.checked++;
          if (kind === 'announcements' && !entry.ranges?.some((r) => r.from <= captureIndex.requestedFrom && r.to >= captureIndex.requestedTo)) {
            tally.backfill++; reason = 'Historical date windows remain unchecked';
          }
        }
      }
    }
    if (reason) gaps.push({ ticker, reason, lastSuccessAt: entry?.lastSuccessAt || null });

    if (kind !== 'announcements') continue;
    const companyCode = verifiedBseCode(companies.get(ticker)?.bseCode);
    const capturedCode = verifiedBseCode(entry?.bse?.bseCode);
    const bseCode = companyCode || capturedCode;
    if (!bseCode) continue;
    bse.total++;
    const source = entry?.bse;
    let bseReason = null;
    bse.unavailableLinks += Number(source?.unavailableLinks) || 0;
    if (companyCode && capturedCode && companyCode !== capturedCode) {
      bse.failed++;
      bseReason = 'Official BSE identity code does not match the capture registration';
    } else if (source?.error) {
      bse.failed++;
      bseReason = source.error.message || 'Official BSE source read failed';
    } else if (!source?.lastSuccessAt) {
      bse.never++;
      bseReason = 'Official BSE not checked yet';
    } else {
      const successAt = Date.parse(source.lastSuccessAt);
      const checkedAt = Date.parse(source.recentCheckedAt || source.lastSuccessAt);
      if (!Number.isFinite(successAt) || successAt > now + 600000 || !Number.isFinite(checkedAt) || checkedAt > now + 600000 || now - checkedAt > 48 * 3600000) {
        bse.stale++;
        bseReason = Number.isFinite(successAt) && successAt <= now + 600000 && Number.isFinite(checkedAt) && checkedAt <= now + 600000
          ? 'Official BSE check is overdue' : 'Official BSE check time is invalid';
      } else {
        bse.checked++;
        if (!source.ranges?.some((r) => r.from <= captureIndex.requestedFrom && r.to >= captureIndex.requestedTo)) {
          bse.backfill++;
          bseReason = 'Official BSE historical date windows remain unchecked';
        }
      }
    }
    if (bseReason) bse.gaps.push({ ticker, source: 'BSE', bseCode,
      reason: bseReason, lastSuccessAt: source?.lastSuccessAt || null });
  }
  return { ...tally, total: wanted.length, gaps, bse: kind === 'announcements' ? bse : null,
    available: !!captureIndex, error,
    from: captureIndex?.requestedFrom, to: captureIndex?.requestedTo, updatedAt: captureIndex?.updatedAt,
    unresolved: captureIndex?.unresolved || [], portfolio: captureIndex?.portfolio || null,
    registration: captureIndex?.registration || null, identitySources: captureIndex?.identitySources || {},
    sourceOutages: captureIndex?.sourceOutages || {}, entries };
}
export function companyCaptureStatus(kind, tickers = null, now = Date.now()) {
  return companyCaptureStatusFromIndex(index, kind, tickers, now, indexError);
}
export async function capturedCompany(kind, ticker) {
  if (!/^[A-Z0-9&._-]{1,80}$/.test(ticker)) throw new Error('Choose a valid company ticker.');
  const result = await capturedJson(`data/filing-capture/${kind}/${encodeURIComponent(ticker)}.json`);
  if (!Array.isArray(result.value?.rows)) throw new Error('Shared company history has an unfamiliar format.');
  return result;
}
