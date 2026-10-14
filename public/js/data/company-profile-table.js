// Compact index rows are a partial company lookup, not the full exchange directory.
import { mcapBand, MCAP_UNKNOWN } from './company-profile.js';
export const UNKNOWN_PROFILE = Object.freeze({ mcapCr: null, band: MCAP_UNKNOWN, group: null });
const upper = v => String(v || '').trim().toUpperCase();

export function profileTable(body) {
  const byTicker = new Map(), byBse = new Map(), byIsin = new Map();
  const put = (map, key, value) => {
    if (!key) return;
    const prior = map.get(key);
    if (!map.has(key)) map.set(key, value);
    else if (prior?.isin !== value.isin) map.set(key, null);
  };
  for (const [ticker, bse, isin, mcap, , group] of body.rows || []) {
    const cr = Number.isFinite(mcap) && mcap > 0 ? mcap : null;
    const value = Object.freeze({ isin: upper(isin), mcapCr: cr, band: mcapBand(cr), group: group || null });
    put(byTicker, upper(ticker), value); put(byBse, String(bse || '').trim(), value); put(byIsin, upper(isin), value);
  }
  return { source: 'index', builtAt: body.builtAt || null, profileOf(c = {}) {
    const isin = upper(c.isin), bse = String(c.scripCode || c.bseCode || '').trim();
    const value = isin ? byIsin.get(isin) : bse ? byBse.get(bse) : byTicker.get(upper(c.ticker));
    return value || UNKNOWN_PROFILE;
  } };
}

export function mergeProfileLookups(index, directory) {
  const cache = new Map();
  return { source: index?.source || directory?.source || null, builtAt: index?.builtAt || directory?.builtAt || null,
    revisionKey: JSON.stringify([index?.builtAt, directory?.revisionKey || directory?.builtAt]),
    profileOf(c = {}) {
      const key = [upper(c.isin), c.scripCode || c.bseCode || '', upper(c.ticker)].join('|');
      if (cache.has(key)) return cache.get(key);
      const primary = index?.profileOf(c) || UNKNOWN_PROFILE, fallback = directory?.profileOf(c) || UNKNOWN_PROFILE;
      const cap = primary.mcapCr > 0 ? primary : fallback;
      const value = Object.freeze({ mcapCr: cap.mcapCr, band: cap.band, group: primary.group || fallback.group || null });
      cache.set(key, value); return value;
    } };
}
