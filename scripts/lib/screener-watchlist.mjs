import { readWorkbook } from './xlsx-read.mjs';

const ISIN = /^INE[A-Z0-9]{9}$/;

const cell = value => String(value ?? '').trim();
const headerKey = value => cell(value).toLowerCase().replace(/[^a-z0-9]/g, '');

export function normalizeCompanyName(value) {
  return cell(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|company|co|corporation|corp|limited|ltd|plc)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function portfolioWatchlistTargets(payload) {
  if (!Array.isArray(payload?.holdings)) throw new Error('Portfolio holdings are unavailable');
  const targets = new Map();
  for (const holding of payload.holdings) {
    const isin = cell(holding?.isin).toUpperCase();
    if (holding?.listed !== true || !ISIN.test(isin)) continue;
    if (targets.has(isin)) throw new Error('Portfolio contains a duplicate listed ISIN');
    targets.set(isin, { isin, name: cell(holding.bookName || holding.name) });
  }
  if (!targets.size) throw new Error('Portfolio has no listed companies for Screener');
  return [...targets.values()].sort((a, b) => a.isin.localeCompare(b.isin));
}

function parseCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value.replace(/\r$/, ''));
      if (row.some(cell)) rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  row.push(value.replace(/\r$/, ''));
  if (row.some(cell)) rows.push(row);
  if (quoted) throw new Error('Screener CSV export has an unclosed quote');
  return rows;
}

function rowsFromExport(buffer) {
  if (buffer.subarray(0, 2).toString('ascii') === 'PK') {
    return Object.values(readWorkbook(buffer)).flatMap(rows => rows);
  }
  return parseCsv(buffer);
}

export function parseWatchlistExport(buffer) {
  const rows = rowsFromExport(buffer);
  const headerIndex = rows.findIndex((row, index) => index < 25 && row.some(value => headerKey(value) === 'isincode' || headerKey(value) === 'isin'));
  if (headerIndex < 0) throw new Error('Screener export has no ISIN column');
  const header = rows[headerIndex].map(headerKey);
  const indexOf = (...keys) => header.findIndex(value => keys.includes(value));
  const isinIndex = indexOf('isincode', 'isin');
  const nameIndex = indexOf('name', 'company', 'companyname');
  const nseIndex = indexOf('nsecode', 'nsesymbol', 'nse');
  const bseIndex = indexOf('bsecode', 'bsesymbol', 'bse');
  const records = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    const isin = cell(row[isinIndex]).toUpperCase();
    if (!ISIN.test(isin)) continue;
    if (records.has(isin)) throw new Error('Screener export contains a duplicate ISIN');
    records.set(isin, {
      isin,
      name: nameIndex >= 0 ? cell(row[nameIndex]) : '',
      nseCode: nseIndex >= 0 ? cell(row[nseIndex]).toUpperCase() : '',
      bseCode: bseIndex >= 0 ? cell(row[bseIndex]).toUpperCase() : '',
    });
  }
  return [...records.values()];
}

export function reconcileWatchlist(current, targets) {
  const currentByIsin = new Map(current.map(record => [record.isin, record]));
  const targetByIsin = new Map(targets.map(record => [record.isin, record]));
  return {
    additions: targets.filter(record => !currentByIsin.has(record.isin)),
    removals: current.filter(record => !targetByIsin.has(record.isin)),
  };
}

function symbolFromHref(href) {
  const match = /^\/company\/([^/]+)\/?/.exec(cell(href));
  return match ? decodeURIComponent(match[1]).toUpperCase() : '';
}

export function matchRemovalButtons(removals, manageRows) {
  const used = new Set();
  return removals.map(record => {
    const codes = new Set([record.nseCode, record.bseCode].filter(Boolean));
    const bySymbol = manageRows.filter(row => codes.has(symbolFromHref(row.href)));
    const wantedName = normalizeCompanyName(record.name);
    const byName = wantedName ? manageRows.filter(row => normalizeCompanyName(row.name) === wantedName) : [];
    const candidates = bySymbol.length ? bySymbol : byName;
    if (candidates.length !== 1 || used.has(candidates[0]?.companyId)) {
      throw new Error('A stale Screener company could not be matched unambiguously');
    }
    used.add(candidates[0].companyId);
    return { ...record, companyId: candidates[0].companyId };
  });
}

export function additionsCsv(additions) {
  return `ISIN Code\n${additions.map(record => record.isin).join('\n')}\n`;
}
