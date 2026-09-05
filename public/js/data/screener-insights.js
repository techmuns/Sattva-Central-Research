// Screener's source-backed company operating metrics, captured server-side for the portfolio and
// universe. These are slow-moving series and context only: they do not create alerts themselves.
import { conditionalJson, KEYS, readEntry } from '../core/store.js';
import { screenerInsightHealth, validateScreenerInsightsCapture } from './screener-insights-shared.js';

const ENDPOINT = 'api/screener-insights';
let cache = null;
let pending = null;
const listeners = new Set();

function ingest(payload, checkedAt = Date.now()) {
  validateScreenerInsightsCapture(payload);
  const companies = payload.companies || [];
  cache = {
    companies,
    byTicker: new Map(companies.filter((company) => company.ticker).map((company) => [company.ticker.toUpperCase(), company])),
    meta: {
      checkedAt: payload.checkedAt,
      browserCheckedAt: checkedAt,
      targets: payload.targetCount,
      companies: companies.length,
      metrics: companies.reduce((sum, company) => sum + company.rows.length, 0),
      fullCoverage: payload.fullCoverage,
      failed: payload.failedCount,
      collectorLatestFailed: payload.source?.collectorLatestFailed === true,
      collectorLatestConclusion: payload.source?.collectorLatestConclusion || null,
      collectorRunUrl: payload.source?.collectorRunUrl || null,
      latestReadFailed: false,
    },
  };
  listeners.forEach((fn) => fn());
  return cache;
}

export async function load({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  if (pending) return pending;
  pending = (async () => {
    if (!cache) {
      const stored = await readEntry(KEYS.screenerInsights);
      if (stored?.value) {
        try { ingest(stored.value, stored.savedAt); } catch { /* fetch a valid replacement */ }
      }
    }
    try {
      const out = await conditionalJson(ENDPOINT, { key: KEYS.screenerInsights, optional: true, validate: validateScreenerInsightsCapture });
      if (out.status === 200 && out.value) ingest(out.value, out.checkedAt);
      else if (out.status === 304 && cache) {
        cache.meta.browserCheckedAt = out.checkedAt;
        cache.meta.latestReadFailed = false;
      } else throw Error('Screener Insights could not be refreshed.');
    } catch {
      // Preserve last-good values without passing off a failed read as a fresh source check.
      if (cache) { cache.meta.latestReadFailed = true; listeners.forEach((fn) => fn()); }
    }
    if (!cache) throw Error('Screener Insights capture is not available yet.');
    return cache;
  })().finally(() => { pending = null; });
  return pending;
}

export const isLoaded = () => !!cache;
export const all = () => cache?.meta.latestReadFailed ? cache.companies.map((company) => ({ ...company, readStatus: 'failed' })) : cache?.companies || [];
export const meta = () => cache ? {
  ...cache.meta,
  staleCompanies: cache.companies.filter((company) => screenerInsightHealth(company) !== 'ok').length,
  missingCompanies: Math.max(0, cache.meta.targets - cache.companies.length),
} : null;
export const company = (ticker) => {
  const item = cache?.byTicker.get(String(ticker || '').toUpperCase()) || null;
  return item && cache.meta.latestReadFailed ? { ...item, readStatus: 'failed' } : item;
};
export const forTickers = (tickers) => {
  const wanted = tickers instanceof Set ? tickers : new Set((tickers || []).map((ticker) => String(ticker).toUpperCase()));
  return all().filter((item) => item.ticker && wanted.has(item.ticker.toUpperCase()));
};
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
