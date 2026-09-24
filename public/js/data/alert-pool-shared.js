// THE PRECOMPUTED ALERT POOL — the one definition of what it holds, shared by the runner that
// builds it (scripts/build-alert-pool.mjs), the Worker that serves it (worker/alert-pool.mjs) and
// the browser that seeds the alert collectors from it (public/js/data/alert-pool.js).
//
// The pool is a DERIVED artifact and never a source. Every event in it is the same object the
// browser's own collectors would build from the committed captures, published so that a reader
// does not have to download and classify a month of captures to see today's alerts. Nothing about
// the captures, their retention or the live collection path changes: a window the pool does not
// cover, a capture the pool was not built from, or a device holding rows of its own all take the
// path they took before. This module holds only pure vocabulary — no fetch, no DOM, no Node API —
// so the Worker can import it without dragging the browser's data modules into its bundle.
import { AI_ALERT_WINDOW_DAYS } from '../core/alert-window.js';

export const ALERT_POOL_CONTRACT = 'alert-pool-v3';
export const ALERT_POOL_ARTIFACT = 'alert-pool';
export const ALERT_POOL_WORKFLOW = 'alert-pool-refresh.yml';
export const ALERT_POOL_INDEX_MEMBER = 'index.json';
// Today and the thirty days before it: every selected period All Alerts offers (Today, Last
// 3/7/14/30 days, This month) lies inside it. All history and undated records keep the live path.
export const ALERT_POOL_DAYS = 31;
// The AI pool must reach as far back as the card context does (intelligence-graph.js
// CONTEXT_LOOKBACK_DAYS); the builder asserts the two agree rather than importing that module here.
export const AI_POOL_LOOKBACK_DAYS = 180;
export const AI_POOL_WINDOW_DAYS = AI_ALERT_WINDOW_DAYS;

// The feeds the pool carries. Each is read entirely from committed captures (or, for the insider
// feed, the exchange-deals artifact the Worker already serves), so the runner can build exactly
// what the browser would. Feeds with a live route the browser reads directly (NSE filings, IPOs)
// and the cheap ones (institutions, the calendar, investor books) stay on their own path.
export const POOL_FEEDS = ['technicals', 'announcements', 'insider', 'news', 'market-news'];

// EVERY CAPTURE A POOLED FEED READS, by the name /api/capture-status reports it under. A feed is
// seeded from the pool only while every one of these carries the same revision the pool was built
// from; one that moved sends that feed down the live path until the next build catches up.
export const POOL_CAPTURES = {
  technicals: { path: '/data/technicals.json' },
  announcements: { path: '/data/corp-announcements.json' },
  announcementsArchive: { path: '/data/announcements-archive/index.json' },
  announcementsRecent: { path: '/data/filing-capture/announcements-recent.json' },
  companyFilings: { path: '/data/filing-capture/index.json' },
  insider: { path: '/data/insider-trades.json' },
  insiderArchive: { path: '/data/insider-archive/index.json' },
  // Not a file: the Worker serves the newest bulk/block artifact and reports its id.
  exchangeDeals: { route: '/api/bulk-block-deals' },
  companyNews: { path: '/data/news.json' },
  companyNewsIndex: { path: '/data/company-news/index.json' },
  tradingviewNews: { path: '/data/tradingview-news/latest.json' },
  tradingviewIndex: { path: '/data/tradingview-news/index.json' },
  marketNews: { path: '/data/market-news.json' },
};
export const POOL_FEED_CAPTURES = {
  technicals: ['technicals'],
  announcements: ['announcements', 'announcementsArchive', 'announcementsRecent', 'companyFilings'],
  insider: ['insider', 'insiderArchive', 'exchangeDeals'],
  news: ['companyNews', 'companyNewsIndex', 'tradingviewNews', 'tradingviewIndex', 'marketNews'],
  'market-news': ['marketNews'],
};

