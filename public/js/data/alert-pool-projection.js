// A derived portfolio transport, never a narrower capture. Keep original events and order;
// the regular collector still owns discovery, scope, dedupe and ranking. Universe members stay
// available, and a changed identity/alias book makes this shortcut ineligible immediately.
import { portfolioNewsEntities } from './company-news-identity.js';
import { reviewedNewsIdentity } from './company-news-reviewed.js';
import { matchPortfolioNews } from './portfolio-news-matching.js';
import { filingTicker } from './announcement-identity.js';
import { THEMES, themeReadings, themeSignature } from './theme-exposures.js';

export function portfolioProjectionSignature(book = []) {
  return JSON.stringify(['portfolio-pool-v2', projectionModel(book)]);
}
function projectionModel(book) {
  return { entities: portfolioNewsEntities(book).map(reviewedNewsIdentity),
    tickers: [...new Set(book.filter(company => company.ticker).map(company => filingTicker(company.ticker)))].sort(),
    // A market-wide story naming no holding can still bear on one through a reviewed theme
    // (theme-exposures.js), and the assembly makes that holding's indirect copy from it.
    themes: themeSignature() };
}
export function createPortfolioProjection(book = [], model = projectionModel(book)) {
  const entities = model.entities;
  const entityIds = new Set(entities.map(entity => entity.entityId));
  const tickers = new Set(model.tickers);
  const isins = new Set(entities.flatMap(entity => entity.portfolioIsins || []));
  const exposedInBook = new Set(THEMES.flatMap(theme => theme.exposures)
    .filter(exposure => tickers.has(filingTicker(exposure.ticker)) || exposure.isin && isins.has(exposure.isin))
    .map(exposure => exposure.ticker));
  const bearsOnBook = event => event.feed === 'market-news' && exposedInBook.size > 0 &&
    themeReadings(event.headline).some(reading => reading.exposures.some(exposure => exposedInBook.has(exposure.ticker)));
  const memo = new WeakMap();
  return event => {
    const held = memo.get(event);
    if (held) return held;
    let matches = [];
    if (event.feed === 'market-news') matches = matchPortfolioNews({ ...event.sourceRecord,
      title: event.headline, url: event.url, summary: event.sourceRecord?.summary }, entities);
    const reading = {
      keep: matches.length > 0 || entityIds.has(event.entityId) || !!event.ticker && tickers.has(filingTicker(event.ticker)) || bearsOnBook(event),
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
