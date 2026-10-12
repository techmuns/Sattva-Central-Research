// Exchange identities, not company-name guesses. Keep the dashboard's ticker
// (and its captured history) while updating the provider symbol by exact ISIN.
const upper = value => String(value || '').trim().toUpperCase();
const validIsin = value => /^IN[A-Z0-9]{10}$/.test(value || '');
function identityIndex(entries) {
  const isins = new Map(), symbols = new Map();
  const add = (map, key, entry) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, entry);
    else if (map.get(key)?.isin !== entry.isin) map.set(key, null);
  };
  for (const entry of entries) {
    if (!validIsin(entry.isin)) continue;
    add(isins, entry.isin, entry);
    for (const symbol of [entry.ticker, entry.bseSymbol, entry.bseCode, ...(entry.aliases || [])]) add(symbols, upper(symbol), entry);
  }
  return { isins, symbols };
}
export function quoteTargetIdentity({ nseEntries = [], bseEntries = [] } = {}) {
  const nse = identityIndex(nseEntries), bse = identityIndex(bseEntries);
  return target => {
    if (!target) return target;
    const key = upper(target.ticker);
    const hit = target.isin ? nse.isins.get(target.isin) || bse.isins.get(target.isin)
      : nse.symbols.has(key) ? nse.symbols.get(key) : bse.symbols.get(key);
    if (!hit) return target;
    const primary = nse.isins.get(hit.isin), secondary = bse.isins.get(hit.isin);
    const symbol = upper(primary?.ticker || (secondary?.status !== 'Delisted' ? secondary?.bseSymbol : ''));
    // An explicit provider override remains authoritative. Ambiguous or missing
    // exchange identities keep their existing target and visible failure state.
    return { ...target, isin: hit.isin, ...(!target.yahooTicker && symbol
      ? { yahooTicker: `${symbol}.${primary ? 'NS' : 'BO'}` } : {}) };
  };
}