// A CAPTURE'S REVISION IS EVERY FIELD THAT CAN MOVE WITHOUT ITS TIMESTAMP MOVING. `capturedAt`
// alone is not enough: an enrichment run advances `newsUpdatedAt` on a last-good company-news
// head without touching its core check time, and an archive index rewrites its counts. Comparing
// too little would let the pool answer for a capture it was not built from; comparing every
// present field can only send a feed down the live path a little more often, which is the safe
// direction. `captureStamp` stays the single timestamp the capture watchdog has always read.
export const REVISION_FIELDS = ['capturedAt', 'generated_at', 'fetchedAt', 'lastRunFinishedAt', 'updatedAt',
  'checkedAt', 'newsUpdatedAt', 'queryRevision', 'price_date', 'archivedCount', 'newestId', 'articleCount', 'rowCount'];
export function captureStamp(body) {
  return body?.capturedAt || body?.generated_at || body?.fetchedAt || body?.lastRunFinishedAt || null;
}
export function captureRevision(body) {
  if (!body || typeof body !== 'object') return null;
  const present = REVISION_FIELDS.filter((field) => body[field] != null && ['string', 'number', 'boolean'].includes(typeof body[field]));
  return present.length ? JSON.stringify(present.map((field) => [field, body[field]])) : null;
}

export const dayMember = (day) => `days/${day}.json.gz`;
// The AI pool uses one shard per day for the pool's thirty-one days, then one per older month.
// Members are reusable within an artifact; a new artifact gives even unchanged spans new URLs.
export const aiMember = (span) => `ai/${span}.json.gz`;
export const MEMBER_PATTERN = /^(days\/\d{4}-\d{2}-\d{2}|ai\/\d{4}-\d{2}(?:-\d{2})?)(?:\.(technicals|announcements|insider|news|market-news))?\.json\.gz$/;
export const isPoolMember = (name) => MEMBER_PATTERN.test(String(name || ''));
export function feedMember(member, feedId) {
  if (!POOL_FEEDS.includes(feedId) || !isPoolMember(member) || MEMBER_PATTERN.exec(member)[2])
    throw Error('Invalid alert pool feed member');
  return member.replace(/\.json\.gz$/, `.${feedId}.json.gz`);
}

export const shiftDay = (day, amount) => {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
export const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
/** The days a pool built for `day` holds: `day` and the ALERT_POOL_DAYS - 1 days before it. */
export function poolDays(day) {
  return Array.from({ length: ALERT_POOL_DAYS }, (_, i) => shiftDay(day, -(ALERT_POOL_DAYS - 1 - i)));
}
/** The oldest event day the AI pool must carry for a pool built for `day`. */
export const aiPoolOldestDay = (day) => shiftDay(day, -AI_POOL_LOOKBACK_DAYS);
const monthEnd = (month) => { const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); return shiftDay(next.toISOString().slice(0, 10), -1); };
/**
 * The AI pool's shards for a pool built for `day`, oldest first: one span per calendar month
 * before the pool's own days, then one per pool day. Every span is inclusive and the spans tile
 * [aiPoolOldestDay(day), day] without overlap.
 */
export function aiPoolSpans(day) {
  const oldest = aiPoolOldestDay(day);
  const firstPoolDay = poolDays(day)[0];
  const spans = [];
  for (let cursor = oldest; cursor < firstPoolDay;) {
    const month = cursor.slice(0, 7);
    const to = monthEnd(month) < shiftDay(firstPoolDay, -1) ? monthEnd(month) : shiftDay(firstPoolDay, -1);
    spans.push({ span: month, member: aiMember(month), from: cursor, to });
    cursor = shiftDay(to, 1);
  }
  for (const poolDay of poolDays(day)) spans.push({ span: poolDay, member: aiMember(poolDay), from: poolDay, to: poolDay });
  return spans;
}
/** Which days a selected period needs from the pool, or null when the period is not pooled. */
export function windowDays(queryWindow, poolDay) {
  if (!queryWindow || queryWindow.includeUndated || !isDay(queryWindow.from) || !isDay(queryWindow.to)) return null;
  if (queryWindow.from > queryWindow.to || queryWindow.to > poolDay) return null;
  const held = new Set(poolDays(poolDay));
  const days = [];
  for (let cursor = queryWindow.from; cursor <= queryWindow.to; cursor = shiftDay(cursor, 1)) {
    if (!held.has(cursor)) return null;
    days.push(cursor);
  }
  return days;
}
