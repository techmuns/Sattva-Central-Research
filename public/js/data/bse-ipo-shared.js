import { validateIpoRows } from './ipo-filings-shared.js';
export const BSE_ARTIFACT_NAME = 'bse-ipo-v1.json.gz';
export const BSE_COLLECTOR_WORKFLOW = 'bse-ipo-refresh.yml';
export const BSE_COLLECTOR_REPO = 'techmuns/Sattva-Central-Research';
export const BSE_CAPTURE_LIMIT = 4 * 1024 * 1024;
export const BSE_COMPRESSED_LIMIT = 1024 * 1024;

export function validateBseCapture(value, now = Date.now()) {
  const at = Date.parse(value?.checkedAt);
  if (value?.version !== 1 || value.sourceId !== 'bse-sme' || !Number.isFinite(at) || at > now + 60000 || now - at > 2 * 86400000
    || !Number.isSafeInteger(value.records) || value.records < 1 || value.records > 10000 || value.unmapped !== 0
    || typeof value.note !== 'string' || value.note.length > 2000) throw Error('Invalid or expired BSE capture');
  validateIpoRows(value.rows);
  if (!value.rows.length || value.rows.length > 10000 || new Set(value.rows.map((r) => r.url)).size !== value.rows.length
    || value.rows.some((r) => r.sourceId !== 'bse-sme' || r.source !== 'BSE SME' || r.board !== 'SME' || r.origin !== 'official' || r.observedAt !== value.checkedAt
      || !r.url || !['www.bseindia.com', 'www.bsesme.com'].includes(new URL(r.url).hostname))) throw Error('Invalid BSE capture records');
  return value;
}
