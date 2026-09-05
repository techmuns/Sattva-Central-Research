// data/stockscans-shared.js — the StockScans vocabulary and normalisers.
//
// PURE. No fetch, no Node, no Cloudflare, no DOM. It lives under public/ because the browser
// needs it, and worker/stockscans.mjs imports it from here so there is exactly ONE definition of
// the tier bands and the row shape. Two copies would drift, and the first symptom would be the
// dashboard showing a different label from StockScans for the same score.
//
// THE SCORES AND BANDS ARE STOCKSCANS', NOT OURS
//   `resultScore` (0-100), `sentimentTier` (0-4) and the `tags` bullets are their analysis. The
//   cut-points below are lifted from their own client so a label we render is the label they
//   render. Inventing our own bands would be presenting our judgement under their name.

export const SS_BASE = 'https://www.stockscans.in';
export const SCAN_URL = `${SS_BASE}/api/company/concall-scan`;
export const UPCOMING_URL = `${SCAN_URL}/upcoming`;
export const TODAY_URL = `${SCAN_URL}/today`;
export const PAGE_SIZE = 50;

/** StockScans' own tier vocabulary. Do not re-band these — see the header. */
export const RESULT_TIERS = [
  { min: 80, label: 'Excellent', tone: 'excellent' },
  { min: 60, label: 'Strong', tone: 'green' },
  { min: 40, label: 'Average', tone: 'grey' },
  { min: 20, label: 'Weak', tone: 'amber' },
  { min: -Infinity, label: 'Poor', tone: 'red' },
];
export const SENTIMENT_TIERS = {
  4: { label: 'Bullish', tone: 'excellent' },
  3: { label: 'Optimistic', tone: 'green' },
  2: { label: 'Neutral', tone: 'grey' },
  1: { label: 'Cautious', tone: 'amber' },
  0: { label: 'Bearish', tone: 'red' },
};

/** A 0-100 result score -> StockScans' own label. Null in, null out — never "Poor" for missing. */
export function resultTierOf(score) {
  if (score == null || Number.isNaN(score)) return null;
  return RESULT_TIERS.find((t) => score >= t.min) || null;
}
export function sentimentTierOf(tier) {
  return SENTIMENT_TIERS[tier] ?? null;
}

/**
 * One positional row -> an object. Field order is StockScans':
 *   [companyKey, companyId, name, industry, when, ssUrl, src, notesReady,
 *    resultScore, sentimentTier, tags[], pptSsUrl]
 */
export function normaliseScanRow(r) {
  if (!Array.isArray(r) || r.length < 5) return null;
  const companyId = String(r[1] || ''); // "NSE:EPL"
  const ticker = companyId.includes(':') ? companyId.split(':')[1] : companyId || null;
  const when = r[4] || null;
  return {
    companyKey: String(r[0] ?? ''),
    companyId,
    ticker: ticker || null,
    exchange: companyId.includes(':') ? companyId.split(':')[0] : null,
    name: String(r[2] || ''),
    industry: r[3] || null,
    when,
    date: typeof when === 'string' ? when.slice(0, 10) : null,
    // The document keys are pointers into StockScans' own reader, not files we can serve. They
    // become deep links back to them — see `docUrl`.
    ssUrl: r[5] || null,
    pptSsUrl: r[11] || null,
    src: r[6] ?? null,
    // Their flag for "the summary has been produced". A row can exist with the call scheduled and
    // nothing analysed yet, which is why the score can be null and must render as pending.
    notesReady: r[7] === true,
    resultScore: typeof r[8] === 'number' ? r[8] : null,
    sentimentTier: typeof r[9] === 'number' ? r[9] : null,
    tags: Array.isArray(r[10]) ? r[10] : [],
  };
}

/** [companyKey, companyId, name, when, flag?] — the schedule rows, which carry no analysis. */
export function normaliseScheduleRow(r) {
  if (!Array.isArray(r) || r.length < 4) return null;
  const companyId = String(r[1] || '');
  return {
    companyKey: String(r[0] ?? ''),
    companyId,
    ticker: companyId.includes(':') ? companyId.split(':')[1] : companyId || null,
    name: String(r[2] || ''),
    when: r[3] || null,
    date: typeof r[3] === 'string' ? r[3].slice(0, 10) : null,
  };
}

/**
 * Deep link to the provider's own reader for a summary document.
 *
 * THE PERIOD SEGMENT IS NOT OPTIONAL, WHICH IS WHY THIS IS NOT THE COMPANY ROUTE
 *   Their company route is `/company/<companyId>/<type>/<period>/<file>` and every segment is
 *   required — their own builder returns an empty string rather than a URL when one is missing.
 *   This function used to treat `period` as optional and no caller ever had one to pass, because
 *   the scan payload does not carry a period at all. So every row's link was built one segment
 *   short and EVERY "open the transcript" click landed on their 404 page. It looked like a link
 *   and behaved like a link; it had simply never resolved.
 *
 *   Their reader has a second entrance that takes nothing but the document key —
 *   `/document/<file>` — and it is the one their own transcript button uses. It needs only what
 *   the payload actually contains, so it cannot be built short. Verified 200 against their live
 *   site for both a con-call key and a slide-deck key; the old shape returns 404 for the same
 *   document.
 *
 * A link that 404s is worse than no link: it reads as "their page is gone" when the page is fine
 * and the URL was ours. Check a constructed deep link against the upstream before shipping it.
 */
export function docUrl({ ssUrl }) {
  if (!ssUrl) return null;
  const file = ssUrl.endsWith('.pdf') ? ssUrl : `${ssUrl}.pdf`;
  return `${SS_BASE}/document/${encodeURIComponent(file)}`;
}

/**
 * Merge the freshly-fetched head over a cached tail, newest first.
 *
 * The head is authoritative for anything it contains: a call whose analysis landed between the
 * two fetches appears in the head with a score and in the tail without one, and the scored copy
 * is the true one. Keyed on companyKey + when, because a company can hold two calls in a quarter.
 */
export function mergeScans(head = [], tail = []) {
  const byKey = new Map();
  for (const r of tail) byKey.set(`${r.companyKey}|${r.when}`, r);
  for (const r of head) byKey.set(`${r.companyKey}|${r.when}`, r);
  return [...byKey.values()].sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
}

/**
 * An ORDER-INDEPENDENT checksum over identity and the analysis, for change detection.
 *
 * Covers the score, the tier and the notes flag as well as identity, because the interesting
 * change on this feed is not a new row — it is an existing row acquiring its analysis twenty
 * minutes after the call ended.
 */
export function fingerprint(rows = []) {
  let total = 0;
  for (const r of rows) {
    const documents = (r.documents || []).map((document) => `${document.type}:${document.url}`).sort().join(',');
    const tok = `${r.companyKey}|${r.when}|${r.resultScore ?? ''}|${r.sentimentTier ?? ''}|${r.notesReady ? 1 : 0}|${r.tags.length}|${documents}`;
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
    total = (total + h) | 0;
  }
  return `${rows.length}:${total}`;
}
