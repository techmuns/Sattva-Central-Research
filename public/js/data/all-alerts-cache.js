// All Alerts retains the full public source pool. AI Alerts' bounded, attributed window is a
// different contract. Store source rows before scope/discovery mapping, with full export evidence.
import { createAlertWindowCache } from './alert-window-cache.js';

export const ALL_ALERTS_CACHE_KEY = 'all-alerts:public-pool:v1';
export const allAlertsCache = createAlertWindowCache({ cacheKey: ALL_ALERTS_CACHE_KEY });
const PRIVATE_FEEDS = new Set(['company-documents', 'drhp-documents', 'screener-portfolio-upcoming']);
export const publicAlertFeed = feed => !PRIVATE_FEEDS.has(feed.id) && !feed.portfolioOnly;
const publicEvent = event => event && !event.private && !event.portfolioOnly &&
  event.weightPct == null && event.holdingWeightPct == null && !PRIVATE_FEEDS.has(event.feed);

export function materializeAllAlerts(report) {
  const feeds = (report.sourceFeeds || []).filter(publicAlertFeed);
  return { version: 1, contract: 'all-alerts-public-sources-v1', day: report.day,
    feeds: feeds.map(({ events, ...feed }) => feed),
    events: feeds.flatMap(feed => feed.events.filter(publicEvent)),
  };
}

export function restoreAllAlertSources(value, registry, day) {
  const expected = registry.filter(publicAlertFeed).map(feed => feed.id);
  if (value?.version !== 1 || value.contract !== 'all-alerts-public-sources-v1' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.day || '') || value.day > day ||
      !Array.isArray(value.feeds) || !Array.isArray(value.events) ||
      value.feeds.length !== expected.length || new Set(value.feeds.map(feed => feed?.id)).size !== expected.length ||
      !value.feeds.every(feed => expected.includes(feed?.id))) return null;
  const groups = new Map(expected.map(id => [id, []]));
  for (const event of value.events) {
    if (!publicEvent(event) || typeof event.id !== 'string' || !groups.has(event.feed) ||
        typeof event.headline !== 'string' || (event.day != null && !/^\d{4}-\d{2}-\d{2}$/.test(event.day))) return null;
    groups.get(event.feed).push(event);
  }
  // A saved source check is retained, not advanced to this visit. Revalidation starts pending.
  return value.feeds.map(feed => ({ ...feed, events: groups.get(feed.id), status: 'pending',
    reachesToday: value.day === day ? feed.reachesToday : false }));
}

const mergedEvents = new WeakMap();
/** An unfinished/failed source can add evidence and correct identities, but cannot erase the
 * saved remainder. A successful source is authoritative, including a genuinely empty result.
 * Replace identity groups together: some sources legitimately carry several records per id. */
export function retainAlertSource(current, previous) {
  const previousTime = previous?.evidenceAsOf || previous?.asOf;
  const currentTime = current.evidenceAsOf || current.asOf;
  const older = !!(currentTime && previousTime && Date.parse(currentTime) < Date.parse(previousTime));
  if (!previous?.events.length || !publicAlertFeed(current) ||
      (current.status === 'ok' && !older)) return current;
  // Keep the newest evidence generation separately from the current read's source metadata.
  // Otherwise the first older read lowers the comparison time and a second one can erase it.
  const retained = { ...current, evidenceAsOf: older || !currentTime ? previousTime : currentTime };
  if (current.events === previous.events || !current.events.length) return { ...retained, events: previous.events };
  const memo = mergedEvents.get(current.events);
  if (memo?.previous === previous.events && memo.older === older) return { ...retained, events: memo.events };
  const preferred = older ? previous.events : current.events;
  const other = older ? current.events : previous.events;
  const ids = new Set(preferred.map(event => event.id));
  const extra = other.filter(event => !ids.has(event.id));
  const events = extra.length ? [...preferred, ...extra] : preferred;
  mergedEvents.set(current.events, { previous: previous.events, older, events });
  return { ...retained, events };
}
