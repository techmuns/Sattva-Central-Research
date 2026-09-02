// worker/bse-ann.mjs — corporate announcements from BSE, indexed BY DATE rather than by company.
//
// WHY THIS EXISTS, WHEN THERE IS ALREADY AN ANNOUNCEMENTS CLIENT IN worker/muns.mjs
//   That one is per-company: `GET /filings/corp/announcements/{ticker}`. The date range is a
//   PARAMETER on a per-company request, so narrowing the window buys nothing — asking 603 companies
//   about one day is still 603 requests, the same ten minutes, and the same truncation at whatever
//   the rate limit or an expiring JWT allows. That is why the committed snapshot covered 118
//   companies rather than the universe: not an absence of data, a shortage of request budget.
//
//   BSE publish the same filings indexed the other way round — every company's announcements for a
//   date. Measured on 19 Aug 2026: 886 announcements across the WHOLE exchange in about two dozen
//   requests. That is the entire universe for roughly four per cent of the old budget, and it needs
//   no credential, so it cannot fail the way a session JWT fails.
//
// THE `-1` WILDCARD IS A TRAP AND IT FAILS SILENTLY.
//   `strCat=-1` — the obvious "all categories" value, and the one their own page appears to use —
//   answers HTTP 200 with the bare STRING "No Record Found!". An empty `strCat` answers 200 with
//   zero rows. Neither is an error and neither is empty: both are the request being wrong. So the
//   categories are named explicitly, `assertShape` rejects the string form outright, and a run that
//   collects nothing fails rather than committing an empty file over a good one.
//
//   The cost of naming them is that a category BSE adds later is invisible. `unknownCategories`
//   is the tripwire: every row's own `CATEGORYNAME` is checked against the list we asked for, so a
//   value we did not request still shows up in the run report instead of being silently absent.
//
// WHAT IS REPRODUCED AND WHAT IS NOT. The headline, the subject line, the category and the filing
// time are BSE's. Presentation-only HTML break tags are normalised to spaces; the words are not
// rewritten. The PDF stays on their server and every row links to it. Nothing here summarises,
// scores or ranks a filing — same rule as the news and con-call feeds.

/** BSE's own category names. Not a taxonomy of ours — these are the strings their API accepts. */
export const CATEGORIES = [
  'Company Update',
  'Board Meeting',
  'Corp. Action',
  'Result',
  'AGM/EGM',
  'New Listing',
  'Insurance',
  'Integrated Filing',
];

const BASE = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const PAGE_SIZE = 50; // observed: 50 rows a page, and the page after the last is empty rather than 404
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const HEADERS = {
  'user-agent': UA,
  referer: 'https://www.bseindia.com/corporates/ann.html',
  accept: 'application/json, text/plain, */*',
};

/** `YYYY-MM-DD` or a Date in, `YYYYMMDD` out — this endpoint wants the compact form. */
export const compact = (d) => {
  if (d instanceof Date) return d.toISOString().slice(0, 10).replace(/-/g, '');
  return String(d || '').replace(/-/g, '').slice(0, 8);
};

export class BseAnnError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

export function annUrl({ category, from, to, page = 1 }) {
  const f = compact(from);
  const t = compact(to);
  if (!/^\d{8}$/.test(f) || !/^\d{8}$/.test(t)) {
    throw new BseAnnError('shape', 'Announcements need a YYYYMMDD date range.', { from, to });
  }
  const q = new URLSearchParams({
    pageno: String(page),
    strCat: category,
    strPrevDate: f,
    strScrip: '',
    strSearch: 'P',
    strToDate: t,
    strType: 'C',
    subcategory: '-1',
  });
  return `${BASE}?${q}`;
}

/**
 * A 200 is not a contract — assert the shape before trusting it.
 *
 * Three things this endpoint does that look like success: the "No Record Found!" string, a body
 * with no `Table` at all, and a `Table` that is not an array. Each would otherwise flow through as
 * "this category had nothing today", which is a claim about the exchange rather than about our
 * request.
 */
export function assertShape(body, ctx = {}) {
  if (typeof body === 'string') {
    throw new BseAnnError('shape', `BSE answered with the string ${JSON.stringify(body)} rather than a result set — the request was wrong, not the day empty.`, ctx);
  }
  if (!body || typeof body !== 'object') {
    throw new BseAnnError('shape', 'BSE answered with something that is not an object.', ctx);
  }
  if (!Array.isArray(body.Table)) {
    throw new BseAnnError('shape', 'BSE answered without a `Table` array.', { ...ctx, keys: Object.keys(body) });
  }
  return body;
}

