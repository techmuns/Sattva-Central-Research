// Reviewed Screener IDs are website identities, never exchange tickers.
// Verified 2026-09-21: /company/id/1286088/ links NSE DHOOTTRANS / BSE 544867.
const SCREENER_IDS = { '1286088': 'DHOOTTRANS' };
export function tickerFromScreenerUrl(url) {
  const match = String(url || '').match(/\/company\/([^/?#]+)(?:\/([^/?#]+))?/i);
  if (!match) return null;
  return match[1].toLowerCase() === 'id' ? SCREENER_IDS[match[2]] || null : match[1].toUpperCase();
}
export function marketTicker(company) {
  const ticker = String(company?.ticker || '').trim().toUpperCase();
  const resolved = tickerFromScreenerUrl(company?.screenerUrl || company?.['Screener URL']);
  return ticker === 'ID' ? resolved : ticker || resolved;
}
