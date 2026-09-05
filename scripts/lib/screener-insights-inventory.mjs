import { screenerInsightIdentity } from '../../public/js/data/screener-insights-shared.js';
import { normalizeCompanyName } from './screener-watchlist.mjs';

const FAILURE_CODES = new Set(['inventory-input', 'inventory-identity', 'inventory-count', 'inventory-company-id',
  'inventory-codeless-match', 'inventory-code', 'inventory-ambiguous', 'inventory-isin']);

// Public workflow logs contain bounded aggregate counts and fixed reason codes only. Never
// serialize the error itself: upstream messages can contain URLs, names or account details.
export function insightInventoryDiagnostic(error, { universe, records, manageRows } = {}) {
  const count = (rows, predicate = () => true) => Array.isArray(rows) ? Math.min(10_000, rows.filter(predicate).length) : null;
  return {
    reason: FAILURE_CODES.has(error?.message) ? error.message : 'inventory-unclassified',
    universeRows: count(universe), exportRows: count(records), managementRows: count(manageRows),
    codedRows: count(records, row => !!(row?.nseCode || row?.bseCode)),
    codelessRows: count(records, row => !(row?.nseCode || row?.bseCode)),
    linkedManagementRows: count(manageRows, row => !!row?.href),
  };
}

export function splitInsightReadTargets(selected) {
  return {
    readable: selected.filter(target => !target.unresolved),
    unresolvedKeys: selected.filter(target => target.unresolved).map(target => target.companyKey),
  };
}

// Exact, collision-checked joins only. In particular, an internal Screener ID must never be
// converted to an exchange symbol, and a missing code must not kill otherwise valid companies.
export function buildInsightInventory(universe, records, manageRows, { previousCompanies = [] } = {}) {
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
  // The export is authoritative for both membership and exchange codes. Its display names
  // need not match the management page. Only codeless export records need a management join.
  if (manageRows.length !== records.length) throw Error('inventory-count');
  const companyIds = new Set();
  const linkedKeys = new Set();
  for (const row of manageRows) {
    const identity = row.href ? screenerInsightIdentity(row.href) : null;
    if ((row.href && !identity) || !normalizeCompanyName(row.name)) throw Error('inventory-identity');
    if (row.companyId !== undefined && (!/^[1-9]\d*$/.test(row.companyId) || companyIds.has(row.companyId))) throw Error('inventory-company-id');
    if (!identity && !row.companyId) throw Error('inventory-company-id');
    if (row.companyId !== undefined) companyIds.add(row.companyId);
    if (identity) {
      if (linkedKeys.has(identity.companyKey)) throw Error('inventory-ambiguous');
      linkedKeys.add(identity.companyKey);
    }
  }
  const keys = new Set();
  const isins = new Set();
  const usedCodelessRows = new Set();
  for (const record of records) {
    if (!/^INE[A-Z0-9]{9}$/.test(record.isin || '') || isins.has(record.isin)) throw Error('inventory-isin');
    isins.add(record.isin);
    const code = record.nseCode || record.bseCode;
    let identity;
    if (code) {
      identity = screenerInsightIdentity(`/company/${encodeURIComponent(code)}/`);
      if (!identity) throw Error('inventory-code');
    } else {
      const nameKey = normalizeCompanyName(record.name);
      const matches = nameKey ? manageRows.filter(row => normalizeCompanyName(row.name) === nameKey) : [];
      if (matches.length !== 1 || usedCodelessRows.has(matches[0]) ||
          records.filter(row => normalizeCompanyName(row.name) === nameKey).length !== 1) {
        // An exact ISIN may reuse a previously validated page, which will be rechecked by
        // the collector. If that read fails, its existing last-good series remains retained.
        const previousMatches = previousCompanies.filter(company => company.isin === record.isin &&
          screenerInsightIdentity(company.companyUrl)?.companyKey === company.companyKey);
        if (previousMatches.length === 1) identity = screenerInsightIdentity(previousMatches[0].companyUrl);
        else {
          // Membership and ISIN are known; the page is not. Never guess a URL or ticker.
          const companyKey = `ISIN:${record.isin}`;
          targets.set(companyKey, { companyKey, isin: record.isin, unresolved: true, inPortfolio: true, inUniverse: false });
          continue;
        }
      } else {
        const row = matches[0];
        usedCodelessRows.add(row);
        identity = screenerInsightIdentity(row.href || `/company/id/${row.companyId}/`);
      }
    }
    if (!identity || keys.has(identity.companyKey)) throw Error('inventory-ambiguous');
    keys.add(identity.companyKey);
    // This ISIN and code come from the same export row, never a guessed cross-name join.
    if (record.isin) identity.isin = record.isin;
    add(identity, record.name, { inPortfolio: true });
  }
  return targets;
}
