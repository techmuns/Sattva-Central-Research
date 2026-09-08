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
// THE `-1` WILDCARD IS A TRAP FOR MARKET-WIDE READS AND IT FAILS SILENTLY.
//   `strCat=-1` — the obvious "all categories" value, and the one their own page appears to use —
//   answers HTTP 200 with the bare STRING "No Record Found!". An empty `strCat` answers 200 with
//   zero rows. Neither is an error and neither is empty: both are the request being wrong. So the
//   categories are named explicitly, `assertShape` rejects the string form outright, and a run that
//   collects nothing fails rather than committing an empty file over a good one.
//
//   With a six-digit `strScrip`, BSE's `-1` wildcard does return the complete company result set.
//   That narrower mode powers resumable per-company history without multiplying each company by
//   every category. It validates the declared total and issuer on every page before advancing.
//
//   The cost of naming them is that a category BSE adds later is invisible until this configured
//   inventory is updated. `unknownCategories` can detect an unexpected label returned by one of the
//   categories we did request; it cannot discover a category that was never queried. A successful
//   walk therefore proves pagination across the configured categories, not that BSE added none.
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
  'Insider Trading / SAST',
  'Insurance',
  'Integrated Filing',
  'Others',
];

const BASE = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const PAGE_SIZE = 50; // observed: 50 rows a page, and the page after the last is empty rather than 404
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
export const BSE_PAGE_JSON_LIMIT = 2 * 1024 * 1024;
export const BSE_PAGE_TIMEOUT_MS = 20_000;

export const HEADERS = {
  'user-agent': UA,
  referer: 'https://www.bseindia.com/corporates/ann.html',
  accept: 'application/json, text/plain, */*',
};

/** `YYYY-MM-DD` or a Date in, `YYYYMMDD` out — this endpoint wants the compact form. */
export const compact = (d) => {
  if (d instanceof Date) return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10).replace(/-/g, '') : '';
  const value = String(d || '');
  if (/^\d{8}$/.test(value)) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replace(/-/g, '') : '';
};

export class BseAnnError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

