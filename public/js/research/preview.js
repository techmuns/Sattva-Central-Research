// A small, literal view of the packet already selected for this question. This
// is available before inference and must never be counted as model answer text.
import { rowContext } from './query-context.js';

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function researchPreview(evidence) {
  const plan = evidence.selection || {};
  const companies = plan.companies || [];
  const sources = evidence.sources || [];
  const items = [];
  const seen = new Set();
  // Prefer the original feed over its duplicate in All Alerts.
  const order = ['company-news', 'company-filings', 'announcements', 'nse-filings', 'corporate-actions', 'ipos', 'telegram', 'chatter-posts', 'daily-alerts'];
  for (const id of order) {
    const source = sources.find(item => item.id === id);
    if (source?.status !== 'ready') continue;
    const discussion = ['telegram', 'chatter-posts'].includes(id);
    for (const row of source.rows || []) {
      if (!discussion && row.attribution && row.attribution !== 'confirmed') continue;
      if (id === 'company-news' && row.attribution !== 'confirmed') continue;
      if (row.recordType === 'reference-page') continue;
      const company = companies.find(item =>
        row.isin && item.isin ? row.isin === item.isin : row.ticker && row.ticker === item.ticker);
      if (companies.length && !company) continue;
      if (!row.ticker && !row.isin) continue;
      const title = discussion ? row.text : row.title || row.headline;
      if (typeof title !== 'string' || !title.trim()) continue;
      const key = `${row.isin || row.ticker}:${title.trim().toLowerCase()}`;
      const url = sourceUrl(row.url || row.link);
      const urlKey = url ? `${row.isin || row.ticker}:${url}` : null;
      if (seen.has(key) || urlKey && seen.has(urlKey)) continue;
      seen.add(key); if (urlKey) seen.add(urlKey);
      const context = rowContext(row, plan);
      const limit = discussion ? 700 : 420;
      const truncated = title.length > limit || row.textTruncated === true;
      items.push({ title: title.slice(0, limit), date: context.date || null, dateLabel: row.temporalBasis?.startsWith('ex-date') ? 'Ex-date' : null, period: row.period || null,
        company: company?.name || row.company || row.ticker, ticker: row.ticker, inScope: company?.inScope,
        tab: source.tab, route: source.route, publisher: row.publisher || row.source || (discussion ? source.source : null),
        url, kind: discussion ? 'excerpt' : 'headline', truncated,
        attribution: discussion ? 'Unverified discussion excerpt' : null,
        asOf: source.asOf || null, quality: source.dataQuality || null, context });
    }
  }
  const dated = item => /^\d{4}-\d{2}-\d{2}/.test(item.date || '') ? item.date : '';
  items.sort((a, b) => b.context.topic - a.context.topic || a.context.temporalRank - b.context.temporalRank || dated(b).localeCompare(dated(a)));
  return {
    items: items.slice(0, 3).map(({ context, ...item }) => item),
    sources: sources.map(source => ({ tab: source.tab, source: source.source || source.id,
      status: source.status, quality: source.dataQuality || null, asOf: source.asOf || null,
      included: source.rows?.length || 0 })),
  };
}
