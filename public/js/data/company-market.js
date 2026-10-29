// One bounded price projection and the existing public cap directory, shared by mounted tables.
import { revalidatedJson } from '../core/store.js';
import * as live from './breakout-live.js';
import { companyMarketLookup } from './company-market-shared.js';

let inputs = {}, lookup = companyMarketLookup(), pending = null, checkedAt = -Infinity, dailyFailed = false;
const referenceAttempts = { marketCaps: -Infinity, tickerMap: -Infinity };
const referenceFailed = { marketCaps: false, tickerMap: false };
const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());
export function read(company) {
  const value = lookup.read(company || {}, daily => {
    const quote = live.priceInfo(daily);
    return quote.at ? { ...quote, label: `${quote.stale ? 'Saved · ' : ''}${quote.source} · ${live.stamp(quote.at)}` } : quote;
  });
  if (value.quoteInput === 'quotes' && dailyFailed) value.quoteLabel += ' · latest daily price check unavailable';
  if (value.quoteInput === 'marketCaps' && referenceFailed.marketCaps) value.quoteLabel += ' · latest saved-price reference check unavailable';
  if (referenceFailed[value.mcapInput]) value.mcapLabel += value.mcapInput === 'tickerMap'
    ? ' · latest share-count reference check unavailable' : ' · latest market-cap reference check unavailable';
  else if (!value.mcapCr && value.mcapInput !== 'none' && Object.values(referenceFailed).some(Boolean)) value.mcapLabel += ' · some market references could not be checked';
  return value;
}
export async function load() {
  if (pending) return pending;
  if (Date.now() - checkedAt < 60_000) return;
  checkedAt = Date.now();
  pending = (async () => {
    const readQuotes = async () => {
      try {
        const response = await fetch('/api/technicals/prices', { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error('Price projection unavailable');
        const value = await response.json();
        if (value.version !== 1 || !Array.isArray(value.rows) || !value.rows.length || !Number.isFinite(Date.parse(value.generated_at))) throw Error('Invalid price projection');
        return { value, unavailable: response.headers.get('x-sattva-delivery') === 'deployed-fallback' };
      } catch { return { value: await revalidatedJson('data/company-quotes.json', { fresh: true }), unavailable: true }; }
    };
    const referenceRead = key => {
      if (inputs[key] && !referenceFailed[key] && Date.now() - referenceAttempts[key] < 15 * 60_000) return inputs[key];
      referenceAttempts[key] = Date.now();
      return revalidatedJson(`data/${key === 'marketCaps' ? 'market-caps' : 'mc-ticker-map'}.json`, { fresh: true });
    };
    const values = await Promise.allSettled([readQuotes(),
      referenceRead('marketCaps'), referenceRead('tickerMap')]);
    dailyFailed = values[0].status === 'rejected' || values[0].value?.unavailable === true;
    for (const [i, key] of ['quotes', 'marketCaps', 'tickerMap'].entries()) {
      if (values[i].status !== 'fulfilled') { if (key !== 'quotes') referenceFailed[key] = true; continue; }
      const next = key === 'quotes' ? values[i].value.value : values[i].value;
      if (key === 'quotes') {
        if (!Array.isArray(next?.rows) || !next.rows.length || next.version !== 1 || !Number.isFinite(Date.parse(next.generated_at)) ||
          Date.parse(next.generated_at) < Date.parse(inputs.quotes?.generated_at)) { dailyFailed = true; continue; }
        const previous = new Map((inputs.quotes?.rows || []).map(row => [row.ticker, { ...row, retained: true }]));
        for (const row of next.rows) {
          const old = previous.get(row.ticker);
          if (Number.isFinite(row.cmp) && row.cmp > 0 && (!old?.price_date || row.price_date >= old.price_date)) previous.set(row.ticker, row);
          else if (!old) previous.set(row.ticker, row);
        }
        inputs.quotes = { ...next, rows: [...previous.values()] };
      } else {
        const valid = key === 'marketCaps' ? next?.version === 1 && Array.isArray(next.entries) && next.entries.length && next.entries.every(entry => /^IN[A-Z0-9]{10}$/.test(entry?.isin || ''))
          : next?.map && typeof next.map === 'object' && !Array.isArray(next.map) && Object.values(next.map).every(entry => typeof entry?.ticker === 'string');
        referenceFailed[key] = !valid;
        if (valid) inputs[key] = next;
      }
    }
    lookup = companyMarketLookup(inputs); emit();
  })().finally(() => { pending = null; });
  return pending;
}
export function watch(fn, { watchPrices = true } = {}) {
  listeners.add(fn);
  const check = () => { if (!document.hidden) void load(); };
  const stop = watchPrices ? live.watch(fn) : live.onChange(fn), timer = setInterval(check, 60_000);
  document.addEventListener('visibilitychange', check); window.addEventListener('focus', check); window.addEventListener('online', check);
  check();
  return () => { listeners.delete(fn); stop(); clearInterval(timer); document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check); window.removeEventListener('online', check); };
}
