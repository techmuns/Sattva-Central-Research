// Pure corporate-action parsing and cross-source merge rules shared by the scheduled capture,
// browser and contract tests. NSE remains the official base; Screener can enrich or add rows.

const MONTHS = new Map(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [m.toLowerCase(), i + 1]));

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SCREENER_TYPES = new Set(['bonus', 'rights', 'split', 'buyback', 'dividend']);
const SCREENER_FIELDS = [
  'ratio', 'premium', 'oldFaceValue', 'newFaceValue', 'endDate', 'offerType', 'maxPrice',
  'amountCrore', 'dividendType', 'percent',
];

/** NSE writes action dates as 04-Sep-2026. Invalid and missing values remain unknown. */
export function parseNseActionDate(value) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(clean(value, 24));
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export function corporateActionType(subject) {
  const text = clean(subject).toLowerCase();
  if (/\bbonus\b/.test(text)) return 'bonus';
  if (/\bright(?:s)?\b/.test(text)) return 'rights';
  if (/\bbuy\s*-?\s*back\b|\bbuyback\b/.test(text)) return 'buyback';
  if (/\bsplit\b|\bsub[- ]?division\b/.test(text)) return 'split';
  if (/\bdemerger\b|\bde[- ]merger\b/.test(text)) return 'demerger';
  if (/\bdistribution\b/.test(text)) return 'distribution';
  // NSE contains a handful of concatenated source strings such as `Interimdividend` and
  // `Meetingdividend`. They still explicitly say dividend and must not fall into Other.
  if (/dividend/.test(text)) return 'dividend';
  if (/\binterest\b/.test(text)) return 'interest';
  if (/\bredemption\b/.test(text)) return 'redemption';
  if (/\bcapital reduction\b|\bconsolidation of (?:equity )?shares\b/.test(text)) return 'capital-reduction';
  return 'other';
}

export const corporateActionKey = (row) => row?.id || [
  row?.isin || row?.ticker || '', row?.series || '', row?.exDate || '', row?.recordDate || '', row?.purpose || '',
].join('|');

export const screenerActionKey = (row) => [
  clean(row?.companyKey, 80).toUpperCase(), row?.actionType || '', row?.exDate || '',
  row?.actionType === 'dividend' ? clean(row?.dividendType, 80).toLowerCase() : '',
].join('|');

export function screenerActionDetails(row) {
  if (!row) return '';
  if (row.actionType === 'bonus') return row.ratio ? `Ratio ${row.ratio}` : '';
  if (row.actionType === 'rights') return [row.ratio && `Ratio ${row.ratio}`, row.premium && `Premium ₹${row.premium}`].filter(Boolean).join(' · ');
  if (row.actionType === 'split') return row.oldFaceValue && row.newFaceValue ? `Face value ₹${row.oldFaceValue} → ₹${row.newFaceValue}` : '';
  if (row.actionType === 'buyback') return [row.offerType, row.maxPrice && `Max ₹${row.maxPrice}`, row.amountCrore && `₹${row.amountCrore} Cr`].filter(Boolean).join(' · ');
  if (row.actionType === 'dividend') return [row.dividendType, row.percent && `${row.percent}%`].filter(Boolean).join(' · ');
  return '';
}

function screenerPurpose(row) {
  const label = { bonus: 'Bonus', rights: 'Rights issue', split: 'Stock split', buyback: 'Buyback', dividend: 'Dividend' }[row.actionType] || 'Corporate action';
  const details = screenerActionDetails(row);
  return details ? `${label} · ${details}` : label;
}

function safeScreenerUrl(value, route) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['www.screener.in', 'screener.in'].includes(url.hostname) && route.test(url.pathname);
  } catch { return false; }
}

