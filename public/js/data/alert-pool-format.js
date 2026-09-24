// HOW THE POOL IS ENCODED AND DECODED — one module, imported by the builder that writes it and by
// the browser that reads it, so the two cannot drift about what a shard holds.
//
// A DAY SHARD carries every public event of every pooled feed that fell on that day, exactly as
// the collectors built it — full `sourceRecord` included, because All Alerts exports it, searches
// it and bookmarks from it — together with each event's position in its feed, and the URL
// COMPANIONS the news dedupe needs: events of another day that share a canonical address with an
// event of this day. The windowed live path retains those companions before choosing the winning
// record (`querySourceFeeds` in daily-alerts.js), so a pool-fed window has to hand it the same.
//
// An AI SHARD carries one calendar month of the events the ranking can read at all: events the
// attribution rules allow to support or contextualise a card (`newsCanSupportAI`,
// `isRelatedNewsContext`), inside the context lookback; the tickerless events of the ranking
// window, which only ever contribute to the market-wide count; and again every URL companion, so
// the publisher dedupe sees whole groups and picks the same winner it would from the full history.
// Those events are COMPACT: the ranking never reads `sourceRecord`, so it is dropped — except that
// a market-wide story keeps its record, because the portfolio discovery mapping runs in the
// browser against the reader's own book and reads the record's text, and a company story keeps
// the three provenance fields the dedupe copies. The full record stays reachable in the day
// shards, which is where a bookmark taken from an AI card goes to fetch it.
//
// `order` is the event's index in its feed's full event list. Multi-day unions are assembled by
// sorting on it, which restores the collector's own order — the one thing the dedupe's tie-break
// and the id-suffixing depend on — without writing a new field onto the event.
import { newsCanSupportAI, isRelatedNewsContext } from './company-news-attribution.js';
import { canonicalArticleUrl } from './filings-shared.js';
import { ALERT_POOL_CONTRACT, POOL_FEEDS, AI_POOL_WINDOW_DAYS, aiPoolOldestDay, aiPoolSpans, poolDays, shiftDay, isDay } from './alert-pool-shared.js';

const NEWS_FEEDS = new Set(['news', 'market-news']);
const RECORD_KEPT = new Set(['market-news']);
const NEWS_PROVENANCE_FIELDS = ['publisher', 'source', 'discoverySource'];

const urlKey = (event) => (event.url ? canonicalArticleUrl(event.url) : null);

/** The canonical addresses of the news-feed events among `chosen`. */
function urlsOf(chosen) {
  const urls = new Set();
  for (const event of chosen) { if (NEWS_FEEDS.has(event.feed)) { const key = urlKey(event); if (key) urls.add(key); } }
  return urls;
}
/**
 * A news feed's events that were not chosen but share a canonical address with a chosen event of
 * EITHER news feed: the live windowed read keeps a company story whose address matches an
 * in-window market-wide story and vice versa (`newsQueryRows`), so the pool keeps the same.
 */
function urlCompanions(feedId, events, picked, urls) {
  if (!NEWS_FEEDS.has(feedId) || !urls.size) return [];
  return events.map((event, order) => ({ event, order }))
    .filter(({ event }) => !picked.has(event) && urls.has(urlKey(event)));
}

const columns = (items) => ({ events: items.map((item) => item.event), order: items.map((item) => item.order) });

/** One shard per pool day, holding the day's events per pooled feed and their companions. */
export function buildDayShards(sourceFeeds, day) {
  const shards = new Map();
  for (const poolDay of poolDays(day)) shards.set(poolDay, { version: 1, contract: ALERT_POOL_CONTRACT, day: poolDay, feeds: {} });
  const pooled = sourceFeeds.filter((feed) => POOL_FEEDS.includes(feed.id));
  const ownItems = new Map(pooled.map((feed) => [feed.id, new Map()]));
  for (const feed of pooled) {
    feed.events.forEach((event, order) => {
      if (!shards.has(event.day)) return;
      const byDay = ownItems.get(feed.id);
      if (!byDay.has(event.day)) byDay.set(event.day, []);
      byDay.get(event.day).push({ event, order });
    });
  }
  for (const [poolDay, shard] of shards) {
    const chosen = pooled.flatMap((feed) => (ownItems.get(feed.id).get(poolDay) || []).map((item) => item.event));
    const urls = urlsOf(chosen);
    const picked = new Set(chosen);
    for (const feed of pooled) {
      const items = ownItems.get(feed.id).get(poolDay) || [];
      shard.feeds[feed.id] = { ...columns(items), companions: columns(urlCompanions(feed.id, feed.events, picked, urls)) };
    }
  }
  return shards;
}

/** Whether the ranking can read an event at all, for a pool built for `day`. */
export function aiPoolKeep(event, day, oldest = aiPoolOldestDay(day), firstDay = shiftDay(day, -(AI_POOL_WINDOW_DAYS - 1))) {
  if (!isDay(event.day) || event.day > day) return false;
  // Market-wide source events acquire their company attribution during assembly,
  // after the pool is read. Older stories can still become card context for the
  // reader's book; judging their raw attribution here silently drops that context.
  if (event.feed === 'market-news' && event.day >= oldest) return true;
  if (event.day >= oldest && (newsCanSupportAI(event) || isRelatedNewsContext(event))) return true;
  return event.day >= firstDay && !event.ticker && !event.entityId;
}

