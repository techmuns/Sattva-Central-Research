// worker/stockscans.mjs — fetching for the StockScans con-call feed.
//
// The vocabulary, the row normalisers, the merge and the fingerprint live in
// public/js/data/stockscans-shared.js, because the browser needs them too and one definition
// beats two. This file adds only the network layer, with `fetch` injected so the Worker passes
// its own and Node passes the global — the same contract worker/mc.mjs uses.
//
//   const { rows, meta } = await fetchConcallScans({ pages: 'all' });
//
// THE UPSTREAM
//   POST https://www.stockscans.in/api/scans/concall/run      one pinned quarter, 50/page
//   POST https://www.stockscans.in/api/scans/concall/upcoming scheduled, not yet held
//   GET  https://www.stockscans.in/api/scans/concall/today    today's calls with times
//
//   No auth, no cookies, no bot wall, `robots.txt: Allow: /`.
//
//   The newest current-quarter page is checked every 30s. Older assessments can change too:
//   all published quarters are revisited through paced, bounded background checkpoints and
//   the independent snapshot capture. A head check never certifies historical completeness.

export {
  SS_BASE,
  SCAN_URL,
  UPCOMING_URL,
  TODAY_URL,
  PAGE_SIZE,
  RESULT_TIERS,
  SENTIMENT_TIERS,
  resultTierOf,
  sentimentTierOf,
  normaliseScanRow,
  normaliseScheduleRow,
  docUrl,
  mergeScans,
  fingerprint,
} from '../public/js/data/stockscans-shared.js';

import { SCAN_URL, UPCOMING_URL, TODAY_URL, PAGE_SIZE, mergeScans, normaliseScanRow, normaliseScheduleRow } from '../public/js/data/stockscans-shared.js';
import { boundedJson } from '../public/js/data/family-book-contract.js';

const HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'SattvaCentralResearch/1.0 (+dashboard)',
};

async function postJson(url, body, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const error = new Error(`StockScans HTTP ${res.status} for ${url}`);
    error.status = res.status;
    const retry = res.headers.get('retry-after');
    error.retryAfterMs = Math.max(60000, /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - Date.now() || 0);
    throw error;
  }
  return boundedJson(res, 1024 * 1024);
}

/**
 * One page of the scan. `offset` is a row offset, not a page number — StockScans returns `next`
 * as the offset to ask for, or null at the end.
 */
export async function fetchScanPage({ offset = 0, quarter = null } = {}, fetchImpl = fetch) {
  const body = await postJson(SCAN_URL, { offset, quarter, industry: [], index: [], watchlistIds: [],
    resultTiers: [], sentimentTiers: [], filters: [], q: '' }, fetchImpl);
  if (!Array.isArray(body?.rows) || !/^\d{4}(03|06|09|12)$/.test(String(body.quarter || '')) ||
      (quarter && String(body.quarter) !== String(quarter)) ||
      (body.next != null && (!Number.isInteger(body.next) || body.next <= offset)) ||
      ((offset === 0 || body.total != null) && (!Number.isInteger(body.total) || body.total < 0)) || body.rows.some(row => !normaliseScanRow(row)))
    throw Error('StockScans returned an invalid or changed-quarter page');
  return {
    rows: body.rows.map(row => ({ ...normaliseScanRow(row), analysisQuarter: String(body.quarter), analysisCheckedAt: new Date().toISOString() })),
    next: body?.next ?? null,
    total: body?.total ?? null,
    quarter: body?.quarter ?? null,
    quarters: Array.isArray(body.quarters) ? [...new Set(body.quarters.map(String))]
      .filter(q => /^\d{4}(03|06|09|12)$/.test(q)) : [String(body.quarter)],
  };
}

/**
 * The scan. `pages: 1` fetches only the newest 50 — the hot path. `pages: 'all'` walks the cursor
 * to the end, bounded by `maxPages` so a cursor bug upstream cannot become an unbounded loop here.
 */
