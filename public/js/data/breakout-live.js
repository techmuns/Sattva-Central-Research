// Shared saved observations: browser reads never trigger requests to a market-data provider.
import { conditionalJson, readEntry } from '../core/store.js';
import { validateQuote, quoteFresh, preferQuote, liveBreakout, liveCoverage } from './breakout-live-shared.js';
import { scoreCompany } from '../scoring/tech-scoring.js';
const KEY = 'sattva:breakout-capture:v1';
let capture = null, pending = null, failed = false;
let byTicker = new Map();
const subscribers = new Set();
export const onChange = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
export const snapshot = () => capture;
export const unavailable = () => failed;
function validate(value) {
  if (value?.version !== 1 || !Array.isArray(value.rows) || !Array.isArray(value.targets) || !Array.isArray(value.failures)) throw Error('Invalid saved prices');
  value.rows.forEach(row => validateQuote(row));
}
export function refresh() {
  if (pending) return pending;
  pending = (async () => {
    try {
      const result = await conditionalJson('/api/breakouts', { key: KEY, signal: AbortSignal.timeout(15000), validate });
      capture = result.value; failed = false;
    } catch {
      failed = true;
      if (!capture) {
        try { const stored = (await readEntry(KEY))?.value; validate(stored); capture = stored; } catch { /* No saved capture. */ }
      }
    }
    byTicker = new Map((capture?.rows || []).map(row => [row.ticker,row]));
    subscribers.forEach(fn => fn());
    return { ...liveCoverage(capture, capture?.targets || []), partial: failed || liveCoverage(capture, capture?.targets || []).partial };
  })().finally(() => { pending = null; });
  return pending;
}
export function quote(ticker) { return byTicker.get(ticker) || null; }
export function priceInfo(company, now = Date.now()) {
  const q = quote(company.ticker);
  // A newer completed-session close remains useful if the capture service is behind it.
  const use = preferQuote(q, company, now) ? q : null;
  const bad = failed || capture?.failures.some(row => row.ticker === company.ticker) || !quoteFresh(use, now);
  return { price: use?.price ?? company.cmp ?? null, change: use ? (use.prevClose ? (use.price / use.prevClose - 1) * 100 : null) : company.pct_change_today,
    at: use?.quoteAt || null, source: use?.provider || 'Daily close', stale: !!bad,
    label: use ? `${bad ? 'Saved · ' : ''}${stamp(use.quoteAt)} · ${use.provider}${use.exchange ? ` · ${use.exchange}` : ''}` : `Daily close · ${company.price_date || 'date unavailable'}` };
}
export function priceCaption(info) {
  return [info.change == null ? '' : `${info.change > 0 ? '+' : ''}${Number(info.change).toFixed(2)}% vs previous close`, info.label].filter(Boolean).join(' · ');
}
export function stamp(at) {
  return at && Number.isFinite(Date.parse(at)) ? `${new Date(at).toLocaleString('en-IN', {timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} IST` : 'not available';
}
export function decorate(rows, additionalTickers = new Set()) {
  const combined = new Map(rows.map(row => [row.company.ticker, row]));
  for (const ticker of capture?.targets || []) if (additionalTickers.has(ticker) && !combined.has(ticker)) {
    combined.set(ticker, scoreCompany({ticker, name: quote(ticker)?.name || ticker, error:'Daily price history pending'}));
  }
  return [...combined.values()].map(scored => {
    const daily = scored.company, q = quote(daily.ticker);
    const usable = preferQuote(q, daily);
    if (!usable) return scored;
    // Keep the exact daily inputs for score explanations. Only screening fields use observations.
    return { ...scored, company: { ...daily, dailyCompany: daily, capturedQuote: q,
      consolidation_breakout: liveBreakout(q),
      above_200dma: daily.sma200 > 0 ? q.price > daily.sma200 : null,
      high_proximity_pct: daily.high_52w > 0 ? q.price / Math.max(q.price, daily.high_52w) : null } };
  });
}
export function coverageFor(tickers) {
  const health = liveCoverage(capture, tickers);
  return { ...health, partial: health.partial || failed || capture?.schedule?.overdue === true };
}
// Lifecycle belongs to the visible view; shared reads are coalesced across table and popup.
export function watch(fn) {
  const check = () => { if (document.visibilityState !== 'hidden') void refresh(); };
  const off = onChange(fn);
  const timer = setInterval(check, 60000);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check); window.addEventListener('online', check);
  check();
  return () => { off(); clearInterval(timer); document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check); window.removeEventListener('online', check); };
}
