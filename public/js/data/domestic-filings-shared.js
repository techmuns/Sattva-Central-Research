// Document metadata only. PDFs do not supply structured financials or analyst consensus.
export const DOMESTIC_FORMS = Object.freeze({
  all: 'All documents', concalls: 'Concall transcripts', annual_report: 'Annual reports', earnings_report: 'Earnings reports',
});

export function documentUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const keyOf = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const forms = { concalls: 'concalls', concall: 'concalls', transcripts: 'concalls', transcript: 'concalls',
  annualreport: 'annual_report', annualreports: 'annual_report', earningsreport: 'earnings_report', earningsreports: 'earnings_report', results: 'earnings_report' };
const linkKeys = ['url', 'link', 'href', 'pdf', 'pdfurl', 'documenturl', 'attachment', 'downloadurl', 'transcripturl', 'reporturl'];
const pick = (row, keys) => Object.entries(row).find(([key, value]) => keys.includes(keyOf(key)) && typeof value === 'string' && value.trim())?.[1] || null;

/** Accept link records, grouped arrays, and wrappers; never turn an unknown/error object into no filings. */
export function normaliseDomesticFilings(body, ticker, requestedForm = 'all') {
  const documents = [];
  const seen = new Set();
  let recognized = false;
  let skipped = 0;
  let unavailableLinks = 0;
  const unreadableShapes = new Map();
  function skip(value) {
    skipped++;
    // Bounded field/type diagnostics let an operator investigate source-shape changes without
    // returning unknown record values or mistaking a partial parse for complete coverage.
    const shape = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key.slice(0, 80), item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item]))
      : { value: value === null ? 'null' : typeof value };
    const key = JSON.stringify(shape);
    if (unreadableShapes.size < 5 || unreadableShapes.has(key)) unreadableShapes.set(key, { fields: shape, count: (unreadableShapes.get(key)?.count || 0) + 1 });
  }
  function add(url, context) {
    const safe = documentUrl(url);
    if (!safe) { skipped++; return; }
    const form = context.form || (requestedForm === 'all' ? null : requestedForm);
    const key = `${form || ''}|${safe}`;
    if (seen.has(key)) return;
    seen.add(key);
    documents.push({ ticker, form, title: context.title || DOMESTIC_FORMS[form] || 'Company filing', date: context.date || null, url: safe, source: 'Screener.in via Muns' });
  }
  function walk(value, context = {}, depth = 0) {
    if (depth > 12) { skipped++; return; }
    if (Array.isArray(value)) {
      recognized = true;
      for (const row of value) walk(row, context, depth + 1);
      return;
    }
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) { recognized = true; add(value, context); }
      else if (value.trim()) skipped++;
      return;
    }
    if (!value || typeof value !== 'object') { skip(value); return; }
    if (value.ok === false || value.success === false || value.error) throw new Error('The filings service returned an error response.');
    const next = {
      ...context,
      form: forms[keyOf(pick(value, ['form', 'type', 'category']) || '')] || context.form,
      title: pick(value, ['title', 'name', 'label', 'description', 'text']) || context.title,
      date: pick(value, ['date', 'publishedat', 'publisheddate', 'filingdate', 'period', 'year']) || context.date,
    };
    let handled = false;
    for (const [key, item] of Object.entries(value)) {
      const name = keyOf(key);
      // The live Screener response lists historical periods with a null transcript slot.
      // Preserve that availability count separately from a record the parser cannot understand.
      if ((forms[name] || linkKeys.includes(name)) && item === null) {
        handled = true;
        unavailableLinks++;
      } else if (linkKeys.includes(name) && typeof item === 'string') {
        recognized = handled = true;
        add(item, next);
      } else if (forms[name] || ['data', 'result', 'documents', 'filings', 'items', 'reports'].includes(name)) {
        recognized = handled = true;
        walk(item, { ...next, form: forms[name] || next.form }, depth + 1);
      }
    }
    if (!handled) skip(value);
  }
  walk(body);
  if (!recognized || (skipped && !documents.length)) throw new Error('The filings service returned an unfamiliar document format; no empty result has been assumed.');
  return { documents, skipped, unavailableLinks, unreadableShapes: [...unreadableShapes.values()] };
}

export function domesticFilingsHref(ticker, { form = 'all', scope = 'universe' } = {}) {
  const params = new URLSearchParams({ scope, view: 'filings', form, company: ticker });
  return `#/research/earnings-hub?${params}`;
}

// Compare the reported period, never the publication day or array order. A missing
// quarter cannot silently send a reader to an older report or an annual document.
function reportPeriod(value) {
  const text = String(value || '').trim();
  const named = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4}|\d{2})$/i.exec(text);
  if (named) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[1].slice(0, 3).toLowerCase()) + 1;
    const year = named[2].length === 2 ? `20${named[2]}` : named[2];
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  return /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(text)?.slice(1, 3).join('-') || null;
}

export function earningsReportDocument(documents, ticker, period) {
  const wanted = reportPeriod(period);
  if (!wanted) return null;
  return [...(documents || [])].reverse().find(row =>
    row.ticker === ticker && row.form === 'earnings_report' &&
    reportPeriod(row.date) === wanted && documentUrl(row.url)) || null;
}

/** Prefer the exchange's actual result attachment over a publisher's redirect/index link. */
export function earningsAnnouncementDocument(rows, ticker, period, resultDate) {
  const wanted = reportPeriod(period);
  if (!wanted || !/^\d{4}-\d{2}-\d{2}$/.test(resultDate || '')) return null;
  const [year, month] = wanted.split('-');
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1];
  const namedPeriod = new RegExp(`\\b${monthName}[a-z]*\\s+(?:[0-3]?\\d(?:st|nd|rd|th)?[,\\s]+)?${year}\\b`, 'i');
  const candidates = (rows || []).filter(row => {
    if (row.ticker !== ticker || row.date !== resultDate || !documentUrl(row.url) || !/\.pdf(?:[?#]|$)/i.test(row.url)) return false;
    const text = [row.title, row.subject, row.headline, row.summary, row.description].filter(Boolean).join(' ');
    if (!/financial\s+results/i.test(text)) return false;
    if (/board meeting intimation|trading window|newspaper|press release|presentation|earnings call|transcript|audio|video/i.test(text)) return false;
    return namedPeriod.test(text) || text.includes(`${year}-${month}-`);
  });
  // Dedicated result disclosures outrank a board outcome containing the same figures.
  candidates.sort((a, b) => Number(b.category === 'Result') - Number(a.category === 'Result'));
  return candidates[0] || null;
}

// BSE moves attachments between live and historical directories. Its stable
// PDF reader resolves the same captured filename without changing document identity.
export function earningsDocumentUrl(value) {
  const safe = documentUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  const attachment = /^\/xml-data\/corpfiling\/Attach(?:Live|His)\/([a-f0-9-]{36}\.pdf)$/i.exec(url.pathname);
  return /^(?:www\.)?bseindia\.com$/i.test(url.hostname) && attachment
    ? `https://www.bseindia.com/stockinfo/AnnPdfOpen.aspx?Pname=${attachment[1]}` : safe;
}
