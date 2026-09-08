import { summaryId, summaryUrl } from '../../public/js/data/concall-summaries-shared.js';
import { validateResolvedPortfolio } from '../../public/js/data/family-book-contract.js';

const symbol = value => String(value || '').toUpperCase().replace(/-SM$/, '');
const name = value => String(value || '').toLowerCase().replace(/\b(limited|ltd|private|pvt)\b/g, '').replace(/[^a-z0-9]/g, '');

// Fresh Family membership is authoritative. Screener's watchlist may lag a workbook update.
// A unique exact name can resolve tickerless holdings, but a conflicting ticker never can.
export function buildSummaryInventory(portfolio, capture, { now = Date.now(), identities = [] } = {}) {
  validateResolvedPortfolio(portfolio, { now });
  if (!capture?.fullHistory || !Array.isArray(capture.rows) || capture.rows.length > 25000 ||
      !Number.isFinite(Date.parse(capture.checkedAt)) || now - Date.parse(capture.checkedAt) > 30 * 60_000 ||
      Date.parse(capture.checkedAt) > now + 60000) throw Error('Source catalogue is not current and complete');
  const companies = new Map();
  for (const row of capture.rows) {
    if (!companies.has(row.companyKey)) companies.set(row.companyKey, { key: row.companyKey, tickers: new Set(), names: new Set(), rows: [] });
    const company = companies.get(row.companyKey);
    if (row.ticker) company.tickers.add(symbol(row.ticker));
    company.names.add(name(row.name));
    company.rows.push(row);
  }
  const holdings = [], targets = new Map();
  const matches = portfolio.holdings.map(holding => {
    const ticker = symbol(holding.ticker);
    let hits = ticker ? [...companies.values()].filter(c => c.tickers.has(ticker)) : [];
    if (!hits.length) {
      const exact = identities.filter(entry => entry.isin === holding.isin);
      if (exact.length === 1) hits = [...companies.values()].filter(c => c.key === exact[0].bseCode ||
        (exact[0].ticker && c.tickers.has(symbol(exact[0].ticker))));
    }
    if (!hits.length && !ticker && portfolio.holdings.filter(item => name(item.name) === name(holding.name)).length === 1)
      hits = [...companies.values()].filter(c => c.names.has(name(holding.name)));
    return hits;
  });
  const owners = new Map();
  for (const hits of matches) for (const hit of hits) owners.set(hit.key, (owners.get(hit.key) || 0) + 1);
  for (const [index, holding] of portfolio.holdings.entries()) {
    const hits = matches[index];
    if (hits.length !== 1 || owners.get(hits[0]?.key) !== 1) {
      holdings.push({ isin: holding.isin, ticker: holding.ticker, name: holding.name,
        discovery: hits.length ? 'ambiguous-identity' : 'no-matching-source-company', summaries: 0 });
      continue;
    }
    const company = hits[0];
    const candidates = company.rows.filter(row => summaryId(row.summaryUrl))
      .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate) || Number(b.kind === 'Transcript') - Number(a.kind === 'Transcript') || a.summaryUrl.localeCompare(b.summaryUrl));
    const unique = new Map();
    for (const row of candidates) {
      const id = summaryId(row.summaryUrl);
      if (unique.has(id)) continue;
      unique.set(id, { id, isin: holding.isin, companyKey: company.key, companyUrl: row.companyUrl,
        ticker: holding.ticker, name: holding.name, sourceName: row.name,
        publishedDate: row.publishedDate, kind: row.kind, sourceDocumentUrl: row.url, url: summaryUrl(id), rank: unique.size });
    }
    for (const target of unique.values()) {
      if (targets.has(target.id) && targets.get(target.id).isin !== target.isin) throw Error('Conflicting source summary identity');
      targets.set(target.id, target);
    }
    holdings.push({ isin: holding.isin, ticker: holding.ticker, name: holding.name, companyKey: company.key,
      discovery: unique.size ? 'matched' : 'no-published-summary', summaries: unique.size });
  }
  return { version: 1, portfolioRevision: portfolio.sourceRevision, portfolioCheckedAt: portfolio.syncedAt,
    portfolioAsOf: portfolio.asOf, portfolioWorkbookUploadedAt: portfolio.sourceWorkbook.uploadedAt,
    sourceCheckedAt: capture.checkedAt, holdings,
    targets: [...targets.values()].sort((a, b) => a.rank - b.rank || b.publishedDate.localeCompare(a.publishedDate) || a.id.localeCompare(b.id)) };
}
