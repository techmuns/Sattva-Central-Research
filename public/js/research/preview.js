// A small, literal view of the packet already selected for this question. This
// is available before inference and must never be counted as model answer text.
export function researchPreview(evidence) {
  const companies = evidence.selection?.companies || [];
  const sources = evidence.sources || [];
  const items = [];
  const seen = new Set();
  // Prefer the original feed over its duplicate in All Alerts.
  const order = ['company-news', 'company-filings', 'announcements', 'daily-alerts'];
  for (const id of order) {
    const source = sources.find(item => item.id === id);
    if (source?.status !== 'ready') continue;
    for (const row of source.rows || []) {
      if (row.attribution && row.attribution !== 'confirmed') continue;
      if (id === 'company-news' && row.attribution !== 'confirmed') continue;
      if (row.recordType === 'reference-page') continue;
      const company = companies.find(item =>
        row.isin && item.isin ? row.isin === item.isin : row.ticker && row.ticker === item.ticker);
      if (companies.length && !company) continue;
      if (!row.ticker && !row.isin) continue;
      const title = row.title || row.headline;
      if (typeof title !== 'string' || !title.trim()) continue;
      const key = `${row.isin || row.ticker}:${title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ title: title.slice(0, 220), date: row.date || null, period: row.period || null,
        company: company?.name || row.company || row.ticker, ticker: row.ticker,
        tab: source.tab, route: source.route, publisher: row.publisher || row.source || null,
        asOf: source.asOf || null, quality: source.dataQuality || null });
    }
  }
  const dated = item => /^\d{4}-\d{2}-\d{2}/.test(item.date || '') ? item.date : '';
  items.sort((a, b) => dated(b).localeCompare(dated(a)));
  return {
    items: items.slice(0, 3),
    sources: sources.map(source => ({ tab: source.tab, source: source.source || source.id,
      status: source.status, quality: source.dataQuality || null, asOf: source.asOf || null,
      included: source.rows?.length || 0 })),
  };
}
