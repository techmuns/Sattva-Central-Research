import { validPositionSizes } from './position-sizes-contract.js';
import { boundedJson } from './family-book-contract.js';
import { useFamilyBook, failFamilyBook } from './coverage.js';

// Aggregate workbook percentages use the shared server connection. They do not
// depend on a reader's Family cookie and never enter browser persistence.
const REUSE_MS = 55_000;
let snapshot = null, pending = null;
export function cachedHoldingSizes(now = Date.now()) {
  const checked = Date.parse(snapshot?.sizes?.checkedAt || '');
  return Number.isFinite(checked) && checked <= now + 10_000 && now - checked <= REUSE_MS ? snapshot : null;
}
export function readHoldingSizes(signal, { force = false } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  const cached = force ? null : cachedHoldingSizes();
  if (cached) {
    useFamilyBook(cached.holdings, cached.sizes.bookAsOf, cached.sizes.checkedAt);
    return Promise.resolve(cached);
  }
  if (!pending) pending = (async () => {
    const startedAt = Date.now();
    try {
      const response = await fetch('/api/holding-sizes', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(20_000) });
      const reply = await boundedJson(response, 1_500_000);
      if (!validPositionSizes(reply, startedAt) || reply.sizes.valuation !== 'workbook' || !/^[a-f0-9]{64}$/.test(reply.sizes.sourceRevision || '')) throw new Error('Invalid portfolio size snapshot');
      snapshot = reply;
      useFamilyBook(reply.holdings, reply.sizes.bookAsOf, reply.sizes.checkedAt);
      return reply;
    } catch {
      snapshot = null;
      failFamilyBook();
      throw new Error('Portfolio sizes are temporarily unavailable.');
    } finally { pending = null; }
  })();
  // Cancelling one view cannot cancel the dashboard's shared background read.
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
