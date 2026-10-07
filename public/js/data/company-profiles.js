// data/company-profiles.js — MARKET CAP, SIZE BAND AND SECTOR FOR A COMPANY, IN THE BROWSER.
//
// News and All Alerts rank within each day by relevance (relevance.js), and size and sector are two
// of its inputs. The announcement index already holds both for every company it knows, so the
// browser asks it for one compact table (GET /api/announcement-index/profiles, ~100 KB) instead of
// downloading the captures that produced it. Where that cannot be read — a static copy, or no index
// built yet — the figures are derived here (company-profile.js) from the two small reference files
// only: the Moneycontrol map's own market cap and the sector file. NOT technicals.json: it is a
// 2.8 MB pooled capture, and All Alerts on Today reads the alert pool precisely so that no capture
// is downloaded (verify-alert-pool-ui.mjs asserts it). A band from the map's figure can differ from
// the index's Screener figure near a band edge; that is a fallback's precision, never a missing row.
//
// A COMPANY THIS CANNOT PLACE IS SIZE "UNKNOWN", never small and never zero. Its items stay in the
// list; the ranking reads it exactly as the index does.
import { buildCompanyProfiles, mcapBand, MCAP_UNKNOWN } from './company-profile.js';
import { revalidatedJson } from '../core/store.js';

let profiles = null; // { profileOf, source, builtAt }
let pending = null;
let revision = 0;
const listeners = new Set();
const UNKNOWN = Object.freeze({ mcapCr: null, band: MCAP_UNKNOWN, group: null });

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const profilesRevision = () => revision;
export const profilesSource = () => profiles?.source || null;

/** The profile for a company, or UNKNOWN while the table is loading or when the company is unknown. */
export function profileOf(company = {}) {
  return profiles ? profiles.profileOf(company) : UNKNOWN;
}

function fromTable(body) {
  const byTicker = new Map(), byBse = new Map(), byIsin = new Map();
  for (const [ticker, bse, isin, mcap, band, group] of body.rows || []) {
    const value = Object.freeze({ mcapCr: Number.isFinite(mcap) ? mcap : null, band: band || mcapBand(mcap), group: group || null });
    if (ticker && !byTicker.has(ticker)) byTicker.set(ticker, value);
    if (bse && !byBse.has(bse)) byBse.set(bse, value);
    if (isin && !byIsin.has(isin)) byIsin.set(isin, value);
  }
  const upper = (v) => String(v ?? '').trim().toUpperCase();
  return {
    source: 'index', builtAt: body.builtAt || null,
    profileOf: (c = {}) => byTicker.get(upper(c.ticker)) || byBse.get(String(c.scripCode || c.bseCode || '').trim()) || byIsin.get(upper(c.isin)) || UNKNOWN,
  };
}

async function fromCommittedFiles() {
  const [tickerMap, sectorKpis] = await Promise.all([
    revalidatedJson('data/mc-ticker-map.json', { optional: true }).catch(() => null),
    revalidatedJson('data/sector-kpis.json', { optional: true }).catch(() => null),
  ]);
  const built = buildCompanyProfiles({ tickerMap, sectorKpis });
  return { source: 'reference-files', builtAt: built.meta.tickerMapAsOf || null,
    profileOf: (c = {}) => { const p = built.profileOf(c); return { mcapCr: p.mcapCr, band: p.band, group: p.group }; } };
}

/** Load once per page; resolves when profiles are available (or could not be). Never throws. */
export function loadProfiles() {
  if (profiles) return Promise.resolve(profiles);
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch('api/announcement-index/profiles', { cache: 'no-cache', headers: { accept: 'application/json' } });
      if (response.ok && /json/.test(response.headers.get('content-type') || '')) {
        const body = await response.json();
        if (body?.ok && Array.isArray(body.rows)) profiles = fromTable(body);
      }
    } catch { /* fall back to the committed files below */ }
    if (!profiles) {
      try { profiles = await fromCommittedFiles(); } catch { profiles = null; }
    }
    if (profiles) { revision++; listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }
    return profiles;
  })().finally(() => { pending = null; });
  return pending;
}
