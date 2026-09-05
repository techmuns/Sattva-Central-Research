// Observed on the anonymous symbol News page, 2026-09-06. This is a public website
// response, NOT a supported/licensed TradingView API. No login, body/story endpoint,
// subscription parameter, hidden pagination, browser impersonation or access workaround.
import { createAnnouncementIdentity, filingTicker } from '../../public/js/data/announcement-identity.js';

export const TRADINGVIEW_NEWS_ENDPOINT = 'https://news-mediator.tradingview.com/public/view/v1/symbol';
export const PUBLIC_VIEW_LIMIT = 30; // Observed page ceiling; not a completeness guarantee.
const token = value => /^[A-Z0-9][A-Z0-9&._-]{0,79}$/.test(value || '');
const upper = value => String(value || '').trim().toUpperCase();
const safeUrl = value => {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
};

/** Exchange codes come from the current verified book / exact ISIN directory, never names. */
export function tradingViewTargets(entities, directory = []) {
  const identities = createAnnouncementIdentity(directory);
  return entities.map(entity => {
    const hit = identities.find({ isin: entity.entityId?.startsWith('isin:') ? entity.entityId.slice(5) : entity.portfolioIsins?.[0], ticker: entity.ticker });
    const nse = filingTicker(hit ? hit.ticker : entity.ticker);
    const bse = upper(hit?.bseSymbol);
    const symbols = [...new Set([
      token(nse) && !/^\d+$/.test(nse) ? `NSE:${nse}` : null,
      token(bse) ? `BSE:${bse}` : null,
    ].filter(Boolean))];
    return { entity, symbols, reason: symbols.length ? null : 'no-verified-exchange-symbol' };
  });
}

export function tradingViewNewsUrl(symbol) {
  const [exchange, ticker, extra] = String(symbol).split(':');
  if (!['NSE', 'BSE'].includes(exchange) || !token(ticker) || extra !== undefined) throw Error('invalid-symbol');
  const url = new URL(TRADINGVIEW_NEWS_ENDPOINT);
  url.searchParams.append('filter', 'lang:en');
  url.searchParams.append('filter', `symbol:${symbol}`);
  url.searchParams.set('client', 'landing');
  url.searchParams.set('streaming', 'false');
  return url.href;
}

export function tradingViewPageUrl(symbol) {
  tradingViewNewsUrl(symbol); // Same validation at both boundaries.
  return `https://in.tradingview.com/symbols/${encodeURIComponent(symbol.replace(':', '-'))}/news/`;
}

/** Retain only publicly displayed headline metadata. `provider` permission masks the
 * headline behind a trial prompt on the anonymous page; it is deliberately not extracted. */
export function parseTradingViewNews(body, symbol, now = Date.now(), issuerSymbols = [symbol]) {
  if (!body || !Array.isArray(body.items)) throw Error('unrecognized-news-response');
  const articles = [], ids = new Set();
  let restricted = 0, invalid = 0, undated = 0, untagged = 0;
  for (const item of body.items) {
    if (!item || typeof item !== 'object') { invalid++; continue; }
    if (item.permission != null && !['headline', 'preview'].includes(item.permission)) { restricted++; continue; }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const source = typeof item.provider?.name === 'string' ? item.provider.name.trim() : '';
    const storyUrl = typeof item.storyPath === 'string' && /^\/news\/[^/]/.test(item.storyPath)
      ? safeUrl(`https://in.tradingview.com${item.storyPath}`) : null;
    const url = safeUrl(item.link) || storyUrl;
    if (!id || !title || !source || !url) { invalid++; continue; }
    if (ids.has(id)) continue;
    ids.add(id);
    const published = typeof item.published === 'number' ? item.published * 1000 : NaN;
    const publishedAt = Number.isFinite(published) && published >= 946684800000 && published <= now + 600000
      ? new Date(published).toISOString() : null;
    if (!publishedAt) undated++;
    const relatedSymbols = [...new Set((Array.isArray(item.relatedSymbols) ? item.relatedSymbols : [])
      .map(entry => entry?.symbol).filter(value => typeof value === 'string'))];
    // TradingView's BSE view often carries the same issuer's NSE tags. Accept only aliases
    // independently joined through the exact portfolio/ISIN directory, not arbitrary tags.
    if (!relatedSymbols.some(value => issuerSymbols.includes(value))) untagged++;
    articles.push({ title, source, url, publishedAt, date: publishedAt?.slice(0, 10) || null,
      tradingViewId: id, tradingViewUrl: storyUrl, sourceUrls: [url, storyUrl].filter(Boolean),
      discoverySource: 'tradingview-public-news', discoverySources: ['tradingview-public-news'],
      sourcePage: tradingViewPageUrl(symbol), relatedSymbols, sourceSymbol: symbol,
      paywall: item.paywall === true, access: 'public-headline-only',
      permission: item.permission || 'public-page',
    });
  }
  const times = body.items.map(item => item?.published).filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0 && t * 1000 <= now + 600000);
  return { articles, returned: body.items.length, restricted, invalid, undated, untagged,
    limited: body.items.length >= PUBLIC_VIEW_LIMIT,
    oldestReturnedAt: times.length ? new Date(Math.min(...times) * 1000).toISOString() : null };
}

export async function readTradingViewNews(symbol, { fetcher = fetch, now = Date.now(), issuerSymbols = [symbol] } = {}) {
  const response = await fetcher(tradingViewNewsUrl(symbol), { redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const error = Error(`http-${response.status}`);
    error.status = response.status;
    const retry = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(retry || '') ? Number(retry) : (Date.parse(retry || '') - now) / 1000;
    error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(86400000, seconds * 1000) : null;
    throw error;
  }
  if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw Error('non-json-news-response');
  const maximum = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maximum) throw Error('news-response-too-large');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > maximum) throw Error('news-response-too-large');
    parts.push(Buffer.from(part));
  }
  return parseTradingViewNews(JSON.parse(Buffer.concat(parts).toString('utf8')), symbol, now, issuerSymbols);
}
