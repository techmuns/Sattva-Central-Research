// Calendar windows for reading news, never capture/retention cutoffs. All days are IST.
const DAY_MS = 86400000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});
function newsDayOf(at) {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// `formatToParts` is the cost here, and it was paid once per row: every period filter asked "what
// is today" through `newsPeriodBounds(period, now)` for each of ~48,000 trades, and asked each
// row's own publication instant again on every evaluation. Profiled at 523ms self time on one cold
// open of Insider Trades and 551ms on All Alerts. Two caches, both exact: a numeric instant is
// remembered by its UTC minute (IST is a whole number of minutes ahead, so no minute straddles a
// day boundary), and a timestamp string by itself, in a bounded FIFO like `matchKeywords`.
let lastMinute = null, lastMinuteDay = null;
const DAY_CACHE_MAX = 65_536;
const dayCache = new Map();
const dayKeys = new Array(DAY_CACHE_MAX);
let nextDayKey = 0;
export function newsDay(value = Date.now()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const minute = Math.floor(value / 60000);
    if (minute !== lastMinute) { lastMinute = minute; lastMinuteDay = newsDayOf(value); }
    return lastMinuteDay;
  }
  const key = typeof value === 'string' ? value : String(value || '');
  const hit = dayCache.get(key);
  if (hit !== undefined) return hit;
  const at = Date.parse(key);
  const day = Number.isFinite(at) ? newsDayOf(at) : null;
  dayCache.delete(dayKeys[nextDayKey]);
  dayKeys[nextDayKey] = key;
  nextDayKey = (nextDayKey + 1) % DAY_CACHE_MAX;
  dayCache.set(key, day);
  return day;
}
// The publication day is a pure function of two fields, remembered on the row object and checked
// against both fields on every read, so a row a normaliser edits in place is still read correctly.
const publicationDays = new WeakMap();
export function newsPublicationDay(row = {}) {
  const cacheable = row !== null && typeof row === 'object';
  const hit = cacheable ? publicationDays.get(row) : undefined;
  if (hit && hit.date === row.date && hit.publishedAt === row.publishedAt) return hit.day;
  const day = publicationDayOf(row);
  if (cacheable) publicationDays.set(row, { date: row.date, publishedAt: row.publishedAt, day });
  return day;
}
function publicationDayOf(row) {
  const date = row.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    const at = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date) return date;
  }
  // Never substitute firstSeenAt / fetchedAt for an unknown publication date.
  return row.publishedAt ? newsDay(row.publishedAt) : null;
}
export const DEFAULT_NEWS_PERIOD = 'today';
export const NEWS_PERIODS = [
  { value: '30', label: 'Last 30 days' },
  { value: 'today', label: 'Today' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: 'month', label: 'This month' },
  { value: 'undated', label: 'Date not supplied' },
];
// One bounds object per (period, day): a filter asks this once per row, and the answer only moves
// at IST midnight. The object is frozen because it is shared between every caller.
const periodBounds = new Map();
export function newsPeriodBounds(period = '30', now = Date.now()) {
  const to = newsDay(now);
  const key = `${period}|${to}`;
  const hit = periodBounds.get(key);
  if (hit) return hit;
  const days = { today: 1, '3': 3, '7': 7, '14': 14, '30': 30 }[period] || 30;
  const from = period === 'month' ? `${to.slice(0, 7)}-01`
    : new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const bounds = Object.freeze({ from, to, includeUndated: period === 'undated' });
  if (periodBounds.size > 256) periodBounds.clear();
  periodBounds.set(key, bounds);
  return bounds;
}
// Load enough for every offered period once. A 31-day calendar month is intentionally distinct
// from Last 30 days. Changing a filter requires no additional request.
export function recentNewsWindow(now = Date.now()) {
  const recent = newsPeriodBounds('30', now), month = newsPeriodBounds('month', now);
  return { ...recent, from: recent.from < month.from ? recent.from : month.from, includeUndated: true };
}
export function inNewsWindow(row, window) {
  if (!window) return true;
  const day = newsPublicationDay(row);
  return day ? day >= window.from && day <= window.to : !!window.includeUndated;
}
export function matchesNewsPeriod(row, period, now = Date.now()) {
  if (period === 'undated') return !newsPublicationDay(row);
  return inNewsWindow(row, newsPeriodBounds(period, now));
}
// Month filenames are UTC/source-calendar partitions, so include the preceding day for the IST
// midnight boundary. Undated partitions can only be selected explicitly by the window contract.
export function newsShardInWindow(shard, window) {
  if (!window) return true;
  const month = shard.month || String(shard.file || '').match(/(\d{4}-\d{2}|undated)\.json$/)?.[1];
  if (month === 'undated') return !!window.includeUndated;
  if (!/^\d{4}-\d{2}$/.test(month || '')) return true; // validation belongs to the reader
  const firstMonth = new Date(Date.parse(`${window.from}T00:00:00+05:30`)).toISOString().slice(0, 7);
  return month >= firstMonth && month <= window.to.slice(0, 7);
}
export const newsPeriodFilter = () => ({
  label: 'News period', value: DEFAULT_NEWS_PERIOD, options: NEWS_PERIODS,
  match: (row, period) => matchesNewsPeriod(row, period),
});

// Skip duplicate archive downloads only when the loaded archive-derived head certifies the
// whole requested period and is at least as new as the independently revalidated index.
export function newsHeadCoversArchive(meta, index, window) {
  const head = meta.newsHeadWindow;
  return !!window && meta.retention === 'permanent-archive' &&
    /^\d{4}-\d{2}-\d{2}$/.test(head?.from || '') && head.from <= window.from &&
    /^\d{4}-\d{2}-\d{2}$/.test(head?.to || '') && head.to >= window.to &&
    Number.isFinite(Date.parse(index.updatedAt)) && Date.parse(head.updatedAt) >= Date.parse(index.updatedAt) &&
    Number.isInteger(index.articleCount) && index.articleCount === meta.archive?.articleCount;
}
