// Lazy public snapshot reader. Browser checks never request Inc42 or start jobs.
import { revalidatedJson, readEntry, writeEntry, KEYS } from '../core/store.js';
let capture = null, pending = null, readError = null, browserCheckedAt = null, lastReadState = null;
const listeners = new Set();
export const rows = () => capture?.deals || [];
export const meta = () => ({ ...capture, readError, browserCheckedAt });
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
function valid(value) {
  const at = Date.parse(value?.generatedAt || '');
  return value?.version === 1 && value.source === 'https://inc42.com/tag/funding-galore/' && Number.isFinite(at) && at <= Date.now() + 600000 &&
    Array.isArray(value.deals) && new Set(value.deals.map(r => r?.id)).size === value.deals.length && Array.isArray(value.articles) && value.articles.every(a => a && typeof a.url === 'string' && typeof a.title === 'string' && ['pending','ok','unavailable','failed'].includes(a.status) && (!a.notes || Array.isArray(a.notes))) && !!value.archive && value.deals.every(r => /^[a-f0-9]{24}$/.test(r?.id) && /^https:\/\/inc42\.com\/(buzz|features|startups)\/[a-z0-9-]+\/$/.test(r.sourceUrl) &&
      ['date','company','sector','subsector','businessModel','amount','round','investors','leadInvestor'].every(k => typeof r[k] === 'string'));
}
export function health(value = meta(), now = Date.now()) {
  const articles = value.articles || [];
  const pending = articles.filter(a => a.status === 'pending').length;
  const unavailable = articles.filter(a => ['unavailable', 'failed'].includes(a.status)).length;
  const at = Date.parse(value.sourceCheckedAt || '');
  const stale = !Number.isFinite(at) || at > now + 600000 || now - at > 12 * 3600000;
  const failed = !!value.readError || !!value.error || Date.parse(value.cooldownUntil || '') > now;
  const partial = !value.archive?.complete || !!pending || !!unavailable;
  const loaded = !!value.generatedAt;
  return { pending, unavailable, stale, failed, partial,
    label: failed ? 'Collection / delivery needs attention' : !loaded ? 'Loading funding capture…' : stale ? 'Source check overdue' : partial ? 'Latest capture · archive coverage partial' : 'Source checked',
    readState: failed ? 'unavailable' : !loaded ? 'unchecked' : stale ? 'dated' : partial ? 'partial' : 'read' };
}
export function load() {
  if (pending) return pending;
  pending = (async () => {
    const previous = capture?.generatedAt, previousError = readError;
    if (!capture) {
      const saved = await readEntry(KEYS.privateMarketNews);
      if (valid(saved?.value)) { capture = saved.value; listeners.forEach(fn => fn()); }
    }
    try {
      const next = await revalidatedJson('data/private-market-news.json', { fresh: true });
      if (!valid(next)) throw Error('Invalid funding capture');
      // Do not regress a warm reader when a stale deployment arrives.
      if (capture) {
        const ids = new Set(next.deals.map(r => r.id));
        if (Date.parse(next.generatedAt) < Date.parse(capture.generatedAt) || capture.deals.some(r => !ids.has(r.id))) throw Error('Publication is older or incomplete; retaining saved funding history');
      }
      const changed = capture?.generatedAt !== next.generatedAt;
      capture = next;
      if (changed) void writeEntry(KEYS.privateMarketNews, { value:capture, tag:capture.generatedAt });
      readError = null; browserCheckedAt = new Date().toISOString();
    } catch (error) { readError = error.message || 'Published funding capture unavailable'; }
    // A stopped publisher can leave identical bytes readable as their actual
    // source check ages. Update that freshness state even without new rows.
    const readState = health().readState;
    if (previous !== capture?.generatedAt || previousError !== readError || lastReadState !== readState) listeners.forEach(fn => fn());
    lastReadState = readState;
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
