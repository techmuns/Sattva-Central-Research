// data/company-profiles.js — MARKET CAP, SIZE BAND AND SECTOR FOR A COMPANY, IN THE BROWSER.
//
// News and All Alerts rank within each day by relevance (relevance.js), and size and sector are two
// of its inputs. The announcement index already holds both for every company it knows, so the
// browser asks it for one compact table (GET /api/announcement-index/profiles, ~100 KB).
// Filing issuers are only part of the directory, so supplement it lazily from the public market-cap
// capture, Moneycontrol map and sector file, retaining each component through failures.
// NOT technicals.json: it is a
// 2.8 MB pooled capture, and All Alerts on Today reads the alert pool precisely so that no capture
// is downloaded (verify-alert-pool-ui.mjs asserts it). A band from the map's figure can differ from
// the index's Screener figure near a band edge; that is a fallback's precision, never a missing row.
//
// A COMPANY THIS CANNOT PLACE IS SIZE "UNKNOWN", never small and never zero. Its items stay in the
// list; the ranking reads it exactly as the index does.
import { buildCompanyProfiles } from './company-profile.js';
import { profileTable, mergeProfileLookups, UNKNOWN_PROFILE as UNKNOWN } from './company-profile-table.js';
import { revalidatedJson } from '../core/store.js';

let profiles = null; // { profileOf, source, builtAt }
let pending = null;
let checkedAt = 0;
let revision = 0;
let indexProfiles = null, directoryProfiles = null;
const referenceInputs = { tickerMap: null, sectorKpis: null, marketCaps: null };
const listeners = new Set();
let refreshTimer = null;
const checkVisible = () => { if (listeners.size && document.visibilityState === 'visible') void loadProfiles(); };

function watchVisibleProfiles() {
  if (refreshTimer !== null || typeof document === 'undefined') return;
  refreshTimer = setInterval(checkVisible, 60_000);
  document.addEventListener('visibilitychange', checkVisible);
  window.addEventListener('focus', checkVisible);
  window.addEventListener('pageshow', checkVisible);
}
function stopVisibleProfiles() {
  if (listeners.size || refreshTimer === null) return;
  clearInterval(refreshTimer); refreshTimer = null;
  document.removeEventListener('visibilitychange', checkVisible);
  window.removeEventListener('focus', checkVisible);
  window.removeEventListener('pageshow', checkVisible);
}

export const onChange = fn => { listeners.add(fn); watchVisibleProfiles(); return () => { listeners.delete(fn); stopVisibleProfiles(); }; };
export const profilesRevision = () => revision;
export const profilesSource = () => profiles?.source || null;

/** The profile for a company, or UNKNOWN while the table is loading or when the company is unknown. */
export function profileOf(company = {}) {
  return profiles ? profiles.profileOf(company) : UNKNOWN;
}

async function fromCommittedFiles() {
  const values = await Promise.all([
    revalidatedJson('data/mc-ticker-map.json', { optional: true, fresh: true }).catch(() => null),
    revalidatedJson('data/sector-kpis.json', { optional: true, fresh: true }).catch(() => null),
    revalidatedJson('data/market-caps.json', { optional: true, fresh: true }).catch(() => null),
  ]);
  for (const [i, key] of ['tickerMap', 'sectorKpis', 'marketCaps'].entries()) if (values[i]) referenceInputs[key] = values[i];
  const { tickerMap, sectorKpis, marketCaps } = referenceInputs;
  const built = buildCompanyProfiles({ tickerMap, sectorKpis, marketCaps });
  if ((!tickerMap && !marketCaps) || (directoryProfiles && !marketCaps)) return null;
  return { source: 'reference-files', builtAt: built.meta.marketCapsAsOf || built.meta.tickerMapAsOf || null,
    revisionKey: built.meta.profileInputsRevision,
    profileOf: (c = {}) => { const p = built.profileOf(c); return { mcapCr: p.mcapCr, band: p.band, group: p.group }; } };
}

function publishProfiles() {
  if (!indexProfiles && !directoryProfiles) return;
  const next = mergeProfileLookups(indexProfiles, directoryProfiles);
  if (!profiles || next.revisionKey !== profiles.revisionKey) {
    profiles = next; revision++; listeners.forEach(fn => { try { fn(); } catch { /* reader's own error */ } });
  }
}

/** Revalidate when used after fifteen minutes; retain saved profiles through failures. Never throws. */
export function loadProfiles() {
  if (profiles && Date.now() - checkedAt < 15 * 60_000) return Promise.resolve(profiles);
  if (pending) return pending;
  pending = (async () => {
    checkedAt = Date.now();
    const directoryRead = fromCommittedFiles().catch(() => null);
    try {
      const response = await fetch('api/announcement-index/profiles', { cache: 'no-cache', headers: { accept: 'application/json' } });
      if (response.ok && /json/.test(response.headers.get('content-type') || '')) {
        const body = await response.json();
        if (body?.ok && Array.isArray(body.rows) && body.rows.length) indexProfiles = profileTable(body);
      }
    } catch { /* fall back to the committed files below */ }
    publishProfiles(); // Filing issuers are usable while the larger lazy supplement is prepared.
    // Even a successful index only knows its filing issuers. Supplement the full directory,
    // and keep each last-good component when its own revalidation fails.
    const nextDirectory = await directoryRead;
    if (nextDirectory) directoryProfiles = nextDirectory;
    publishProfiles();
    return profiles;
  })().finally(() => { pending = null; });
  return pending;
}