/** The declared total for a category, which is how we know when we have all of it. */
export const rowCountOf = (body) => {
  const n = Number((body?.Table1 || [{}])[0]?.ROWCNT);
  return Number.isFinite(n) ? n : null;
};

/** BSE occasionally embeds HTML break tags in a plain-text headline field. */
export function cleanAnnouncementText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * One row, in this dashboard's vocabulary.
 *
 * `ticker` is deliberately NOT set here — a scrip code is BSE's identifier and resolving it to an
 * NSE symbol needs the scrip map, which is the caller's business. Setting it to the scrip code
 * would put a number where every other feed puts a symbol.
 */
export function normaliseAnnouncement(row) {
  const attach = row?.ATTACHMENTNAME && row.ATTACHMENTNAME !== 'None' ? String(row.ATTACHMENTNAME) : null;
  const when = row?.DissemDT || row?.NEWS_DT || row?.DT_TM || null;
  return {
    scripCode: row?.SCRIP_CD ? String(row.SCRIP_CD) : null,
    company: row?.SLONGNAME ? String(row.SLONGNAME) : null,
    // BSE put the headline in HEADLINE and a longer subject in NEWSSUB; the subject is often
    // truncated mid-word by them, so the headline leads and the subject is kept beside it.
    headline: cleanAnnouncementText(row?.HEADLINE || row?.NEWSSUB),
    subject: cleanAnnouncementText(row?.NEWSSUB),
    category: row?.CATEGORYNAME ? String(row.CATEGORYNAME) : null,
    subCategory: row?.SUBCATNAME && row.SUBCATNAME !== 'None' ? String(row.SUBCATNAME) : null,
    // A date that cannot be read stays null. It is never today's.
    date: when ? String(when).slice(0, 10) : null,
    time: when ? String(when).slice(11, 19) || null : null,
    // The filing itself stays on BSE's server. We surface the index and link to the content.
    url: attach ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${attach}` : null,
    newsId: row?.NEWSID ? String(row.NEWSID) : null,
    // Their own flag for a filing they consider material. Reproduced, never recomputed.
    critical: row?.CRITICALNEWS === '1' || row?.CRITICALNEWS === 1,
  };
}

/**
 * Every announcement in a date range, across every company on BSE.
 *
 * `fetchImpl` is a parameter so this module is pure and testable offline, exactly as worker/mc.mjs
 * is. `gapMs` spaces the requests — BSE has never rate-limited this in testing, and being
 * comfortably polite to somebody else's service is cheaper than finding out where their limit is.
 *
 * Returns `{ rows, byCategory, unknownCategories, requests, shortfall }`. `shortfall` records any
 * category where the rows collected did not reach the total BSE declared: a partial read is a
 * partial read and must not be presented as the day's full set.
 */
export async function fetchAnnouncements(
  { from, to, categories = CATEGORIES, maxPages = 200 },
  { fetchImpl = fetch, gapMs = 150, onProgress = null } = {},
) {
  const known = new Set(categories);
  const rows = [];
  const byCategory = {};
  const unknownCategories = new Map();
  const shortfall = [];
  let requests = 0;

  for (const category of categories) {
    let page = 1;
    let declared = null;
    let got = 0;
    for (;;) {
      const url = annUrl({ category, from, to, page });
      const res = await fetchImpl(url, { headers: HEADERS });
      requests++;
      if (!res.ok) {
        throw new BseAnnError('upstream', `BSE answered HTTP ${res.status} for ${category} page ${page}.`, { url, status: res.status });
      }
      const body = assertShape(await res.json(), { url, category, page });
      if (declared == null) declared = rowCountOf(body);
      const batch = body.Table;
      for (const raw of batch) {
        const r = normaliseAnnouncement(raw);
        // The tripwire: a category we did not ask for cannot appear in a result set we asked for
        // by name — unless BSE renamed one, which is exactly what we want to hear about.
        if (r.category && !known.has(r.category)) {
          unknownCategories.set(r.category, (unknownCategories.get(r.category) || 0) + 1);
        }
        rows.push(r);
      }
      got += batch.length;
      if (onProgress) onProgress({ category, page, got, declared, requests });
      if (batch.length < PAGE_SIZE || page >= maxPages) break;
      page++;
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    byCategory[category] = { declared, collected: got, pages: page };
    if (declared != null && got < declared) shortfall.push({ category, declared, collected: got });
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }

  return { rows, byCategory, unknownCategories: Object.fromEntries(unknownCategories), requests, shortfall };
}
