// data/share-market-cap.js — a company's market cap at the price on screen, for AI Alerts' Compact
// rows. Ported from Glow's sheet-market.js (its `loadShareCounts` and `marketCap` only).
//
// Market cap is shares outstanding (mc-ticker-map.json, Moneycontrol) × the CMP the row shows, so it
// moves with the price. Where no share count is held, Screener's figure as the technicals capture
// printed it stands in, labelled as such and NOT moved by the price. A missing figure is null, never
// zero, and the basis travels with the value so the cell can say which one it is.
//
// The share counts are loaded on their own: a Compact reader must not pull the technicals capture
// just to multiply a price. The printed fallback is used only when the technicals feed is already
// loaded by another reader.
import * as technicals from './technicals.js';
import { revalidatedJson } from '../core/store.js';
import { parseCrore } from './company-profile.js';

const TICKER_MAP_PATH = 'data/mc-ticker-map.json';
const RELOAD_AFTER_MS = 10 * 60_000;

let shares = new Map();
let sharesLoading = null;
let sharesLoadedAt = 0;

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => { try { fn(); } catch (error) { console.error('[share-market-cap] subscriber failed', error); } });
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

export function loadShareCounts({ force = false } = {}) {
  if (sharesLoading && !force && Date.now() - sharesLoadedAt < RELOAD_AFTER_MS) return sharesLoading;
  sharesLoadedAt = Date.now();
  sharesLoading = revalidatedJson(TICKER_MAP_PATH, { optional: true }).then((map) => {
    const next = new Map();
    for (const entry of Object.values(map?.map || {})) {
      if (entry?.ticker && Number.isFinite(entry.shares) && entry.shares > 0) next.set(String(entry.ticker).toUpperCase(), entry.shares);
    }
    const changed = next.size && next.size !== shares.size;
    if (next.size) shares = next;
    if (changed) emit();
  }).catch(() => { sharesLoading = null; });
  return sharesLoading;
}

const daily = (ticker) => (ticker && technicals.isLoaded() ? technicals.byTicker(ticker)?.company || null : null);

/** `{ value (₹ crore), basis }`, or null when neither a share count nor a printed figure is held. */
export function marketCap(ticker, price) {
  if (!ticker) return null;
  const key = String(ticker).toUpperCase();
  const count = shares.get(key);
  if (count && price > 0) return { value: (count * price) / 1e7, basis: `shares outstanding (${count.toLocaleString('en-IN')}, Moneycontrol) × CMP` };
  const printed = parseCrore(daily(key)?.marketCap);
  if (printed) return { value: printed, basis: `Screener's market cap as printed in the technicals capture (does not move with today's price)` };
  return null;
}
