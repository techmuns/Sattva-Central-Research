// Start the authenticated Family reader for the whole dashboard, including a
// deep link straight to News or filings. No private data is persisted.
import { readPositionSizes, onPortfolioConnection, onPortfolioReady, portfolioReadBusy } from '../research/portfolio-bridge.js';
import * as coverage from './coverage.js';
import * as live from '../core/live.js';
let started = false;
let refreshing = null;
let paused = 0;
/** A question owns a verified book through evidence building and streaming.
 * A background recheck must not invalidate that same book mid-answer. Actual
 * workbook-change notifications from Family still cancel affected answers. */
export function pauseFamilySession() {
  paused++;
  let released = false;
  return () => { if (!released) { released = true; paused--; } };
}
export function refreshFamilySession({ force = true } = {}) {
  if (paused || portfolioReadBusy() && !refreshing) return Promise.resolve(null);
  if (!refreshing) refreshing = readPositionSizes(undefined, { force }).catch(() => null).finally(() => { refreshing = null; });
  return refreshing;
}
export function startFamilySession() {
  if (started) return;
  started = true;
  const refresh = (force = false) => {
    if (!document.hidden && navigator.onLine !== false) void refreshFamilySession({ force });
  };
  onPortfolioConnection(connected => { if (connected) refresh(false); });
  onPortfolioReady(() => refresh(true));
  live.register('family-session', { intervalMs: 60000, fetcher: async () => {
    if (paused || portfolioReadBusy()) return { checked: 0 };
    const reply = await refreshFamilySession({ force: true });
    if (!reply) throw new Error('The Family Office portfolio could not be checked.');
    return { checked: reply.holdings.length };
  } });
  live.start('family-session');
  for (const event of ['focus', 'pageshow', 'online']) window.addEventListener(event, () => refresh(false));
  window.addEventListener('offline', () => coverage.invalidateFamilyBook());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) coverage.invalidateFamilyBook();
    else refresh(false);
  });
}
