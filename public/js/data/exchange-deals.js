// Sattva-owned shared feed for Bulk/Block Deals and insider disclosures.
import { conditionalJson } from '../core/store.js';
import { exchangeRows, combineExchangeDeals, validateExchangeSnapshot, exchangeSummary, insiderSummary } from './exchange-deals-shared.js';
let lastDispatch = 0, apiTag = null;
let byTicker = new Map(), insidersByTicker = new Map();
let snapshot = null, rows = [], pending = null, loaded = false, lastCheck = 0, timer = null, deliveryError = null;
const listeners = new Set();
// A repaint may replace a subscription; deliver each revision to the original listeners once.
const emit = () => [...listeners].forEach((fn) => fn());
export const meta = () => snapshot ? { ...snapshot, records: undefined, insiders: undefined, securityMap: undefined, deliveryError, summary: exchangeSummary(snapshot, deliveryError), rowCount: rows.length } : null;
export const revision = () => snapshot?.updatedAt || snapshot?.checkedAt || null;
export const disclosuresStatus = tickers => insiderSummary(snapshot, tickers);
export const combined = (secondary) => combineExchangeDeals(secondary, snapshot, rows);
export const forTicker = (secondary, ticker) => combineExchangeDeals(secondary, snapshot, byTicker.get(ticker) || [], insidersByTicker.get(ticker) || []);
export const headers = ['Trade Category', 'Company', 'Insider', 'Transaction', 'Trade Shares', 'Price', 'Trade Value', 'Exchange', 'BSE Code', 'Remarks', 'Category', 'Security Type', 'Trade %', 'Post Holding Shares', 'Post Holding %', 'Mode', 'From Date', 'To Date', 'Broadcast Date', 'Source'];
function accept(data) {
  validateExchangeSnapshot(data);
  if (snapshot && Date.parse(data.updatedAt || data.checkedAt) < Date.parse(revision())) return false;
  if ((data.updatedAt || data.checkedAt) === revision()) return false;
  snapshot = data; rows = exchangeRows(data);
  byTicker = new Map();
  for (const row of rows) { if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []); byTicker.get(row.ticker).push(row); }
  insidersByTicker = new Map(Object.entries(data.insiders?.byTicker || {}).map(([ticker, entry]) => [ticker, entry.trades]));
  return true;
}
export async function refresh() {
  if (pending) return pending;
  if (loaded && Date.now() - lastCheck < 55000) return;
  pending = (async () => {
    let changed = false;
    if (!loaded) {
      const seed = await conditionalJson('data/exchange-deals.json', { key: 'sattva:exchange-deals:seed', optional: true });
      if (seed?.value) { try { changed = accept(seed.value); } catch {} }
      loaded = true; if (changed) emit();
    }
    try {
      const result = await fetch('api/bulk-block-deals', { cache: 'no-cache', signal: AbortSignal.timeout(30000) });
      if (!result.ok) throw new Error('Live delivery is unavailable; the saved exchange capture is shown.');
      const tag = result.headers.get('etag');
      if (!tag || tag !== apiTag) { changed = accept(await result.json()) || changed; apiTag = tag; }
      deliveryError = result.headers.get('x-sattva-exchange-fallback') === '1' ? 'Live delivery is unavailable; the saved exchange capture is shown.' : null;
    } catch (error) { deliveryError = error.message; }
    lastCheck = Date.now();
    // Demand-driven backup for delayed GitHub schedules. The server rejects concurrent/recent runs.
    const india = new Date(Date.now() + 330 * 60000);
    const weekday = ![0, 6].includes(india.getUTCDay()), hour = india.getUTCHours();
    if (snapshot && weekday && hour >= 10 && hour < 22 && Date.now() - Date.parse(snapshot.checkedAt) > 45 * 60000 && Date.now() - lastDispatch > 30 * 60000) {
      lastDispatch = Date.now();
      try { await fetch('api/bulk-block-deals/refresh?source=auto', { method: 'POST', signal: AbortSignal.timeout(15000) }); } catch { /* Capture age remains visible; next poll still reads retained data. */ }
    }
    emit(); // Re-evaluate date windows and source ages even when there are no new rows.
  })().finally(() => { pending = null; });
  return pending;
}
function poll() { if (loaded && typeof document !== 'undefined' && !(document.hidden || innerWidth === 0)) void refresh(); }
export function onChange(fn) {
  listeners.add(fn);
  if (!timer && typeof document !== 'undefined') { timer = setInterval(poll, 60000); document.addEventListener('visibilitychange', poll); window.addEventListener('focus', poll); window.addEventListener('online', poll); if (loaded) void refresh(); }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) { clearInterval(timer); timer = null; if (typeof document !== 'undefined') { document.removeEventListener('visibilitychange', poll); window.removeEventListener('focus', poll); window.removeEventListener('online', poll); } }
  };
}
