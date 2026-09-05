import { screenerInsightIdentity } from '../../public/js/data/screener-insights-shared.js';
import { normalizeCompanyName } from './screener-watchlist.mjs';

// Exact, collision-checked joins only. In particular, an internal Screener ID must never be
// converted to an exchange symbol, and a missing code must not kill otherwise valid companies.
export function buildInsightInventory(universe, records, manageRows) {
  if (!Array.isArray(universe) || !universe.length || !Array.isArray(records) || !records.length || !Array.isArray(manageRows)) throw Error('inventory-input');
  const targets = new Map();
  const add = (identity, name, membership) => {
    if (!identity || !name) throw Error('inventory-identity');
    const old = targets.get(identity.companyKey);
    targets.set(identity.companyKey, { ...identity, name: old?.name || name,
      inUniverse: !!(old?.inUniverse || membership.inUniverse), inPortfolio: !!(old?.inPortfolio || membership.inPortfolio) });
  };
  for (const row of universe) add(screenerInsightIdentity(row['Screener URL']), row.Company, { inUniverse: true });
  // Unlike the paginated table view, Screener's management list is the complete watchlist.
  // Verify its cardinality against the full export and require unique valid page identities.
  // No name join is necessary: delisted names can have blank NSE/BSE columns in the export.
  if (manageRows.length !== records.length) throw Error('inventory-count');
  const keys = new Set();
  for (const row of manageRows) {
    const identity = screenerInsightIdentity(row.href);
    if (!identity || keys.has(identity.companyKey)) throw Error('inventory-ambiguous');
    keys.add(identity.companyKey);
    const byCode = records.filter((record) => [record.nseCode, record.bseCode].includes(identity.companyKey));
    const byName = records.filter((record) => normalizeCompanyName(record.name) === normalizeCompanyName(row.name));
    const matches = byCode.length ? byCode : byName;
    // ISIN is public company identity, not a position. Only a unique exact export match can
    // join a tickerless company's Insights to the current book; source membership alone cannot.
    if (matches.length === 1 && matches[0].isin) identity.isin = matches[0].isin;
    add(identity, row.name, { inPortfolio: true });
  }
  return targets;
}
