import * as watchlist from '../core/watchlist.js';
import { CAPTURE_REGISTRATION_BATCH } from './capture-registration-shared.js';

const ACK_KEY = 'sattva:watchlist-capture';
const DAY = 86400000;
export function createWatchlistCapture({ companies = watchlist.all, fetcher = fetch, now = Date.now,
  read = () => { try { return JSON.parse(localStorage.getItem(ACK_KEY) || '{}'); } catch { return {}; } },
  write = value => { try { localStorage.setItem(ACK_KEY, JSON.stringify(value)); } catch { /* Retry on the next visit. */ } } } = {}) {
  const acknowledged = new Map(Object.entries(read() || {}));
  let pending = null, retryAt = 0, failures = 0, error = null;
  const wanted = () => [...new Set(companies().map(c => c.ticker).filter(t => /^[A-Z0-9&._-]{1,50}$/.test(t || '')))];
  const missing = () => wanted().filter(t => !Number.isFinite(acknowledged.get(t)) || now() - acknowledged.get(t) >= DAY || acknowledged.get(t) > now());
  const status = () => ({ pending: !!pending, remaining: missing(), error });
  function sync() {
    if (pending) return pending;
    if (now() < retryAt || !missing().length) return Promise.resolve(status());
    pending = (async () => {
      const queue = missing(); let incomplete = false;
      try {
        while (queue.length) {
          const batch = queue.splice(0, CAPTURE_REGISTRATION_BATCH);
          const response = await fetcher('api/capture-registration', { method: 'POST', cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ tickers: batch }), signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw new Error('Company registration unavailable');
          const body = await response.json();
          if (body?.ok !== true || !Array.isArray(body.registered) || body.registered.some(t => !batch.includes(t))) throw new Error('Invalid registration response');
          for (const ticker of body.registered) acknowledged.set(ticker, now());
          incomplete ||= body.registered.length !== batch.length;
          write(Object.fromEntries([...acknowledged].filter(([ticker]) => wanted().includes(ticker))));
        }
        failures = 0;
        error = incomplete ? 'Some watchlist companies are awaiting a verified exchange identity or capture capacity. Registration retries automatically.' : null;
        retryAt = incomplete ? now() + 3600000 : 0;
      } catch {
        failures++;
        retryAt = now() + Math.min(15 * 60000, 60000 * 2 ** Math.min(4, failures - 1));
        error = 'Watchlist company registration is temporarily unavailable. Saved registrations are retained and pending companies retry automatically.';
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  return { sync, status };
}

export const watchlistCapture = createWatchlistCapture();
let stop = null;
export function startWatchlistCapture() {
  if (stop) return stop;
  let debounce;
  const sync = () => { if (!document.hidden && navigator.onLine !== false) void watchlistCapture.sync(); };
  const changed = () => { clearTimeout(debounce); debounce = setTimeout(sync, 350); };
  const off = watchlist.onChange(changed);
  const onStorage = event => { if (event.key === 'sattva:watchlist') changed(); };
  const timer = setInterval(sync, 60000);
  window.addEventListener('storage', onStorage);
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', sync);
  changed();
  stop = () => { clearTimeout(debounce); clearInterval(timer); off(); window.removeEventListener('storage', onStorage); window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', sync); stop = null; };
  return stop;
}
