// Stable company identities for company-news capture and portfolio filtering.
//
// News is searched by name, not by exchange symbol. A symbol is therefore only one attribute of
// the company: private holdings, BSE-only holdings and demerged entities are all valid search
// subjects even when `ticker` is null. ISIN is the durable portfolio identity; a deterministic
// name id is the last resort for a holding that carries neither ISIN nor ticker.
//
// Identity enrichment is explicit. Former names, brands, subsidiaries and official domains are
// facts that must be reviewed, so this module never manufactures them from fuzzy matches. The
// capture's override file supplies them and every selected name becomes its own upstream search.

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const upper = (value) => clean(value).toUpperCase();

const legalNoise = /\b(limited|ltd|private|pvt|plc|company|co)\b/gi;
const warrantNoise = /(?:\s*[—-]\s*warrants?|[_\s]+warrants?)\s*$/i;

/** The company name behind a security line such as "Alpex Solar — warrants". */
export function underlyingCompanyName(value) {
  return clean(value).replace(warrantNoise, '').trim();
}

const nameKey = (value) =>
  underlyingCompanyName(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(legalNoise, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');

const uniq = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

// "Private Beta Limited" and "Private Beta" are the same search, not two aliases. Legal suffix
// variants otherwise double almost every request without widening coverage.
const uniqQueries = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of uniq(values)) {
    const key = (nameKey(value) || value.toLowerCase()).replace(/-(?:l|lt|limite)$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

export function defaultCompanyNewsEntityId(holding = {}) {
  const isin = upper(holding.isin);
  if (isin) return `isin:${isin}`;
  const ticker = upper(holding.ticker);
  if (ticker) return `ticker:${ticker}`;
  return `name:${nameKey(holding.name || holding.bookName || holding.legalName || 'unknown') || 'unknown'}`;
}

const isWarrant = (holding) => warrantNoise.test(clean(holding?.name || holding?.bookName));

function overrideFor(group, overrides) {
  const ids = new Set(group.flatMap((holding) => [
    upper(holding.isin),
    upper(holding.ticker),
    defaultCompanyNewsEntityId(holding).toUpperCase(),
  ]).filter(Boolean));
  return overrides.find((entry) => {
    const match = entry?.match || entry || {};
    return [match.isin, match.ticker, match.entityId].some((value) => ids.has(upper(value)));
  }) || null;
}

/**
 * Resolve every portfolio security line into a stable company search entity.
 *
 * Warrant lines are not separate companies. When their stripped name matches another holding,
 * both ISINs are attached to that company's entity and the upstream is searched once.
 */
export function portfolioNewsEntities(holdings = [], overrides = []) {
  const groups = new Map();
  for (const holding of holdings || []) {
    const key = nameKey(holding?.name || holding?.bookName);
    const fallback = defaultCompanyNewsEntityId(holding);
    const groupKey = key || fallback;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(holding || {});
  }

  const entities = [];
  for (const group of groups.values()) {
    const base = group.find((holding) => !isWarrant(holding) && holding.ticker)
      || group.find((holding) => !isWarrant(holding))
      || group[0];
    const override = overrideFor(group, overrides);
    const legalName = clean(override?.legalName || base.bookName || base.legalName || underlyingCompanyName(base.name));
    const name = clean(override?.name || underlyingCompanyName(base.name) || legalName);
    const ticker = upper(override?.ticker || base.ticker) || null;
    // Identity itself is structural, not editorial: ISIN first, ticker second, stable name last.
    // Overrides may match an entity id, but cannot replace it and strand archived rows when a
    // reviewed label changes.
    const entityId = defaultCompanyNewsEntityId(base);
    const formerNames = uniq(override?.formerNames);
    const brands = uniq(override?.brands);
    const subsidiaries = uniq(override?.subsidiaries);
    const aliases = uniq(override?.aliases);
    const officialDomains = uniq(override?.officialDomains).map((domain) => domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    const queries = uniqQueries([legalName, name, ...formerNames, ...brands, ...subsidiaries, ...aliases]);

    entities.push({
      entityId,
      key: ticker || entityId.toUpperCase(),
      name,
      legalName: legalName || name,
      ticker,
      portfolioIsins: uniq(group.map((holding) => upper(holding.isin))),
      formerNames,
      brands,
      subsidiaries,
      aliases,
      officialDomains,
      queries,
      portfolio: true,
    });
  }
  return entities.sort((a, b) => a.name.localeCompare(b.name));
}

/** Add ticker-bearing universe companies without duplicating portfolio entities. */
export function withUniverseNewsEntities(portfolio, universe = []) {
  const out = [...portfolio];
  const tickers = new Set(out.map((entity) => upper(entity.ticker)).filter(Boolean));
  for (const company of universe || []) {
    const ticker = upper(company?.ticker);
    if (!ticker || tickers.has(ticker)) continue;
    tickers.add(ticker);
    const name = clean(company.name || company.Company || ticker);
    out.push({
      entityId: `ticker:${ticker}`,
      key: ticker,
      name,
      legalName: name,
      ticker,
      portfolioIsins: [],
      formerNames: [],
      brands: [],
      subsidiaries: [],
      aliases: [],
      officialDomains: [],
      queries: [name],
      portfolio: false,
    });
  }
  return out;
}

export const newsRowEntityKey = (row = {}) => clean(row.entityId) || (upper(row.ticker) ? `ticker:${upper(row.ticker)}` : null);

/** Portfolio can match tickerless news by stable entity id; Watchlist remains ticker-based. */
export function filterCompanyNewsByScope(rows, scope, holdings = []) {
  // The caller's standard ticker filter owns Watchlist and Universe (including editable Universe
  // exclusions); it already retains tickerless rows in Universe.
  if (scope !== 'portfolio') return null;
  const entities = portfolioNewsEntities(holdings);
  const ids = new Set(entities.map((entity) => entity.entityId));
  const tickers = new Set(entities.map((entity) => entity.ticker).filter(Boolean));
  return rows.filter((row) => ids.has(row.entityId) || (!!row.ticker && tickers.has(upper(row.ticker))));
}
