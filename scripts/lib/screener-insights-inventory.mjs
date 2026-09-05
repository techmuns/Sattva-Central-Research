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
  // Current management rows have names + internal IDs, without links. Join their exact names
  // to the export for exchange codes; codeless records retain the namespaced internal ID.
  if (manageRows.length !== records.length) throw Error('inventory-count');
  const keys = new Set();
  const companyIds = new Set();
  const matchedRecords = new Set();
  for (const row of manageRows) {
    let identity = row.href ? screenerInsightIdentity(row.href) : null;
    if (row.href && !identity) throw Error('inventory-identity');
    if (row.companyId !== undefined && (!/^[1-9]\d*$/.test(row.companyId) || companyIds.has(row.companyId))) throw Error('inventory-company-id');
    if (row.companyId !== undefined) companyIds.add(row.companyId);
    const byCode = identity ? records.filter((record) => [record.nseCode, record.bseCode].includes(identity.companyKey)) : [];
    const nameKey = normalizeCompanyName(row.name);
    const byName = nameKey ? records.filter((record) => normalizeCompanyName(record.name) === nameKey) : [];
    const matches = byCode.length ? byCode : byName;
    if (!identity) {
      if (!row.companyId || matches.length !== 1 || matchedRecords.has(matches[0])) throw Error('inventory-export-match');
      const record = matches[0];
      const code = record.nseCode || record.bseCode;
      // Only an exported exchange code may become a ticker/BSE path. Internal IDs are
      // never treated as exchange codes, even when both happen to be numeric.
      identity = screenerInsightIdentity(code ? `/company/${encodeURIComponent(code)}/` : `/company/id/${row.companyId}/`);
    }
    if (!identity || keys.has(identity.companyKey)) throw Error('inventory-ambiguous');
    keys.add(identity.companyKey);
    // ISIN is public company identity, not a position. Only a unique exact export match can
    // join a tickerless company's Insights to the current book; source membership alone cannot.
    if (matches.length === 1) {
      if (matchedRecords.has(matches[0])) throw Error('inventory-export-match');
      matchedRecords.add(matches[0]);
      if (matches[0].isin) identity.isin = matches[0].isin;
    }
    add(identity, row.name, { inPortfolio: true });
  }
  return targets;
}