/** The compact form of an event for the AI pool: no source record, except what the browser reads. */
export function compactAiEvent(feedId, event) {
  if (RECORD_KEPT.has(feedId) || event.sourceRecord == null) return event;
  const { sourceRecord, ...rest } = event;
  if (feedId !== 'news' || typeof sourceRecord !== 'object') return rest;
  const provenance = {};
  for (const field of NEWS_PROVENANCE_FIELDS) if (sourceRecord[field] !== undefined) provenance[field] = sourceRecord[field];
  return { ...rest, sourceRecord: provenance };
}

/** One shard per AI span (see aiPoolSpans), holding the kept events whose day falls in it. */
export function buildAiShards(sourceFeeds, day) {
  const oldest = aiPoolOldestDay(day);
  const spans = aiPoolSpans(day);
  const shards = new Map(spans.map((span) => [span.member, { version: 1, contract: ALERT_POOL_CONTRACT, span: span.span, from: span.from, to: span.to, feeds: {} }]));
  const spanOf = (eventDay) => spans.find((span) => eventDay >= span.from && eventDay <= span.to)?.member || null;
  const pooled = sourceFeeds.filter((feed) => POOL_FEEDS.includes(feed.id));
  const keptByFeed = new Map(pooled.map((feed) => {
    const kept = [];
    feed.events.forEach((event, order) => { if (aiPoolKeep(event, day, oldest)) kept.push({ event, order }); });
    return [feed.id, kept];
  }));
  // A companion travels with the NEWEST kept event it accompanies, whichever news feed that
  // event is in: a reader of that shard is the one whose dedupe group would otherwise miss it.
  const chosen = pooled.flatMap((feed) => keptByFeed.get(feed.id).map((item) => item.event));
  const urls = urlsOf(chosen);
  const picked = new Set(chosen);
  const newestByUrl = new Map();
  for (const event of chosen) {
    const key = NEWS_FEEDS.has(event.feed) ? urlKey(event) : null;
    if (key && (!newestByUrl.has(key) || newestByUrl.get(key) < event.day)) newestByUrl.set(key, event.day);
  }
  for (const feed of pooled) {
    const own = new Map(), extra = new Map();
    for (const item of keptByFeed.get(feed.id)) {
      const member = spanOf(item.event.day);
      if (!member) continue;
      if (!own.has(member)) own.set(member, []);
      own.get(member).push(item);
    }
    for (const item of urlCompanions(feed.id, feed.events, picked, urls)) {
      const member = spanOf(newestByUrl.get(urlKey(item.event)) || '');
      if (!member) continue;
      if (!extra.has(member)) extra.set(member, []);
      extra.get(member).push(item);
    }
    for (const [member, shard] of shards) {
      const compact = (items) => (items || []).map((item) => ({ event: compactAiEvent(feed.id, item.event), order: item.order }));
      shard.feeds[feed.id] = { ...columns(compact(own.get(member))), companions: columns(compact(extra.get(member))) };
    }
  }
  return shards;
}

const validShard = (shard) => shard && shard.version === 1 && shard.contract === ALERT_POOL_CONTRACT && shard.feeds && typeof shard.feeds === 'object';
const validColumns = (group) => !!group && Array.isArray(group.events) && Array.isArray(group.order) &&
  group.events.length === group.order.length && group.order.every((n) => Number.isSafeInteger(n) && n >= 0);

/** A shard that does not have the contract's shape, so a caller never reads a partial one. */
export function validateShard(shard, { day = null, span = null, feedId: expectedFeed = null } = {}) {
  if (!validShard(shard)) throw new Error('Alert pool shard has an unfamiliar shape');
  if (day && shard.day !== day) throw new Error(`Alert pool shard is for ${shard.day}, not ${day}`);
  if (span && shard.span !== span) throw new Error(`Alert pool shard is for ${shard.span}, not ${span}`);
  if (expectedFeed && (Object.keys(shard.feeds).length !== 1 || !Object.hasOwn(shard.feeds, expectedFeed)))
    throw new Error(`Alert pool shard does not contain exactly ${expectedFeed}`);
  for (const [feedId, group] of Object.entries(shard.feeds)) {
    if (!POOL_FEEDS.includes(feedId) || !validColumns(group) || (group.companions && !validColumns(group.companions)))
      throw new Error(`Alert pool shard carries an invalid ${feedId} group`);
    for (const event of [...group.events, ...(group.companions?.events || [])]) {
      if (!event || typeof event.id !== 'string' || event.feed !== feedId || typeof event.headline !== 'string' ||
          event.private || event.portfolioOnly || event.weightPct != null || event.holdingWeightPct != null ||
          (event.day != null && !isDay(event.day))) throw new Error(`Alert pool shard carries an invalid ${feedId} event`);
    }
  }
  return shard;
}

/**
 * The events of one feed across several shards, in the feed's own order and without repeats —
 * a companion already present as another shard's own event is the same event and appears once.
 */
export function assembleFeedEvents(shards, feedId) {
  const byOrder = new Map();
  for (const shard of shards) {
    const group = shard.feeds[feedId];
    if (!group) continue;
    group.events.forEach((event, i) => { if (!byOrder.has(group.order[i])) byOrder.set(group.order[i], event); });
    group.companions?.events.forEach((event, i) => { const order = group.companions.order[i]; if (!byOrder.has(order)) byOrder.set(order, event); });
  }
  return [...byOrder.keys()].sort((a, b) => a - b).map((order) => byOrder.get(order));
}
