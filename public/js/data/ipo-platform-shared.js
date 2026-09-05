import { filingUrl, ipoDay, mergeIpoFilings, validateIpoRows } from './ipo-filings-shared.js';

export const PLATFORM_ID = 'ipo-platform';
export const PLATFORM_REPO = 'techmuns/Sattva-Central-Research';
export const PLATFORM_WORKFLOW = 'ipo-platform-refresh.yml';
export const PLATFORM_ARTIFACT = 'ipo-platform-v1.json.gz';
export const PLATFORM_LIMIT = 12 * 1024 * 1024;
export const PLATFORM_COMPRESSED_LIMIT = 2 * 1024 * 1024;
export const PLATFORM_FRESH_MS = 2 * 60 * 60000;
export const PLATFORM_MAX_COMPANIES = 10000;
export const PLATFORM_URL = 'https://www.ipoplatform.com/ipo';

export function platformCompanyId(url) {
  const safe = filingUrl(url);
  if (!safe) return null;
  const u = new URL(safe), match = /^\/ipo\/[^/]+\/(\d+)$/.exec(u.pathname);
  return u.hostname === 'www.ipoplatform.com' && !u.port && match ? match[1] : null;
}
export function validatePlatformCompanies(companies) {
  if (!Array.isArray(companies) || companies.length > PLATFORM_MAX_COMPANIES) throw Error('Invalid IPO directory');
  const ids = new Set();
  for (const c of companies) {
    if (!c || typeof c.id !== 'string' || c.id !== platformCompanyId(c.url) || ids.has(c.id)
      || typeof c.company !== 'string' || !c.company.trim() || c.company.length > 600
      || !['SME', 'Mainboard'].includes(c.board) || !Number.isFinite(Date.parse(c.observedAt))
      || typeof c.retained !== 'boolean') throw Error('Invalid IPO directory company');
    ids.add(c.id);
    for (const key of ['listingDate', 'openingDate', 'closingDate', 'draftDate', 'refiledDate']) {
      if (c[key] != null && ipoDay(c[key]) !== c[key]) throw Error('Invalid IPO directory date');
    }
    for (const key of ['status', 'drhpStatus', 'exchange', 'openingWindow', 'sector', 'isin', 'ticker', 'publisherUpdatedAt']) {
      if (c[key] != null && (typeof c[key] !== 'string' || c[key].length > 600)) throw Error('Invalid IPO directory field');
    }
  }
  return companies;
}
export function mergePlatformCompanies(...groups) {
  const byId = new Map();
  for (const c of groups.flat()) {
    const old = byId.get(c.id);
    if (!old || c.observedAt >= old.observedAt) byId.set(c.id, { ...old, ...c });
  }
  return [...byId.values()].sort((a, b) => (b.listingDate || b.draftDate || '').localeCompare(a.listingDate || a.draftDate || '') || a.company.localeCompare(b.company));
}
export function validatePlatformCapture(capture, now = Date.now()) {
  const at = Date.parse(capture?.checkedAt);
  if (capture?.version !== 1 || capture.sourceId !== PLATFORM_ID || !Number.isFinite(at) || at > now + 60000
    || !capture.counts || !['sme', 'mainboard', 'dashboard', 'smeDrafts', 'mainboardDrafts'].every((k) => Number.isSafeInteger(capture.counts[k]) && capture.counts[k] > 0)) throw Error('Invalid IPOPlatform capture');
  validatePlatformCompanies(capture.companies); validateIpoRows(capture.rows);
  if (!capture.companies.length || capture.rows.some((r) => r.sourceId !== PLATFORM_ID || r.origin !== 'secondary' || r.filingDate !== null || Date.parse(r.observedAt) > at)
    || capture.companies.some((c) => Date.parse(c.observedAt) > at)
    || mergeIpoFilings(capture.rows).length !== capture.rows.length) throw Error('Invalid IPOPlatform history');
  return capture;
}
export function mergePlatformCapture(current, previous = null) {
  if (previous) {
    validatePlatformCapture(previous);
    for (const key of Object.keys(previous.counts)) {
      if (current.counts[key] < previous.counts[key] * 0.9) throw Error(`IPOPlatform ${key} shrank by more than 10%; publication blocked`);
    }
    current = { ...current,
      rows: mergeIpoFilings(previous.rows, current.rows),
      companies: mergePlatformCompanies(previous.companies.map((c) => ({ ...c, retained: true })), current.companies),
    };
  }
  return validatePlatformCapture(current);
}
