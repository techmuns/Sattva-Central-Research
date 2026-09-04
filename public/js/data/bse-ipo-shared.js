import { ipoKey, mergeIpoFilings, validateIpoRows } from './ipo-filings-shared.js';
export const BSE_ARTIFACT_NAME = 'bse-ipo-v1.json.gz';
export const BSE_COLLECTOR_WORKFLOW = 'bse-ipo-refresh.yml';
export const BSE_COLLECTOR_REPO = 'techmuns/Sattva-Central-Research';
export const BSE_CAPTURE_LIMIT = 4 * 1024 * 1024;
export const BSE_COMPRESSED_LIMIT = 1024 * 1024;
export const BSE_RETENTION_MS = 7 * 86400000;

export function validateBseCapture(value, now = Date.now()) {
  const at = Date.parse(value?.checkedAt);
  if (value?.version !== 2 || value.sourceId !== 'bse-sme' || !Number.isFinite(at) || at > now + 60000 || now - at > BSE_RETENTION_MS
    || !Number.isSafeInteger(value.records) || value.records < 1 || value.records > 10000 || value.unmapped !== 0
    || !Number.isSafeInteger(value.currentCount) || value.currentCount < 1 || !Number.isSafeInteger(value.retainedCount) || value.retainedCount < 0
    || typeof value.note !== 'string' || value.note.length > 2000) throw Error('Invalid or expired BSE capture');
  validateIpoRows(value.rows);
  if (!value.rows.length || value.rows.length > 10000 || new Set(value.rows.map(ipoKey)).size !== value.rows.length
    || value.currentCount + value.retainedCount !== value.rows.length
    || value.rows.filter((r) => r.observedAt === value.checkedAt).length !== value.currentCount
    || value.rows.some((r) => r.sourceId !== 'bse-sme' || r.source !== 'BSE SME' || r.board !== 'SME' || r.origin !== 'official' || Date.parse(r.observedAt) > at
      || !r.url || !['www.bseindia.com', 'www.bsesme.com'].includes(new URL(r.url).hostname))) throw Error('Invalid BSE capture records');
  return value;
}

// Append observations, not rows: replaying a capture is idempotent. Removed links stay
// retained with their old observation time; a page read never re-dates unseen history.
export function mergeBseCapture({ parsed, checkedAt, previous = null, baseline = [] }) {
  const now = Date.parse(checkedAt);
  if (previous) validateBseCapture(previous, now);
  validateIpoRows(baseline);
  if (baseline.some((r) => r.sourceId !== 'bse-sme')) throw Error('Invalid BSE history seed');
  const current = mergeIpoFilings(parsed.rows);
  const recordsFloor = previous?.records || new Set(baseline.map((r) => r.company)).size;
  // The publisher's full-history table should not abruptly become a small window.
  // A large shrink needs investigation, not an automatically "successful" capture.
  if (recordsFloor && parsed.records < recordsFloor * 0.9) throw Error('BSE issuer table shrank by more than 10%; previous capture retained');
  const rows = mergeIpoFilings(baseline, previous?.rows || [], current);
  return validateBseCapture({ ...parsed, version: 2, sourceId: 'bse-sme', checkedAt, rows,
    currentCount: current.length, retainedCount: rows.length - current.length }, now);
}