export function validateScreenerActionRows(rows) {
  if (!Array.isArray(rows) || rows.length > 50000) throw new Error('Invalid Screener corporate-action rows.');
  const ids = new Set();
  for (const row of rows) {
    const id = screenerActionKey(row);
    if (!row || !clean(row.companyKey, 80) || !clean(row.company, 300) || !SCREENER_TYPES.has(row.actionType) ||
        !DAY.test(row.exDate || '') || (row.endDate && !DAY.test(row.endDate)) ||
        !safeScreenerUrl(row.companyUrl, /^\/company\/(?:id\/)?[^/]+\/(?:consolidated\/)?$/) ||
        !safeScreenerUrl(row.sourceUrl, /^\/actions\/(?:bonus|right|split|buyback|dividend)\/$/) ||
        (row.ticker && !/^[A-Z0-9&._-]{1,80}$/.test(row.ticker)) || ids.has(id)) {
      throw new Error('Invalid or duplicate Screener corporate-action row.');
    }
    for (const field of SCREENER_FIELDS) if (row[field] != null && (typeof row[field] !== 'string' || row[field].length > 120)) throw new Error('Invalid Screener corporate-action field.');
    ids.add(id);
  }
  return rows;
}

export function mergeScreenerActionRows(...groups) {
  const rows = new Map();
  for (const row of groups.flat()) {
    if (!row) continue;
    const id = screenerActionKey(row);
    const old = rows.get(id);
    if (!old || String(row.observedAt || '') >= String(old.observedAt || '')) rows.set(id, { ...old, ...row, id });
  }
  return [...rows.values()].sort((a, b) => b.exDate.localeCompare(a.exDate) || a.company.localeCompare(b.company) || a.actionType.localeCompare(b.actionType));
}

const matchKey = (row) => row?.ticker && row?.actionType && row?.exDate
  ? `${String(row.ticker).toUpperCase()}|${row.actionType}|${row.exDate}`
  : null;

/**
 * Merge only an unambiguous one-to-one ticker/type/ex-date pair. Ambiguous pairs remain separate;
 * a source is never discarded merely because its company and date look similar.
 */
export function mergeCorporateActionRows(nseRows = [], screenerRows = []) {
  const nse = [...new Map(nseRows.map((row) => [corporateActionKey(row), { ...row, sources: ['NSE'] }])).values()];
  const screener = mergeScreenerActionRows(screenerRows);
  const nseBuckets = new Map();
  const screenerBuckets = new Map();
  for (const row of nse) {
    const key = matchKey(row);
    if (!key) continue;
    if (!nseBuckets.has(key)) nseBuckets.set(key, []);
    nseBuckets.get(key).push(row);
  }
  for (const row of screener) {
    const key = matchKey(row);
    if (!key) continue;
    if (!screenerBuckets.has(key)) screenerBuckets.set(key, []);
    screenerBuckets.get(key).push(row);
  }

  const consumed = new Set();
  const merged = nse.map((row) => {
    const key = matchKey(row);
    const matches = key ? screenerBuckets.get(key) || [] : [];
    if ((nseBuckets.get(key) || []).length !== 1 || matches.length !== 1) return row;
    const extra = matches[0];
    consumed.add(screenerActionKey(extra));
    return {
      ...row,
      source: 'NSE + Screener',
      sources: ['NSE', 'Screener'],
      screenerUrl: extra.sourceUrl,
      screenerCompanyUrl: extra.companyUrl,
      screener: extra,
    };
  });

  for (const row of screener) {
    if (consumed.has(screenerActionKey(row))) continue;
    const id = `screener:${screenerActionKey(row)}`;
    merged.push({
      id,
      ticker: row.ticker || null,
      company: row.company,
      isin: null,
      series: null,
      purpose: screenerPurpose(row),
      purposeSource: 'Derived from Screener fields',
      actionType: row.actionType,
      faceValue: row.actionType === 'split' ? row.newFaceValue || null : null,
      exDate: row.exDate,
      recordDate: null,
      bookClosureStart: null,
      bookClosureEnd: null,
      source: 'Screener',
      sources: ['Screener'],
      sourceUrl: row.sourceUrl,
      screenerUrl: row.sourceUrl,
      screenerCompanyUrl: row.companyUrl,
      screener: row,
    });
  }
  return merged.sort((a, b) => String(b.exDate || b.recordDate || '').localeCompare(String(a.exDate || a.recordDate || '')) || String(a.ticker || a.company).localeCompare(String(b.ticker || b.company)));
}

