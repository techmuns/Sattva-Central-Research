import { EXCHANGE_SOURCES, exchangeDealKey, validDay, validateExchangeSnapshot } from '../../public/js/data/exchange-deals-shared.js';

export function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(field.trim()); field = ''; if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; } }
    else if (c !== '\r') field += c;
  }
  if (quoted) throw new Error('Truncated CSV export');
  if (field || row.length) { row.push(field.trim()); if (row.some(Boolean)) rows.push(row); }
  return rows;
}
const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function nseDate(value) {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(value.toUpperCase());
  if (!m || !months.includes(m[2])) throw new Error('Unrecognised NSE date');
  return `${m[3]}-${String(months.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1]}`;
}
const numeric = (s) => typeof s === 'number' ? s : /^\d[\d,]*(?:\.\d+)?$/.test(String(s)) ? Number(String(s).replace(/,/g, '')) : NaN;
export function parseExchange(text, source) {
  if (source.exchange === 'NSE') {
    const [header, ...rows] = csvRows(text);
    const required = ['Date', 'Symbol', 'Security Name', 'Client Name', 'Buy / Sell', 'Quantity Traded', 'Trade Price / Wght. Avg. Price'];
    if (!header || required.some((h) => !header.includes(h))) throw new Error('NSE did not return the complete CSV export');
    return rows.map((row) => {
      if (row.length !== header.length) throw new Error('Ragged NSE CSV record');
      const at = (name) => row[header.indexOf(name)];
      return [source.id, nseDate(at('Date')), at('Symbol'), at('Security Name'), at('Client Name'),
        ({ BUY: 'Buy', SELL: 'Sell' })[at('Buy / Sell')], numeric(at('Quantity Traded')), numeric(at('Trade Price / Wght. Avg. Price')), at('Remarks') || ''];
    });
  }
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.Table)) throw new Error('BSE did not return its historical table');
  return payload.Table.map((r) => [source.id, String(r.DEAL_DATE).slice(0, 10), String(r.SCRIP_CODE), r.scripname, r.CLIENT_NAME,
    ({ P: 'Buy', B: 'Buy', S: 'Sell' })[r.TRANSACTION_TYPE], numeric(r.QUANTITY), numeric(r.PRICE), '']);
}
export function exchangeUrl(source, from, to) {
  const format = (s, delimiter) => s.split('-').reverse().join(delimiter);
  if (source.exchange === 'NSE') return `https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=${source.id.endsWith('bulk') ? 'bulk' : 'block'}_deals&from=${format(from, '-')}&to=${format(to, '-')}&csv=true`;
  return `https://api.bseindia.com/BseIndiaAPI/api/BulkDealData_ng/w?DealType=${source.id.endsWith('bulk') ? 1 : 2}&sc_code=&FDate=${format(from, '/')}&TDate=${format(to, '/')}`;
}
export const shiftDay = (day, amount) => new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
function coverageUnion(windows) {
  const result = [];
  for (const w of windows.sort((a, b) => a.from.localeCompare(b.from))) {
    const last = result.at(-1);
    if (last && w.from <= shiftDay(last.to, 1)) last.to = last.to > w.to ? last.to : w.to;
    else result.push({ ...w });
  }
  return result;
}
/** Successful slices are authoritative (including zero rows and corrections); failed slices
 * retain their previous rows and do not advance coverage or success timestamps.
 */
export function applyExchangeSlice(snapshot, source, rows, { from, to, checkedAt, error = null }) {
  if (!validDay(from) || !validDay(to) || from > to) throw new Error('Invalid capture interval');
  const prior = snapshot.sources.find((s) => s.id === source.id) || { ...source, coverage: [] };
  const next = { ...snapshot, checkedAt, updatedAt: checkedAt, sources: snapshot.sources.filter((s) => s.id !== source.id), records: snapshot.records };
  if (error) next.sources.push({ ...prior, checkedAt, ok: false, error });
  else {
    if (rows.some((r) => r[0] !== source.id || r[1] < from || r[1] > to)) throw new Error('Exchange returned records outside the requested interval');
    const seen = new Map();
    for (const r of [...snapshot.records.filter((r) => r[0] !== source.id || r[1] < from || r[1] > to), ...rows]) seen.set(exchangeDealKey(r), r);
    next.records = [...seen.values()].sort((a, b) => b[1].localeCompare(a[1]) || exchangeDealKey(a).localeCompare(exchangeDealKey(b)));
    next.sources.push({ ...prior, ...source, coverage: coverageUnion([...prior.coverage, { from, to }]),
      checkedAt, lastSuccessAt: checkedAt, ok: true, error: null, latestDate: next.records.find((r) => r[0] === source.id)?.[1] || null });
  }
  next.sources.sort((a, b) => a.id.localeCompare(b.id));
  return validateExchangeSnapshot(next);
}
export const emptyExchangeSnapshot = (checkedAt) => ({ version: 1, checkedAt, records: [], sources: EXCHANGE_SOURCES.map((s) => ({ ...s, coverage: [], ok: false, error: 'Not captured yet' })) });

export const SECURITY_URLS = {
  nse: 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv',
  bse: 'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active',
};
export function securityMap(nseText, bseText) {
  const [headers, ...rows] = csvRows(nseText), bse = JSON.parse(bseText);
  if (!headers?.includes('ISIN NUMBER') || !headers.includes('SYMBOL') || !Array.isArray(bse) || !bse.length) throw new Error('Security master unavailable');
  const isin = new Map();
  for (const row of rows) {
    const id = row[headers.indexOf('ISIN NUMBER')], symbol = row[headers.indexOf('SYMBOL')];
    if (/^IN[A-Z0-9]{10}$/.test(id || '')) isin.set(id, isin.has(id) && isin.get(id) !== symbol ? null : symbol);
  }
  const map = {};
  for (const row of bse) if (/^\d{6}$/.test(row.SCRIP_CD) && /^IN[A-Z0-9]{10}$/.test(row.ISIN_NUMBER || '')) {
    map[row.SCRIP_CD] = { ticker: isin.get(row.ISIN_NUMBER) || row.SCRIP_CD, name: row.Scrip_Name, isin: row.ISIN_NUMBER };
  }
  if (!Object.keys(map).length) throw new Error('No verified BSE security identities');
  return map;
}
