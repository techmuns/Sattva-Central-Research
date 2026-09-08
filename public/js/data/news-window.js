// Calendar windows for reading news, never capture/retention cutoffs. All days are IST.
const DAY_MS = 86400000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function newsDay(value = Date.now()) {
  const at = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(at)) return null;
  const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function newsPublicationDay(row = {}) {
  const date = row.date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    const at = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date) return date;
  }
  // Never substitute firstSeenAt / fetchedAt for an unknown publication date.
  return row.publishedAt ? newsDay(row.publishedAt) : null;
}
export const NEWS_PERIODS = [
  { value: '30', label: 'Last 30 days' },
  { value: 'today', label: 'Today' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: 'month', label: 'This month' },
  { value: 'undated', label: 'Date not supplied' },
];
export function newsPeriodBounds(period = '30', now = Date.now()) {
  const to = newsDay(now);
  const days = { today: 1, '3': 3, '7': 7, '14': 14, '30': 30 }[period] || 30;
  const from = period === 'month' ? `${to.slice(0, 7)}-01`
    : new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to, includeUndated: period === 'undated' };
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
  label: 'News period', value: '30', options: NEWS_PERIODS,
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
