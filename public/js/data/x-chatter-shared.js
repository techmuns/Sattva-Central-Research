// Search matches identify a query, not a verified fact about the issuer.
export const X_LABEL = 'X / Twitter';
export const CACHE_MS = 24 * 60 * 60 * 1000;
export const SEARCH_DAYS = 7;
export const MAX_COMPANIES = 250;

const clean = (s) => String(s || '').replace(/["()\r\n:]/g, ' ').replace(/\s+/g, ' ').trim();
export function issuerName(value) {
  return clean(value).replace(/(?:\s*[—–_-]\s*|\s+)warrants?\b.*$/i, '')
    .replace(/\b(?:limited|ltd|private|pvt)\.?\b/gi, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
}

export function companyKey(h) {
  return String(h.isin || h.ticker || issuerName(h.name || h.bookName).toLowerCase());
}

export function companyQuery(h) {
  const names = [...new Set([h.name, h.bookName, h.matchedName].map(issuerName).filter((n) => n.length >= 4))];
  const terms = names.map((n) => `"${n}"`);
  // Bare short symbols (for example STL) are ambiguous. A hashtag/cashtag is more explicit.
  const ticker = String(h.ticker || '').toUpperCase();
  if (/^[A-Z][A-Z0-9]{2,19}$/.test(ticker)) terms.push(`#${ticker}`, `$${ticker}`);
  while (terms.length && `(${terms.join(' OR ')}) -is:retweet`.length > 512) terms.pop();
  return terms.length ? `(${terms.join(' OR ')}) -is:retweet` : null;
}

export function portfolioCatalog(holdings = []) {
  const seen = new Set();
  return holdings.map((h) => ({ key: companyKey(h), name: h.name || h.bookName || h.ticker || 'Unnamed holding',
    ticker: h.ticker || null, query: companyQuery(h) }))
    .filter((c) => c.key && !seen.has(c.key) && seen.add(c.key));
}

export function manualSearchUrl(company, latest = true, now = Date.now()) {
  const url = new URL('https://x.com/search');
  url.searchParams.set('q', `${company.query || `"${clean(company.name)}"`} since:${new Date(now - SEARCH_DAYS * 86400000).toISOString().slice(0, 10)}`);
  if (latest) url.searchParams.set('f', 'live');
  return url.href;
}

export function activePosts(record, now = Date.now()) {
  if (!record?.checkedAt || !Number.isFinite(Date.parse(record.expiresAt)) || now >= Date.parse(record.expiresAt)) return [];
  return (record.posts || []).filter((p) => Date.parse(p.createdAt) >= now - SEARCH_DAYS * 86400000);
}

export function recordStatus(record, now = Date.now()) {
  if (!record) return 'not-checked';
  if (record.error) return record.error;
  if (!record.checkedAt) return 'not-checked';
  if (!Number.isFinite(Date.parse(record.expiresAt)) || now >= Date.parse(record.expiresAt)) return 'expired';
  return record.partial ? 'limited' : record.posts?.length ? 'checked' : 'no-matches';
}
