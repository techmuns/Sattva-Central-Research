import { normalisePortfolio, quarterOrder, retainPortfolioHistory } from '../../public/js/data/finology-shared.js';

// A BOOK THE SOURCE PUBLISHES NOTHING FOR is read as that answer. Finology lists two investors
// (rafiyudeen-narudeen-saeyd, sunil-talwar) whose pages carried no holdings and no periods on every
// read since at least 7 September 2026, and refusing that answer held every run red with nothing
// anyone could fix — while the Worker served the very same empty book to every reader. It is
// accepted only when the source counts no stocks and the retained copy holds nothing, so a scrape
// that broke on a populated book is still refused rather than filed as an investor who holds nothing.
const emptyBook = (b) => Array.isArray(b?.holdings) && !b.holdings.length && Array.isArray(b?.quarters) && !b.quarters.length;

export function validateBook(body, slug, previous = null) {
  if (!body || body.ok === false || body.stale === true) throw new Error('Book unavailable or served stale');
  const publishesNothing = emptyBook(body) && !(body.totalStocks > 0) && !previous?.holdings?.length;
  if (body.slug !== slug || !Array.isArray(body.holdings) || !Array.isArray(body.quarters) || (!body.quarters.length && !publishesNothing)) throw new Error('Invalid portfolio shape or identity');
  if (body.holdings.some((h) => !h.company || !h.quarterlyHoldings) || body.quarters.some((q) => !quarterOrder(q))) throw new Error('Invalid holding or period');
  if (!body.holdings.length && (body.totalStocks > 0 || previous?.holdings?.length)) throw new Error('Unexpected empty portfolio');
  if (previous?.fetchedAt && (!body.fetchedAt || Date.parse(body.fetchedAt) < Date.parse(previous.fetchedAt))) throw new Error('Source response is older than the retained book');
  if (previous?.quarters?.length && Math.max(...body.quarters.map(quarterOrder)) < Math.max(...previous.quarters.map(quarterOrder))) throw new Error('Source periods regressed');
  return body;
}

export { retainPortfolioHistory as retainHistory } from '../../public/js/data/finology-shared.js';

// `attempt` is what THIS run tried and how it went — separate from `capturedAt`, which every
// consumer reads as "when this file was written", and from each book's own `fetchedAt`, which is
// when its source was read. A run that refreshed nothing writes the attempt and moves neither.
export function assembleSnapshot({ list, books, failed, previous = {}, capturedAt, attempt = null }) {
  const merged = {}, retained = [];
  const missing = (previous.investors || []).filter((i) => !list.investors.some((next) => next.slug === i.slug));
  const investors = [...list.investors, ...missing];
  failed = { ...failed };
  for (const investor of missing) failed[investor.slug] = { reason: 'missing-from-list', message: 'Previously tracked investor disappeared from the source list; retained pending review.' };
  for (const investor of investors) {
    const slug = investor.slug;
    if (books[slug]) merged[slug] = retainPortfolioHistory(books[slug], previous.books?.[slug]);
    else if (previous.books?.[slug]) { merged[slug] = previous.books[slug]; retained.push(slug); }
  }
  return { capturedAt, source: 'Ticker Finology via the dashboard Worker; scheduled daily',
    count: investors.length, dropped: list.dropped || 0, investors,
    covered: Object.keys(merged).length, refreshed: Object.keys(books).length, retained,
    positions: Object.values(merged).reduce((n, b) => n + b.holdings.length, 0),
    failedCount: Object.keys(failed).length, books: merged, failed,
    ...(attempt ? { lastAttempt: attempt } : previous.lastAttempt ? { lastAttempt: previous.lastAttempt } : {}) };
}
