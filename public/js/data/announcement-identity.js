// Announcement identities are independent of quote-provider symbols and book-date listing labels.
// These three Yahoo SME aliases are verified against NSE filings (see DATA-CONTRACTS.md).
const SME = { 'ALPEXSOLAR-SM': 'ALPEXSOLAR', 'JAYBEE-SM': 'JAYBEE', 'SAHANA-SM': 'SAHANA' };
// These warrant lines refer to issuers whose equity ISINs are recorded in the same Family book.
// Only company announcements use this relationship; the holdings themselves remain untouched.
const ISSUER_EQUITY = { INE564S13022: 'INE564S01019', INE0R4713012: 'INE0R4701017' };
const upper = value => String(value || '').trim().toUpperCase();
export const filingTicker = value => SME[upper(value)] || upper(value);
// Exchange ISINs join the directories. Keep old exchange/provider symbols as exact aliases.
export function mergeExchangeIdentities(...lists) {
  const entries = new Map();
  for (const entry of lists.flat()) {
    const previous = entries.get(entry.isin);
    entries.set(entry.isin, { ...previous, ...entry,
      aliases: [...new Set([...(previous?.aliases || []), previous?.ticker, ...(entry.aliases || [])].filter(Boolean))] });
  }
  return [...entries.values()];
}
const nameKey = value => upper(value).replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\b(LIMITED|LTD)\b/g, '').replace(/\s+/g, ' ').trim();

export function createAnnouncementIdentity(entries = []) {
  const isins = new Map(), codes = new Map(), symbols = new Map(), names = new Map();
  const unique = (map, key, entry) => {
    if (!key) return;
    if (map.has(key) && map.get(key)?.isin !== entry.isin) map.set(key, null);
    else if (!map.has(key)) map.set(key, entry);
  };
  for (const entry of entries) {
    unique(isins, upper(entry.isin), entry);
    unique(codes, String(entry.bseCode || ''), entry);
    for (const symbol of [entry.ticker, entry.bseSymbol, ...(entry.aliases || [])]) unique(symbols, filingTicker(symbol), entry);
    unique(names, nameKey(entry.name), entry);
  }
  function find(company) {
    // An explicit ISIN/code must never fall through to a different issuer's similar name/symbol.
    if (company.isin) return isins.get(ISSUER_EQUITY[upper(company.isin)] || upper(company.isin)) || null;
    if (company.scripCode || company.bseCode) return codes.get(String(company.scripCode || company.bseCode)) || null;
    const ticker = filingTicker(company.ticker || company.bseSymbol);
    // An explicit BSE watchlist entry stores its company code in the ticker field.
    if (/^\d{6}$/.test(ticker)) return codes.get(ticker) || null;
    if (ticker && symbols.has(ticker)) return symbols.get(ticker);
    // Exact exchange names only, and only for source records without a symbol.
    return !ticker ? names.get(nameKey(company.company || company.name)) || null : null;
  }
  const key = company => {
    const hit = find(company);
    if (hit) return `isin:${hit.isin}`;
    const ticker = filingTicker(company.ticker || company.bseSymbol);
    return ticker ? `ticker:${ticker}` : company.isin ? `isin:${upper(company.isin)}` : null;
  };
  const row = value => {
    const hit = find(value);
    return { ...value, ticker: hit?.ticker || hit?.bseSymbol || filingTicker(value.ticker) || null,
      ...(hit ? { isin: hit.isin, scripCode: hit.bseCode } : {}) };
  };
  return { find, key, row };
}
