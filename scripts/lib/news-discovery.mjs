// Bounded recovery windows. A 48h overlap alone cannot recover late-indexed older stories.
// Reconcile 30 days weekly; success stamps only after the whole requested date partition completes.
export function discoveryRange(state = {}, now = Date.now()) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  // When an old backlog completes today, its read time is not the date through which it covered.
  const success = Date.parse(state.coveredThrough || state.lastSuccessAt || '');
  const reconciled = Date.parse(state.lastReconciledAt || '');
  const reconcile = !Number.isFinite(reconciled) || now - reconciled >= 7 * 86400000;
  const from = !Number.isFinite(success) || reconcile ? now - 30 * 86400000 : success - 48 * 3600000;
  return { from: day(from), to: day(now), reconcile };
}

/** Search API has no documented pagination. Split crowded date ranges, retain all observations,
 * and explicitly flag single-day saturation. A count threshold is a warning, not proof of loss. */
export async function discoverNewsRange({ from, to, ranges = null, read, limit = 20, maxReads = 9 }) {
  const pending = ranges?.length ? [...ranges] : [{ from, to }], articles = [], unresolved = [];
  let reads = 0;
  while (pending.length && reads < maxReads) {
    const range = pending.shift();
    reads++;
    try {
      const response = await read(range);
      if (!Array.isArray(response?.articles)) throw Error('News response has no articles array');
      articles.push(...response.articles);
      const saturated = response.articles.length >= limit || response.hasMore === true || response.truncated === true;
      if (!saturated) continue;
      if (range.from === range.to) { unresolved.push({ ...range, reason: 'possible-single-day-cap' }); continue; }
      const start = Date.parse(range.from), end = Date.parse(range.to);
      const middle = start + Math.floor((end - start) / 86400000 / 2) * 86400000;
      pending.push({ from: range.from, to: new Date(middle).toISOString().slice(0, 10) },
        { from: new Date(middle + 86400000).toISOString().slice(0, 10), to: range.to });
    } catch { unresolved.push({ ...range, reason: 'source-read-failed' }); }
  }
  unresolved.push(...pending.map(range => ({ ...range, reason: 'budget-deferred' })));
  return { articles, reads, unresolved, complete: unresolved.length === 0 };
}

const decode = value => String(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ');
const plain = value => decode(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function officialDocumentLinks(html, pageUrl) {
  const rows = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = new URL(decode(match[1]), pageUrl);
      if (url.protocol !== 'https:' || !/\.pdf$/i.test(url.pathname) || url.username || url.password) continue;
      rows.set(url.href, { url: url.href, title: plain(match[2]) || decode(url.pathname.split('/').pop()).replace(/[_-]/g, ' ') });
    } catch { /* malformed link is not a document */ }
  }
  return [...rows.values()];
}

export function officialDocumentDate(text) {
  // A folder such as /2025/02/ is an upload location, not a publication date. Require the
  // document's own explicit Date field; otherwise retain an undated record and observedAt.
  const match = String(text).slice(0, 2500).match(/\bDate\s*[:–-]\s*(\d{1,2}[\s./-]+(?:[A-Za-z]{3,9}|\d{1,2})[\s,./-]+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  if (!match) return null;
  let value = match[1];
  const numeric = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (numeric) value = `${numeric[3]}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}`;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}
