// Pure NSE corporate-action parsing shared by the scheduled capture and the browser.

const MONTHS = new Map(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [m.toLowerCase(), i + 1]));

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

export const corporateActionKey = (row) => [
  row.isin || row.ticker || '', row.series || '', row.exDate || '', row.recordDate || '', row.purpose || '',
].join('|');

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