function requiredDateRange(from, to) {
  const parse = (value) => {
    const valueCompact = compact(value);
    if (!/^\d{8}$/.test(valueCompact)) return null;
    const iso = `${valueCompact.slice(0, 4)}-${valueCompact.slice(4, 6)}-${valueCompact.slice(6)}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso
      ? { compact: valueCompact, iso }
      : null;
  };
  const first = parse(from), last = parse(to);
  if (!first || !last || first.iso > last.iso) {
    throw new BseAnnError('shape', 'Announcements need an ordered, valid YYYYMMDD date range.', { from, to });
  }
  return { from: first, to: last };
}

export function annUrl({ category, from, to, page = 1, scripCode = '' }) {
  const range = requiredDateRange(from, to);
  const pageNumber = Number(page);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new BseAnnError('shape', 'The BSE announcement page must be a positive integer.', { page });
  }
  const code = String(scripCode || '').trim();
  if (code && !/^\d{6}$/.test(code)) {
    throw new BseAnnError('shape', 'A BSE scrip code must contain exactly six digits.', { scripCode });
  }
  const q = new URLSearchParams({
    pageno: String(pageNumber),
    strCat: category,
    strPrevDate: range.from.compact,
    strScrip: code,
    strSearch: 'P',
    strToDate: range.to.compact,
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

async function cancelResponse(response) {
  try { await response?.body?.cancel?.(); } catch { /* Preserve the source error rather than a close error. */ }
}

async function boundedResponseJson(response, maxBytes, ctx) {
  const length = response.headers?.get?.('content-length');
  if (/^\d+$/.test(length || '') && Number(length) > maxBytes) {
    await cancelResponse(response);
    throw new BseAnnError('shape', `BSE response exceeded the ${maxBytes}-byte page limit.`, ctx);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new BseAnnError('shape', 'BSE returned an unreadable response body.', ctx);
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BseAnnError('shape', `BSE response exceeded the ${maxBytes}-byte page limit.`, ctx);
      }
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw new BseAnnError('shape', 'BSE returned unreadable JSON.', ctx); }
  } finally {
    reader.releaseLock();
  }
}

async function fetchBsePage(url, ctx, { fetchImpl, timeoutMs, maxResponseBytes }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BseAnnError('upstream', `BSE page did not answer within ${timeoutMs}ms.`, ctx));
    }, timeoutMs);
  });
  const read = (async () => {
    let response;
    try { response = await fetchImpl(url, { headers: HEADERS, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new BseAnnError('upstream', `BSE page did not answer within ${timeoutMs}ms.`, ctx);
      }
      throw new BseAnnError('upstream', 'BSE page could not be read.', { ...ctx, cause: String(error?.message || error) });
    }
    if (!response?.ok) {
      await cancelResponse(response);
      throw new BseAnnError('upstream', `BSE answered HTTP ${response?.status ?? 'unknown'}.`, {
        ...ctx, status: response?.status ?? null,
      });
    }
    return boundedResponseJson(response, maxResponseBytes, ctx);
  })();
  try { return await Promise.race([read, timeout]); }
  finally { clearTimeout(timer); }
}

/** The declared total for a category, which is how we know when we have all of it. */
export const rowCountOf = (body) => {
  const n = Number((body?.Table1 || [{}])[0]?.ROWCNT);
  return Number.isFinite(n) ? n : null;
};

function requiredRowCount(body, ctx) {
  const raw = body?.Table1?.[0]?.ROWCNT;
  if (!/^\d+$/.test(String(raw ?? ''))) {
    throw new BseAnnError('shape', 'BSE did not declare a valid announcement count.', ctx);
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    throw new BseAnnError('shape', 'BSE declared an announcement count outside the supported range.', { ...ctx, count: raw });
  }
  return count;
}

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

function requiredAnnouncementRow(raw, context) {
  const row = normaliseAnnouncement(raw);
  const date = String(row.date || '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    || date < context.from || date > context.to) {
    throw new BseAnnError('shape', 'BSE returned an announcement outside the requested date range or without a valid date.', {
      ...context, returnedDate: row.date,
    });
  }
  if (!row.headline) {
    throw new BseAnnError('shape', 'BSE returned an announcement without a recognizable headline or subject.', context);
  }
  return row;
}

const announcementRecordId = (row) => row.newsId ? `news:${row.newsId}` : `row:${JSON.stringify([
  row.scripCode, row.date, row.time, row.url, row.headline, row.subject, row.category, row.subCategory,
])}`;

/**
 * Every announcement in a date range, across every company on BSE.
 *
 * `fetchImpl` is a parameter so this module is pure and testable offline, exactly as worker/mc.mjs
 * is. `gapMs` spaces the requests — BSE has never rate-limited this in testing, and being
 * comfortably polite to somebody else's service is cheaper than finding out where their limit is.
 *
 * Returns `{ rows, byCategory, unknownCategories, requests, shortfall }`. Every page must repeat the
 * same declared total, and the complete declared result must be collected within `maxPages`; a
 * partial result throws instead of returning rows that a caller could mistake for complete.
 */
export async function fetchAnnouncements(
  { from, to, categories = CATEGORIES, maxPages = 200 },
  { fetchImpl = fetch, gapMs = 150, onProgress = null,
    timeoutMs = BSE_PAGE_TIMEOUT_MS, maxResponseBytes = BSE_PAGE_JSON_LIMIT } = {},
) {
  if (!Array.isArray(categories) || !categories.length || categories.some((category) => !String(category || '').trim())) {
    throw new BseAnnError('shape', 'Announcements need at least one named BSE category.');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new BseAnnError('shape', 'The BSE page limit must be a positive integer.', { maxPages });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new BseAnnError('shape', 'BSE page timeout and response limit must be positive integers.', { timeoutMs, maxResponseBytes });
  }
  const requested = requiredDateRange(from, to);
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
    const recordIds = new Set();
    for (;;) {
      const url = annUrl({ category, from, to, page });
      requests++;
      const context = { url, category, page };
      const body = assertShape(await fetchBsePage(url, context, { fetchImpl, timeoutMs, maxResponseBytes }), context);
      const pageDeclared = requiredRowCount(body, { url, category, page });
      if (declared == null) declared = pageDeclared;
      else if (pageDeclared !== declared) {
        throw new BseAnnError('shape', `BSE changed the declared count for ${category} while it was being paged.`, {
          url, category, page, declared, pageDeclared,
        });
      }
      const batch = body.Table;
      if (batch.length > PAGE_SIZE) {
        throw new BseAnnError('shape', `BSE returned more than ${PAGE_SIZE} rows for ${category} page ${page}.`, {
          url, category, page, rows: batch.length,
        });
      }
      if (got + batch.length > declared) {
        throw new BseAnnError('shape', `BSE returned more rows than it declared for ${category}.`, {
          url, category, page, declared, collected: got + batch.length,
        });
      }
      for (const raw of batch) {
        const r = requiredAnnouncementRow(raw, { url, category, page, from: requested.from.iso, to: requested.to.iso });
        const recordId = announcementRecordId(r);
        if (recordIds.has(recordId)) {
          throw new BseAnnError('shape', `BSE repeated an announcement while paging ${category}.`, {
            url, category, page, newsId: r.newsId,
          });
        }
        recordIds.add(recordId);
        // A different label means BSE ignored or changed the requested filter. It cannot be counted
        // as a complete walk of this category. This still cannot discover a separate category that
        // was absent from the configured requests altogether.
        if (r.category !== category) {
          throw new BseAnnError('shape', `BSE returned category ${r.category || '(missing)'} while ${category} was requested.`, {
            url, category, returnedCategory: r.category, page,
          });
        }
        if (r.category && !known.has(r.category)) {
          unknownCategories.set(r.category, (unknownCategories.get(r.category) || 0) + 1);
        }
        rows.push(r);
      }
      got += batch.length;
      if (onProgress) onProgress({ category, page, got, declared, requests });
      if (got === declared) break;
      if (batch.length !== PAGE_SIZE) {
        throw new BseAnnError('shape', `BSE ended ${category} page ${page} before its declared count was collected.`, {
          url, category, page, declared, collected: got,
        });
      }
      if (page >= maxPages) {
        throw new BseAnnError('shape', `BSE ${category} exceeded the ${maxPages}-page safety limit.`, {
          url, category, page, declared, collected: got,
        });
      }
      page++;
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
    byCategory[category] = { declared, collected: got, pages: page };
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }

  return { rows, byCategory, unknownCategories: Object.fromEntries(unknownCategories), requests, shortfall };
}

/**
 * Complete BSE history for one known scrip code and date range.
 *
 * BSE's all-category wildcard is reliable when a scrip code is present, so a company history costs
 * one paginated walk rather than one walk per category. This path is deliberately stricter than
 * the exchange-wide collector: one wrong-code row or unstable count would put another issuer's
 * filing into a durable company archive, so the whole answer is rejected instead.
 */
export async function fetchCompanyAnnouncements(
  { scripCode, from, to, maxPages = 200 },
  { fetchImpl = fetch, gapMs = 150, onProgress = null,
    timeoutMs = BSE_PAGE_TIMEOUT_MS, maxResponseBytes = BSE_PAGE_JSON_LIMIT } = {},
) {
  const code = String(scripCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw new BseAnnError('shape', 'A BSE scrip code must contain exactly six digits.', { scripCode });
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new BseAnnError('shape', 'The BSE page limit must be a positive integer.', { maxPages });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new BseAnnError('shape', 'BSE page timeout and response limit must be positive integers.', { timeoutMs, maxResponseBytes });
  }
  const requested = requiredDateRange(from, to);

  const rows = [];
  const recordIds = new Set();
  let declared = null;
  let page = 1;

  for (;;) {
    const url = annUrl({ category: '-1', from, to, page, scripCode: code });
    const context = { url, scripCode: code, page };
    const body = assertShape(await fetchBsePage(url, context, { fetchImpl, timeoutMs, maxResponseBytes }), context);

    const pageDeclared = requiredRowCount(body, { url, scripCode: code, page });
    if (declared == null) declared = pageDeclared;
    else if (pageDeclared !== declared) {
      throw new BseAnnError('shape', `BSE changed the declared count for scrip ${code} while it was being paged.`, {
        url, scripCode: code, page, declared, pageDeclared,
      });
    }

    const batch = body.Table;
    if (batch.length > PAGE_SIZE) {
      throw new BseAnnError('shape', `BSE returned more than ${PAGE_SIZE} rows for scrip ${code} page ${page}.`, {
        url, scripCode: code, page, rows: batch.length,
      });
    }
    if (rows.length + batch.length > declared) {
      throw new BseAnnError('shape', `BSE returned more rows than it declared for scrip ${code}.`, {
        url, scripCode: code, page, declared, collected: rows.length + batch.length,
      });
    }

    for (const raw of batch) {
      const rowCode = String(raw?.SCRIP_CD ?? '').trim();
      if (rowCode !== code) {
        throw new BseAnnError('shape', `BSE returned scrip ${rowCode || '(missing)'} while ${code} was requested.`, {
          url, scripCode: code, returnedScripCode: rowCode || null, page,
        });
      }
      const row = requiredAnnouncementRow(raw, {
        url, scripCode: code, page, from: requested.from.iso, to: requested.to.iso,
      });
      // NEWSID is normally present, but completeness must not depend on it. A repeated no-ID row
      // on a later page can otherwise make the collected count equal the declared total while one
      // real announcement is still missing.
      const recordId = announcementRecordId(row);
      if (recordIds.has(recordId)) {
        throw new BseAnnError('shape', `BSE repeated an announcement while paging scrip ${code}.`, {
          url, scripCode: code, newsId: row.newsId, page,
        });
      }
      recordIds.add(recordId);
      rows.push(row);
    }

    onProgress?.({ scripCode: code, page, got: rows.length, declared });
    if (rows.length === declared) break;
    if (batch.length !== PAGE_SIZE) {
      throw new BseAnnError('shape', `BSE ended scrip ${code} page ${page} before its declared count was collected.`, {
        url, scripCode: code, page, declared, collected: rows.length,
      });
    }
    if (page >= maxPages) {
      throw new BseAnnError('shape', `BSE scrip ${code} exceeded the ${maxPages}-page safety limit.`, {
        url, scripCode: code, page, declared, collected: rows.length,
      });
    }
    page++;
    if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }

  return { rows, scripCode: code, declared, collected: rows.length, pages: page, requests: page };
}
