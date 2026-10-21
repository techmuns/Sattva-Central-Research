// Lazy public snapshot reader. Browser checks never request Inc42 or start jobs.
import { revalidatedJson } from '../core/store.js';
let capture = null, pending = null, readError = null, browserCheckedAt = null;
const listeners = new Set();
export const rows = () => capture?.deals || [];
export const meta = () => ({ ...capture, readError, browserCheckedAt });
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export function health(value = meta(), now = Date.now()) {
  const articles = value.articles || [];
  const pending = articles.filter(a => a.status === 'pending').length;
  const unavailable = articles.filter(a => ['unavailable', 'failed'].includes(a.status)).length;
  const at = Date.parse(value.sourceCheckedAt || '');
  const stale = !Number.isFinite(at) || at > now + 600000 || now - at > 12 * 3600000;
  const failed = !!value.readError || !!value.error || Date.parse(value.cooldownUntil || '') > now;
  const partial = !value.archive?.complete || !!pending || !!unavailable;
  return { pending, unavailable, stale, failed, partial,
    label: failed ? 'Collection / delivery needs attention' : stale ? 'Source check overdue' : partial ? 'Latest capture · archive coverage partial' : 'Source checked',
    readState: failed ? 'unavailable' : stale ? 'dated' : partial ? 'partial' : 'read' };
}
export function load() {
  if (pending) return pending;
  pending = (async () => {
    const previous = capture?.generatedAt, previousError = readError;
    try {
      const next = await revalidatedJson('data/private-market-news.json', { fresh: true });
      if (next?.version !== 1 || !Array.isArray(next.deals) || !Array.isArray(next.articles) || !next.archive) throw Error('Invalid funding capture');
      // Do not regress a warm reader when a stale deployment arrives.
      if (!capture || Date.parse(next.generatedAt || '') >= Date.parse(capture.generatedAt || '')) capture = next;
      readError = null; browserCheckedAt = new Date().toISOString();
    } catch (error) { readError = error.message || 'Published funding capture unavailable'; }
    if (previous !== capture?.generatedAt || previousError !== readError) listeners.forEach(fn => fn());
    return { added: 0, checked: capture ? 1 : 0, failed: readError ? 1 : 0, partial: health().partial };
  })().finally(() => { pending = null; });
  return pending;
}
export const refresh = load;
export function bindLifecycle({ doc = document, win = window, schedule = setInterval, cancel = clearInterval, now = Date.now } = {}) {
  let last = 0, disposed = false;
  const check = () => { if (disposed || doc.visibilityState === 'hidden' || now() - last < 60000) return; last = now(); void load(); };
  const timer = schedule(check, 5 * 60000);
  doc.addEventListener('visibilitychange', check); win.addEventListener('focus', check); win.addEventListener('online', check); check();
  return () => { disposed = true; cancel(timer); doc.removeEventListener('visibilitychange', check); win.removeEventListener('focus', check); win.removeEventListener('online', check); };
}
