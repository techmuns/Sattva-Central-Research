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
