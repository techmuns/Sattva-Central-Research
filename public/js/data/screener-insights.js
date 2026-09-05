// Screener's source-backed company operating metrics, captured server-side for the portfolio and
// universe. These are slow-moving series and context only: they do not create alerts themselves.
import { conditionalJson, KEYS, readEntry } from '../core/store.js';
import { validateScreenerInsightsCapture } from './screener-insights-shared.js';

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
    const out = await conditionalJson(ENDPOINT, { key: KEYS.screenerInsights, optional: true });
    if (out.status === 200 && out.value) ingest(out.value, out.checkedAt);
    else if (out.status === 304 && cache) cache.meta.browserCheckedAt = out.checkedAt;
    if (!cache) throw Error('Screener Insights capture is not available yet.');
    return cache;
  })().finally(() => { pending = null; });
  return pending;
}

export const isLoaded = () => !!cache;
export const all = () => cache?.companies || [];
export const meta = () => cache?.meta || null;
export const company = (ticker) => cache?.byTicker.get(String(ticker || '').toUpperCase()) || null;
export const forTickers = (tickers) => {
  const wanted = tickers instanceof Set ? tickers : new Set((tickers || []).map((ticker) => String(ticker).toUpperCase()));
  return all().filter((item) => item.ticker && wanted.has(item.ticker.toUpperCase()));
};
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