export function extractScreenerActionRows(rows = []) {
  return mergeScreenerActionRows(rows.map((row) => row?.screener).filter(Boolean));
}

/**
 * Refuse a plausible-looking partial response before it replaces retained history.
 *
 * NSE returns this calendar as one array rather than paginated pages, so a sudden loss of more
 * than a quarter of its rows or companies is not normal rolling-window expiry. Keeping the prior
 * file is safer than publishing a truncated array as a complete exchange-wide answer.
 */
export function assertSafeCorporateActionReplacement(next, previous = null) {
  if (!next?.rows?.length) throw new Error('Corporate actions capture contained no usable rows.');
  if (previous?.version !== 1 || !Array.isArray(previous.rows) || previous.rows.length < 100) return next;
  const nextCompanies = new Set(next.rows.map((row) => row.ticker).filter(Boolean)).size;
  const previousCompanies = new Set(previous.rows.map((row) => row.ticker).filter(Boolean)).size;
  if (next.rows.length < previous.rows.length * 0.75 || nextCompanies < previousCompanies * 0.75) {
    throw new Error(`NSE corporate actions response shrank abnormally (${next.rows.length}/${previous.rows.length} rows; ${nextCompanies}/${previousCompanies} companies); previous capture retained.`);
  }
  return next;
}

export function normaliseNseCorporateActions(payload) {
  if (!Array.isArray(payload)) throw new Error('NSE corporate actions response was not an array.');
  const rows = [];
  let skipped = 0;
  let excludedMeetings = 0;
  for (const source of payload) {
    const ticker = clean(source?.symbol, 80).toUpperCase();
    const company = clean(source?.comp, 240);
    const purpose = clean(source?.subject, 1000);
    if (!ticker || !company || !purpose || !/^[A-Z0-9&._-]+$/.test(ticker)) {
      skipped++;
      continue;
    }
    const isin = /^IN[A-Z0-9]{10}$/.test(clean(source?.isin, 20).toUpperCase()) ? clean(source.isin, 20).toUpperCase() : null;
    const actionType = corporateActionType(purpose);
    // The endpoint also returns meeting-only diary entries. They are valid NSE records but are not
    // corporate actions and would bury the useful feed under more than a thousand AGM rows. A
    // meeting row that also explicitly names a dividend was classified above and remains visible.
    if (actionType === 'other' && /\b(?:annual general meeting|extra[\s-]*ordinary general meeting|extra annual general meeting)\b/i.test(purpose)) {
      excludedMeetings++;
      continue;
    }
    const row = {
      ticker,
      company,
      isin,
      series: clean(source?.series, 30) || null,
      purpose,
      actionType,
      faceValue: clean(source?.faceVal, 40) || null,
      exDate: parseNseActionDate(source?.exDate),
      recordDate: parseNseActionDate(source?.recDate),
      bookClosureStart: parseNseActionDate(source?.bcStartDate),
      bookClosureEnd: parseNseActionDate(source?.bcEndDate),
      source: 'NSE',
      sourceUrl: `https://www.nseindia.com/companies-listing/corporate-filings-actions?symbol=${encodeURIComponent(ticker)}&tabIndex=equity`,
    };
    row.id = corporateActionKey(row);
    rows.push(row);
  }

  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  unique.sort((a, b) => String(b.exDate || b.recordDate || '').localeCompare(String(a.exDate || a.recordDate || '')) || a.ticker.localeCompare(b.ticker));
  return { rows: unique, skipped, excludedMeetings, duplicates: rows.length - unique.length };
}
