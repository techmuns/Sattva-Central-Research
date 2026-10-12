// A derived portfolio transport, never a narrower capture. Keep original events and order;
// the regular collector still owns discovery, scope, dedupe and ranking. Universe members stay
// available, and a changed identity/alias book makes this shortcut ineligible immediately.
import { portfolioNewsEntities } from './company-news-identity.js';
import { reviewedNewsIdentity } from './company-news-reviewed.js';
import { matchPortfolioNews } from './portfolio-news-matching.js';
import { filingTicker } from './announcement-identity.js';

export function portfolioProjectionSignature(book = []) {
  return JSON.stringify(['portfolio-pool-v1', projectionModel(book)]);
}
function projectionModel(book) {
  return { entities: portfolioNewsEntities(book).map(reviewedNewsIdentity),
    tickers: [...new Set(book.filter(company => company.ticker).map(company => filingTicker(company.ticker)))].sort() };
}
export function createPortfolioProjection(book = [], model = projectionModel(book)) {
  const entities = model.entities;
  const entityIds = new Set(entities.map(entity => entity.entityId));
  const tickers = new Set(model.tickers);
  const memo = new WeakMap();
  return event => {
    const held = memo.get(event);
    if (held) return held;
    let matches = [];
    if (event.feed === 'market-news') matches = matchPortfolioNews({ ...event.sourceRecord,
      title: event.headline, url: event.url, summary: event.sourceRecord?.summary }, entities);
    const reading = {
      keep: matches.length > 0 || entityIds.has(event.entityId) || !!event.ticker && tickers.has(filingTicker(event.ticker)),
      sourceCount: matches.length || 1,
      unresolvedCount: !matches.length && !event.ticker && !event.entityId ? 1 : 0,
    };
    memo.set(event, reading);
    return reading;
  };
}
export function projectPortfolioShard(shard, reading) {
  const project = group => {
    const events = [], order = [];
    group.events.forEach((event, i) => { if (reading(event).keep) { events.push(event); order.push(group.order[i]); } });
    return { events, order };
  };
  return { ...shard, feeds: Object.fromEntries(Object.entries(shard.feeds).map(([id, group]) =>
    [id, { ...project(group), ...(group.companions ? { companions: project(group.companions) } : {}) }])) };
}