export async function fetchConcallScans({ pages = 'all', maxPages = 40, startOffset = 0, quarter: requestedQuarter = null, gapMs = 0 } = {}, fetchImpl = fetch) {
  const rows = [];
  let offset = startOffset;
  let total = null;
  let quarter = null;
  let fetched = 0;
  let quarters = [];
  let next = null;
  const limit = pages === 'all' ? maxPages : Math.max(1, Number(pages) || 1);

  while (fetched < limit) {
    if (fetched && gapMs) await new Promise(resolve => setTimeout(resolve, gapMs));
    const page = await fetchScanPage({ offset, quarter: quarter || requestedQuarter }, fetchImpl);
    if (page.total != null) total = page.total;
    if (page.quarter != null) quarter = page.quarter;
    quarters = page.quarters;
    rows.push(...page.rows);
    fetched++;
    next = page.next;
    if (page.next == null || !page.rows.length) break;
    offset = page.next;
  }

  return {
    rows,
    meta: {
      quarter,
      quarters,
      next,
      total,
      pagesFetched: fetched,
      // True when we stopped because of our own bound rather than because the feed ended. The
      // caller must not present a truncated list as the whole quarter.
      truncated: next != null || startOffset + rows.length < (total ?? 0),
      source: 'StockScans — Concall Scans (stockscans.in/concall-scans)',
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** Every quarter still published by the provider, preserving exact source scores and documents. */
export async function fetchConcallHistory({ head = null, maxQuarters = 12, gapMs = 0 } = {}, fetchImpl = fetch) {
  head ||= await fetchConcallScans({ pages: 1 }, fetchImpl);
  const quarters = [...new Set([String(head.meta.quarter), ...(head.meta.quarters || [])])];
  if (quarters.length > maxQuarters) throw Error('StockScans quarter history exceeds the verified collection bound');
  let rows = head.rows;
  const checks = [];
  for (const quarter of quarters) {
    const current = quarter === String(head.meta.quarter);
    if (gapMs && (!current || head.meta.next != null)) await new Promise(resolve => setTimeout(resolve, gapMs));
    const rest = current && head.meta.next == null ? { rows: [], meta: { total: head.meta.total, truncated: false } }
      : await fetchConcallScans({ quarter, startOffset: current ? (head.meta.next ?? PAGE_SIZE) : 0, gapMs }, fetchImpl);
    rows = mergeScans(rows, rest.rows);
    const count = rest.rows.length + (current ? head.rows.length : 0);
    const total = current ? head.meta.total : rest.meta.total;
    checks.push({ quarter, count, total, truncated: rest.meta.truncated || (total != null && count < total),
      checkedAt: rest.meta.fetchedAt || head.meta.fetchedAt });
  }
  return { rows, meta: { ...head.meta, total: rows.length, quarterChecks: checks,
    truncated: checks.some(check => check.truncated), fetchedAt: head.meta.fetchedAt } };
}

/** Calls scheduled but not yet held. */
export async function fetchUpcoming(fetchImpl = fetch) {
  const start = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const body = await postJson(UPCOMING_URL, { start, days: 60, watchlistIds: [] }, fetchImpl);
  if (!Array.isArray(body?.rows)) throw Error('StockScans upcoming response is invalid');
  return (body?.rows || []).map(normaliseScheduleRow).filter(Boolean);
}

/** Today's calls, with their scheduled times. */
export async function fetchToday(fetchImpl = fetch) {
  const res = await fetchImpl(TODAY_URL, { headers: { accept: 'application/json', 'user-agent': HEADERS['user-agent'] }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`StockScans HTTP ${res.status} for ${TODAY_URL}`);
  const body = await boundedJson(res, 1024 * 1024);
  if (!Array.isArray(body?.rows) || !/^\d{4}-\d{2}-\d{2}$/.test(body.day || '')) throw Error('StockScans today response is invalid');
  return { day: body?.day ?? null, rows: (body?.rows || []).map(normaliseScheduleRow).filter(Boolean) };
}

