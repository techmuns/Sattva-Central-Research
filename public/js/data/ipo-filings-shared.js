// One record per filing/document, not per company or weekly market observation.
import { validDay } from './combined-filings-shared.js';

export const IPO_SOURCE_IDS = ['nse-equity', 'nse-sme', 'bse-sme', 'sebi-draft', 'sebi-rhp', 'sebi-final', 'sebi-other'];
export const IPO_ALL_SOURCE_IDS = [...IPO_SOURCE_IDS, 'ipo-platform'];
export const MAX_IPO_ROWS = 20000;
export const IPO_POLL_MS = 300000;
export function ipoSourceIsStale(source, now = Date.now()) {
  const at = Date.parse(source?.checkedAt), window = source?.id === 'ipo-platform' ? 2 * 60 * 60000 : IPO_POLL_MS * 2;
  return !Number.isFinite(at) || at > now + 60000 || now - at > window || source?.collectorLatestFailed === true;
}
export const ipoDisplayDay = (r) => r.filingDate || r.documentDate || null;
export function filingUrl(value, base) {
  if (!value || value === '-') return null;
  try {
    const u = new URL(value, base);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
export function ipoDay(raw) {
  if (validDay(raw)) return raw;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let y, m, d, match;
  if ((match = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i.exec(String(raw).trim()))) {
    [, d, m, y] = match; m = months.indexOf(m.toLowerCase()) + 1;
  } else if ((match = /^([a-z]{3})\s+(\d{1,2}),\s*(\d{4})$/i.exec(String(raw).trim()))) {
    [, m, d, y] = match; m = months.indexOf(m.toLowerCase()) + 1;
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw).trim()))) {
    [, d, m, y] = match;
  } else return null;
  const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return validDay(day) ? day : null;
}
export function filingType(title, fallback = 'Other document') {
  if (/corrigendum/i.test(title)) return 'Corrigendum';
  if (/addendum/i.test(title)) return 'Addendum';
  if (/\budrhp\b|updated draft/i.test(title)) return 'UDRHP';
  if (/\bdrhp\b|draft (?:red herring|prospectus|offer)/i.test(title)) return 'DRHP / Draft prospectus';
  if (/\brhp\b|red herring/i.test(title)) return 'RHP';
  if (/prospectus|final offer/i.test(title)) return 'Prospectus';
  return fallback;
}
export const ipoKey = (r) => `${r.sourceId}:${r.url || JSON.stringify([r.company, r.filingType, r.filingDate, r.title])}`;
export function mergeIpoFilings(...groups) {
  const byKey = new Map();
  for (const row of groups.flat()) {
    if (!row?.company || !row.sourceId) continue;
    const id = ipoKey(row), old = byKey.get(id);
    if (!old || (row.observedAt || '') >= (old.observedAt || '')) byKey.set(id, { ...old, ...row, id });
  }
  // An undated document is never assigned the company's draft/issue date or its URL timestamp.
  // Secondary copies of exact official URLs do not add another displayed filing.
  // Official dates win; distinct URLs/versions stay distinct rather than fuzzy name-merging.
  const officialUrls = new Set([...byKey.values()].filter((r) => r.sourceId !== 'ipo-platform' && r.url).map((r) => r.url));
  return [...byKey.values()].filter((r) => r.sourceId !== 'ipo-platform' || !officialUrls.has(r.url))
    .sort((a, b) => (ipoDisplayDay(b) || '').localeCompare(ipoDisplayDay(a) || '') || a.company.localeCompare(b.company) || a.id.localeCompare(b.id));
}
export function validateIpoRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_IPO_ROWS) throw Error('Invalid IPO filing rows');
  for (const r of rows) {
    if (typeof r.company !== 'string' || !r.company.trim() || r.company.length > 600 || typeof r.title !== 'string' || r.title.length > 1600 || ![...IPO_ALL_SOURCE_IDS, 'imported'].includes(r.sourceId) || typeof r.source !== 'string' || typeof r.filingType !== 'string' || (r.filingDate !== null && !validDay(r.filingDate)) || (r.documentDate != null && !validDay(r.documentDate)) || (r.url !== null && !filingUrl(r.url)) || !Number.isFinite(Date.parse(r.observedAt)) || (r.aliases != null && (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== 'string')))) throw Error('Invalid IPO filing record');
  }
  return rows;
}
export function validateIpoFilings(payload) {
  if (payload?.version !== 1 || !Array.isArray(payload.sources) || ![IPO_SOURCE_IDS.length, IPO_ALL_SOURCE_IDS.length].includes(payload.sources.length)) throw Error('Invalid IPO filing feed');
  if (!Number.isFinite(Date.parse(payload.checkedAt))) throw Error('Missing IPO source check date');
  validateIpoRows(payload.rows);
  for (const s of payload.sources) {
    if (!IPO_ALL_SOURCE_IDS.includes(s.id) || !['ok', 'failed'].includes(s.status) || typeof s.label !== 'string' || !Number.isFinite(Date.parse(s.checkedAt)) || typeof s.note !== 'string') throw Error('Invalid IPO source status');
  }
  const ids = new Set(payload.sources.map((s) => s.id));
  if (ids.size !== payload.sources.length || IPO_SOURCE_IDS.some((id) => !ids.has(id)) || (payload.rows.some((r) => r.sourceId === 'ipo-platform') && !ids.has('ipo-platform'))) throw Error('Incomplete IPO source manifest');
  return payload;
}

// Preserve imported history without importing stale listing status, scores or inferred finances.
export function legacyIpoFilings(snapshots, tracked = []) {
  const rows = [];
  const add = (r, observedAt, extra = {}) => {
    const url = filingUrl(r.sources?.sebi_url || r.sources?.issuer_ipo_page || r.sources?.addendum_notice || r.sources?.drhp_pdf_url);
    const fromSebi = url && new URL(url).hostname === 'www.sebi.gov.in';
    const type = filingType(r.filing_type, r.filing_type || 'Other document');
    const sourceId = fromSebi ? (type === 'Prospectus' ? 'sebi-final' : type === 'RHP' ? 'sebi-rhp' : 'sebi-draft') : 'imported';
    rows.push({ company: r.company_name, title: `${r.company_name} · ${r.filing_type || 'Filing'}`, filingType: type, filingDate: ipoDay(r.filing_date), sourceId, source: fromSebi ? 'SEBI' : 'Issuer supplement', board: null, isin: null, ticker: null, url, observedAt: new Date(observedAt).toISOString(), origin: 'imported', ...extra });
  };
  for (const s of snapshots) for (const r of s.filings || []) add(r, s.meta.data_as_of);
  for (const issuer of tracked) for (const r of issuer.filings || []) add({ ...r, company_name: issuer.company_name }, issuer.checked_at, { aliases: issuer.aliases, note: issuer.note, origin: 'supplement' });
  return mergeIpoFilings(rows);
}
