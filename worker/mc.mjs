// worker/mc.mjs — the Moneycontrol earnings client, shared by the Worker and the Node scraper.
//
// Pure and dependency-free: no Node APIs, no DOM, no Cloudflare APIs. `fetch` is a parameter so
// the Worker passes its own and Node passes the global. That is what lets one definition serve
// both the live route (worker/index.js) and the committed snapshot (scripts/scrape-earnings.mjs)
// — two copies of this would drift and the live tab would disagree with its own fallback file.
//
//   const { rows, meta } = await fetchLatestResults({ limit: 5000 });
//
// THE UPSTREAM
//   GET https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results
//   Undocumented but stable-shaped, CORS-open, no auth, no bot wall. Returns positional arrays
//   described by its own `header` block, which is why `normalise()` reads the header rather than
//   hard-coding indices — if Moneycontrol inserts a column, we notice instead of silently
//   shifting every field by one.
//
// THE PERCENTAGE TRAP, AND WHY EVERY ROW CARRIES A `kind`
//   Moneycontrol reports Net Profit growth as a plain percentage even when the sign flips. Across
//   the 1,319 companies in a full Q1 pull, 169 of them — 13% — are cases where that number does
//   not mean what it appears to:
//     · 71 have losses in BOTH periods. Vodafone Idea shows "+43%": the loss narrowed from
//       6,608 Cr to 3,754 Cr. Rendered as a green +43% it reads as profit growth.
//     · 63 went from loss to profit. Wockhardt shows "+199%". A percentage change across zero is
//       not a growth rate at all.
//     · 35 went from profit to loss. Bharat Forge shows "-127%". Same problem, mirrored.
//   So every metric is classified and the UI labels it. A number that cannot honestly be read as
//   a growth rate must not be painted like one.

export const RAPID_RESULTS_URL = 'https://api.moneycontrol.com/mcapi/v1/earnings/rapid-results';

// Validated server-side; sending anything else returns a 422 naming the allowed set.
export const TYPES = ['LR', 'BP', 'WP', 'PT', 'NT']; // Latest / Best / Worst / Profit- / Net-turnaround
export const CATEGORIES = ['all', 'std', 'con'];
export const SUBTYPES = ['yoy', 'qoq'];
export const SORTS = ['latest', 'name', 'growth', 'changeP'];

export function buildUrl({ limit = 5000, page = 1, type = 'LR', subType = 'yoy', category = 'all', sortBy = 'latest', indexId = 'N', sector = '', search = '', seq = 'desc' } = {}) {
  const q = new URLSearchParams({
    limit: String(limit),
    page: String(page),
    type,
    subType,
    category,
    sortBy,
    indexId,
    sector,
    search,
    seq,
  });
  return `${RAPID_RESULTS_URL}?${q}`;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "August 10, 2026" -> "2026-08-10". Returns null rather than guessing on an unexpected format. */
export function parseResultDate(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** "11,689" -> 11689 · "-3,754" -> -3754 · "" -> null. Never returns 0 for missing input. */
export function parseNum(s) {
  if (s == null || s === '' || s === '-') return null;
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify a period-on-period move so the UI can render it honestly.
 *
 * `pct` is only ever non-null for `normal` and `loss-narrowed`/`loss-widened`, and even then the
 * loss cases carry a distinct kind so they can be labelled. For a sign flip there is no honest
 * percentage, so `pct` is null and the UI shows the two raw figures instead.
 */
export function classifyChange(current, prior, reportedPct) {
  if (current == null || prior == null) return { kind: 'na', pct: null, direction: 0 };
  if (prior === 0) return { kind: current === 0 ? 'flat' : 'from-zero', pct: null, direction: Math.sign(current) };

  if (current >= 0 && prior > 0) {
    const pct = reportedPct != null ? reportedPct : ((current - prior) / prior) * 100;
    return { kind: 'normal', pct, direction: Math.sign(current - prior) };
  }
  if (current < 0 && prior < 0) {
    // Both loss-making. Improvement means the loss got smaller, i.e. current is less negative.
    // An unchanged loss is its own case: treating "not narrowed" as "widened" rendered Eurotex's
    // -1 vs -1 as "Loss ↑ 0%", which claims a deterioration that did not happen.
    if (current === prior) return { kind: 'loss-flat', pct: 0, direction: 0 };
    const narrowed = current > prior;
    return { kind: narrowed ? 'loss-narrowed' : 'loss-widened', pct: reportedPct, direction: narrowed ? 1 : -1 };
  }
  if (current >= 0 && prior < 0) return { kind: 'turnaround', pct: null, direction: 1 };
  return { kind: 'slipped-to-loss', pct: null, direction: -1 };
}

/**
 * Turn one Moneycontrol positional row into an object, using the payload's own `header` block to
 * locate each field. Unknown/extra columns are ignored; a missing required one yields null rather
 * than a shifted value.
 */
export function normaliseRow(row, headerIndex) {
  const at = (name) => {
    const i = headerIndex[name];
    return i == null ? undefined : row[i];
  };

  const metrics = {};
  const raw = at('quarterData');
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (!Array.isArray(m) || m.length < 4) continue;
      const key = String(m[0]).toLowerCase().replace(/[^a-z]/g, ''); // "Gross Profit" -> grossprofit
      const current = parseNum(m[1]);
      const prior = parseNum(m[2]);
      const reported = parseNum(m[3]);
      metrics[key] = { label: m[0], current, prior, reportedPct: reported, ...classifyChange(current, prior, reported) };
    }
  }

  const seo = String(at('seoString') || '');
  const scId = String(at('scID') || '').trim();

  return {
    scId,
    // Moneycontrol truncates display names to 15 characters ("Jubilant Pharmo"), so this is a
    // label, never a join key. The join key is scId -> NSE ticker via the committed map.
    name: String(at('stockName') || '').trim(),
    resultDate: parseResultDate(at('date')),
    resultDateLabel: String(at('date') || ''),
    ltp: parseNum(at('ltp')),
    changePct: parseNum(at('changeP')),
    exchange: String(at('exchange') || '').trim(), // N | B
    basis: String(at('financialType') || '').trim(), // Consolidated | Standalone
    sectorSlug: seo.split('/').filter(Boolean)[0] || null,
    mcUrl: seo ? `https://www.moneycontrol.com/india/stockpricequote${seo}` : null,
    revenue: metrics.revenue ?? null,
    grossProfit: metrics.grossprofit ?? null,
    netProfit: metrics.netprofit ?? null,
  };
}

/** Map the payload's `header` array to `{ fieldName: index }`. */
export function headerIndexOf(header) {
  const idx = {};
  (header || []).forEach((h, i) => {
    if (h && h.name) idx[h.name] = i;
  });
  return idx;
}

/**
 * Fetch and normalise one page. `fetchImpl` defaults to the ambient fetch so the Worker and Node
 * both work without ceremony.
 */
export async function fetchLatestResults(opts = {}, fetchImpl = fetch) {
  const url = buildUrl(opts);
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0 (+dashboard)' },
  });
  if (!res.ok) throw new Error(`Moneycontrol HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.success !== 1 || !body.data) {
    throw new Error(`Moneycontrol rejected the request: ${typeof body?.data === 'string' ? body.data : 'unexpected payload'}`);
  }

  const data = body.data;
  const headerIndex = headerIndexOf(data.header);
  for (const required of ['stockName', 'scID', 'date', 'quarterData']) {
    if (headerIndex[required] == null) throw new Error(`Moneycontrol payload is missing the "${required}" column`);
  }

  // `seq` is the position Moneycontrol returned this row in, and it is DATA, not decoration.
  // The upstream is sorted latest-first at finer granularity than the date we get back: nine
  // companies filed on 11 Aug 2026 and their order on Moneycontrol's page is the order they
  // reported in. Sorting our copy by `resultDate` alone throws that away and reshuffles the top
  // of a table whose whole job is "what just happened" — which is exactly what it did until this
  // was added. Stamped here so the Worker, the committed snapshot and the browser all agree.
  const rows = (data.list || [])
    .map((r) => normaliseRow(r, headerIndex))
    .filter((r) => r.scId)
    .map((r, i) => ({ ...r, seq: i }));

  // tableHeader is ["Q1 FY26-27", "Jun 26", "Jun 25", "Growth"] — the quarter this pull covers and
  // the two periods being compared. Carrying it through means the UI can state which quarter it is
  // showing instead of implying "current".
  const [quarter, currentPeriod, priorPeriod] = data.tableHeader || [];

  return {
    rows,
    meta: {
      quarter: quarter || null,
      currentPeriod: currentPeriod || null,
      priorPeriod: priorPeriod || null,
      subType: opts.subType || 'yoy',
      type: opts.type || 'LR',
      category: opts.category || 'all',
      count: rows.length,
      source: 'Moneycontrol — Rapid Results (api.moneycontrol.com/mcapi/v1/earnings/rapid-results)',
      fetchedAt: new Date().toISOString(),
    },
  };
}

export const PRICE_FEED_URL = 'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash';

/**
 * Resolve a Moneycontrol company code to its NSE identity.
 *
 * Returns `{ ticker, industry, shares, fullName }` or null. Never throws: an unresolvable code
 * must degrade to "no ticker shown", not to a failed request for the whole table.
 */
export async function resolveIdentity(scId, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${PRICE_FEED_URL}/${encodeURIComponent(scId)}`, {
      headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0' },
    });
    if (!res.ok) return null;
    const d = (await res.json())?.data || {};
    const ticker = String(d.NSEID || '').trim().toUpperCase();
    if (!ticker) return null;
    const shares = Number(d.SHRS);
    return {
      ticker,
      bseId: String(d.BSEID || '').trim() || null,
      fullName: String(d.company || d.SC_FULLNM || '').trim() || null,
      industry: String(d.newSubsector || d.main_sector || '').replace(/\s+/g, ' ').trim() || null,
      shares: Number.isFinite(shares) && shares > 0 ? shares : null,
      mktCapAtBuild: Number(d.MKTCAP) || null,
    };
  } catch {
    return null;
  }
}

/**
 * Fill in the identity of companies the committed ticker map has never seen.
 *
 * A company that reports TODAY is by definition not in a map built yesterday, so without this the
 * freshest rows — the entire point of a live results feed — arrive with no ticker, no market cap
 * and no industry until the nightly job catches up. Those are exactly the rows a user is looking
 * at, so they get resolved now.
 *
 * Bounded by `limit`: outside results season this resolves nothing, and on the busiest day it is
 * a few dozen requests once per cache window, not per reader. Anything beyond the cap keeps its
 * null ticker and is picked up by the next scheduled run.
 */
export async function resolveMissing(rows, knownMap = {}, { limit = 40, fetchImpl = fetch } = {}) {
  const unknown = [...new Set(rows.filter((r) => r.scId && !knownMap[r.scId]).map((r) => r.scId))].slice(0, limit);
  if (!unknown.length) return { resolved: {}, attempted: 0, failed: 0 };

  const entries = await Promise.all(unknown.map(async (scId) => [scId, await resolveIdentity(scId, fetchImpl)]));
  const resolved = {};
  let failed = 0;
  for (const [scId, hit] of entries) {
    if (hit) resolved[scId] = hit;
    else failed++;
  }
  return { resolved, attempted: unknown.length, failed };
}

/** Attach identity + a live market cap to each row from the merged map. */
export function applyIdentity(rows, map = {}) {
  return rows.map((r) => {
    const m = map[r.scId];
    if (!m) return r;
    return {
      ...r,
      ticker: m.ticker || null,
      fullName: m.fullName || null,
      industry: m.industry || null,
      shares: m.shares ?? null,
      mktCapAtBuild: m.mktCapAtBuild ?? null,
    };
  });
}

/**
 * Latest result date present in a row set, as ISO. The live layer uses this plus the row count as
 * a cheap "has anything changed?" signal — a new filing moves one or both.
 */
export function freshnessOf(rows) {
  let latest = null;
  for (const r of rows) if (r.resultDate && (!latest || r.resultDate > latest)) latest = r.resultDate;
  return { latestResultDate: latest, count: rows.length };
}

// ---------------------------------------------------------------------------------------
// THE RESULTS CALENDAR — who is *scheduled* to report, and when.
//
// Moneycontrol's current public calendar splits the answer across two endpoints:
//
//   1. api.moneycontrol.com/mcapi/v1/earnings/result-calendar — the complete count per date.
//   2. www.moneycontrol.com/earnings-widget plus /pagination/earnings-pagination — the named
//      companies, twenty rows per page.
//
// The old integration read /markets/earnings/results-calendar and stopped at that page's first
// twenty server-rendered rows. Moneycontrol's current /earnings-calendar page publishes the real
// pagination route in its own JavaScript, so stopping at twenty is no longer defensible. The
// count and list are now both requested with indexId=All, matching the source page's default and
// keeping BSE-only companies such as Vivanta Industries in the same answer as NSE companies.
//
// A busy date currently needs about thirty pages. Cloudflare allows six simultaneous outgoing
// connections, so pages are fetched in batches of six. The hard page guard is below the Free-plan
// 50-external-subrequest ceiling once the count request and bounded identity lookups are included;
// the caller uses pagesFetched to spend only the remaining identity budget.
// ---------------------------------------------------------------------------------------

export const CALENDAR_STRIP_URL = 'https://api.moneycontrol.com/mcapi/v1/earnings/result-calendar';
export const CALENDAR_PAGE_URL = 'https://www.moneycontrol.com/earnings-calendar';
export const CALENDAR_WIDGET_URL = 'https://www.moneycontrol.com/earnings-widget';
export const CALENDAR_PAGINATION_URL = 'https://www.moneycontrol.com/pagination/earnings-pagination';
export const CALENDAR_PAGE_SIZE = 20;
// Forty result pages + two bounded retries + one count request + the five-request Screener
// artifact read stay below the Workers Free external-subrequest ceiling as one combined route.
export const CALENDAR_MAX_PAGES = 40;

// www.moneycontrol.com sits behind Akamai Bot Manager. From an ordinary client (a laptop, a
// GitHub runner) these headers get the real server-rendered page. From a Cloudflare Worker they
// often do not: Akamai can answer 200 with an interstitial that carries none of the expected rows.
// That is why `fetchCalendarDay` throws a *typed* error for it and the Worker falls back to the
// committed capture rather than treating it as an outage — see scripts/scrape-calendar.mjs.
const PAGE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

/** Thrown when the page came back but without its app payload — a bot wall, not an outage. */
export class CalendarPageBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalendarPageBlocked';
    this.blocked = true;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const assertIsoDate = (d, name) => {
  if (!ISO_DATE.test(String(d || ''))) throw new Error(`${name} must be YYYY-MM-DD, got "${d}"`);
  return d;
};

/**
 * The date strip: `[{ date, displayDate, count }]`, newest first as the upstream returns it.
 * `count` is the complete number of companies scheduled on that date.
 */
export async function fetchCalendarStrip({ fromDate, toDate, indexId = 'All' } = {}, fetchImpl = fetch) {
  assertIsoDate(fromDate, 'fromDate');
  assertIsoDate(toDate, 'toDate');
  const url = `${CALENDAR_STRIP_URL}?fromDate=${fromDate}&toDate=${toDate}&indexId=${encodeURIComponent(indexId)}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0 (+dashboard)' } });
  if (!res.ok) throw new Error(`Moneycontrol calendar HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.success !== 1 || !body.data) throw new Error(`Moneycontrol rejected the calendar request: ${typeof body?.data === 'string' ? body.data : 'unexpected payload'}`);

  const idx = headerIndexOf(body.data.header);
  for (const required of ['date', 'displayDate', 'earningCount']) {
    if (idx[required] == null) throw new Error(`Moneycontrol calendar payload is missing the "${required}" column`);
  }
  return (body.data.list || [])
    .map((r) => ({
      date: r[idx.date],
      displayDate: r[idx.displayDate],
      // The upstream types this inconsistently — 0 as a number, "170" as a string. A count is a
      // number; leaving it mixed would make every comparison downstream a coin flip.
      count: Number(r[idx.earningCount]) || 0,
    }))
    .filter((d) => ISO_DATE.test(String(d.date || '')));
}

const HTML_ENTITIES = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
const decodeHtml = (value) =>
  String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (all, name) => HTML_ENTITIES[name.toLowerCase()] ?? all);

const textFromHtml = (value) =>
  decodeHtml(
    String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

function exchangeMapFromCalendarHtml(html) {
  const out = new Map();
  const tags = String(html || '').match(/<(?:input|tr)\b[^>]*\bid\s*=\s*["'](?:scIds-widget|paginate-scids)["'][^>]*>/gi) || [];
  for (const tag of tags) {
    const raw = /\b(?:value|dataScId)\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!raw) continue;
    try {
      for (const item of JSON.parse(decodeHtml(raw))) {
        if (item?.scID) out.set(String(item.scID), item.exchange || null);
      }
    } catch {
      // A malformed identity hint must not discard otherwise parseable calendar rows. The row
      // remains with exchange=null and the count/list consistency check still protects coverage.
    }
  }
  return out;
}

/** Parse one widget or pagination fragment from Moneycontrol's public Earnings Calendar. */
export function parseCalendarHtml(html, date) {
  assertIsoDate(date, 'date');
  const exchanges = exchangeMapFromCalendarHtml(html);
  const rows = [];

  for (const match of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = match[1];
    if (!/\bevt_alink\b/i.test(rowHtml)) continue;

    const cells = [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)].map((m) => ({ attrs: m[1], html: m[2] }));
    const eventIndex = cells.findIndex((cell) => /\beventName\b/i.test(cell.attrs));
    if (eventIndex < 1 || cells.length < eventIndex + 5) continue;

    let event = null;
    for (const anchor of cells[eventIndex].html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (!/\bclass\s*=\s*["'][^"']*\bevt_alink\b/i.test(anchor[1])) continue;
      event = { attrs: anchor[1], name: textFromHtml(anchor[2]) };
      break;
    }
    if (!event?.name) continue;

    const scId = /\bid\s*=\s*["']([^"']+)-(?:ltp|changeP)["']/i.exec(rowHtml)?.[1] || null;
    if (!scId) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(event.attrs)?.[1] || null;
    const marketCapCell = [...cells].reverse().find((cell) => /display\s*:\s*none/i.test(cell.attrs));

    rows.push(
      normaliseCalendarRow(
        {
          scId,
          stockName: event.name,
          date: textFromHtml(cells[eventIndex - 1]?.html),
          resultType: textFromHtml(cells[eventIndex + 1]?.html),
          ltp: textFromHtml(cells[eventIndex + 2]?.html),
          change: textFromHtml(cells[eventIndex + 3]?.html).replace(/%/g, '').trim(),
          time: textFromHtml(cells[eventIndex + 4]?.html),
          marketCap: textFromHtml(marketCapCell?.html),
          exchange: exchanges.get(scId) || null,
          stockUrl: href ? decodeHtml(href) : null,
        },
        date
      )
    );
  }
  return rows.filter((row) => row.scId && row.name);
}

/** One scheduled company, in the same field vocabulary the results feed uses. */
export function normaliseCalendarRow(r, date) {
  const ltp = parseNum(r?.ltp);
  const mcap = parseNum(r?.marketCap);
  // "Time Not Available" is the upstream's way of saying it does not know. Carrying that string
  // into a Time column would render a sentence where a clock belongs; null renders as a dash,
  // which already means "not known" everywhere else in this dashboard.
  const time = r?.time && !/not available/i.test(r.time) ? String(r.time).trim() : null;
  return {
    scId: r?.scId || null,
    name: r?.stockName || r?.stockShortName || null,
    shortName: r?.stockShortName || null,
    resultDate: date,
    displayDate: r?.date || null,
    quarter: r?.resultType || null,
    time,
    ltp,
    changePct: parseNum(r?.change),
    marketCap: mcap, // already in Rs crore upstream
    exchange: r?.exchange || null,
    mcUrl: r?.stockUrl || null,
  };
}

/**
 * The complete company list for one date. `expectedCount` comes from the all-exchange strip and
 * tells us exactly how many twenty-row pages to request. Without it, pagination continues until a
 * short page. A count/list mismatch throws so the Worker can prefer a complete stamped snapshot
 * rather than presenting a partial live list as complete.
 */
export async function fetchCalendarDay({ date, indexId = 'All', expectedCount = null } = {}, fetchImpl = fetch) {
  assertIsoDate(date, 'date');
  const count = Number.isFinite(Number(expectedCount)) ? Math.max(0, Number(expectedCount)) : null;
  let requestsMade = 0;
  let retriesRemaining = 2;
  const query = (page) =>
    new URLSearchParams({ indexId, dur: '', startDate: date, endDate: date, page: String(page), deviceType: 'web', classic: 'true' });
  const urlFor = (page) => `${page === 1 ? CALENDAR_WIDGET_URL : CALENDAR_PAGINATION_URL}?${query(page)}`;
  const getHtml = async (page) => {
    while (true) {
      requestsMade++;
      let res;
      try {
        res = await fetchImpl(urlFor(page), { headers: PAGE_HEADERS });
      } catch (cause) {
        if (retriesRemaining > 0) {
          retriesRemaining--;
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        const error = new CalendarPageBlocked(`Moneycontrol calendar page ${page} request failed: ${cause?.message || cause}`);
        error.requestsMade = requestsMade;
        throw error;
      }
      if (res.ok) return res.text();
      // Pagination occasionally emits a transient 5xx on one page of an otherwise healthy date.
      // Spend at most two retries across the whole date, then surface the failure for snapshot
      // fallback. The caller accounts `requestsMade` before spending anything on identity lookups.
      if (res.status >= 500 && retriesRemaining > 0) {
        retriesRemaining--;
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      const error = new CalendarPageBlocked(`Moneycontrol calendar page ${page} HTTP ${res.status}`);
      error.requestsMade = requestsMade;
      throw error;
    }
  };

  const firstHtml = await getHtml(1);
  const firstRows = parseCalendarHtml(firstHtml, date);
  if (count > 0 && !firstRows.length) {
    const error = new CalendarPageBlocked(`the calendar widget returned ${firstHtml.length} bytes but no company rows`);
    error.requestsMade = requestsMade;
    throw error;
  }

  const rows = [...firstRows];
  let pagesFetched = 1;
  const requestedPages = count == null
    ? firstRows.length >= CALENDAR_PAGE_SIZE ? CALENDAR_MAX_PAGES : 1
    : Math.max(1, Math.ceil(count / CALENDAR_PAGE_SIZE));
  if (requestedPages > CALENDAR_MAX_PAGES) {
    throw new Error(`Moneycontrol calendar needs ${requestedPages} pages, above the ${CALENDAR_MAX_PAGES}-page safety bound`);
  }

  // At most six concurrent outgoing connections: the Cloudflare platform limit and a polite bound
  // for the upstream. A known count makes the page range deterministic and safe to batch. Without
  // one, pages must be sequential: prefetching a six-page batch past the first short page would
  // spend uncounted subrequests and could leave too little budget for identity resolution.
  if (count == null) {
    for (let page = 2; page <= requestedPages; page++) {
      const pageRows = parseCalendarHtml(await getHtml(page), date);
      pagesFetched++;
      rows.push(...pageRows);
      if (pageRows.length < CALENDAR_PAGE_SIZE) break;
    }
  } else {
    for (let start = 2; start <= requestedPages; start += 6) {
      const pageNumbers = Array.from({ length: Math.min(6, requestedPages - start + 1) }, (_, i) => start + i);
      const outcomes = await Promise.allSettled(pageNumbers.map(async (page) => ({ page, html: await getHtml(page) })));
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected) {
        // Every request in this concurrent batch has now settled, so this count includes the whole
        // batch rather than only the calls that happened to finish before the first rejection.
        rejected.reason.requestsMade = requestsMade;
        throw rejected.reason;
      }
      const fragments = outcomes.map((outcome) => outcome.value);
      for (const fragment of fragments) {
        const pageRows = parseCalendarHtml(fragment.html, date);
        pagesFetched++;
        rows.push(...pageRows);
      }
    }
  }

  const unique = [...new Map(rows.map((row) => [`${row.resultDate}|${row.scId}`, row])).values()];
  if (count != null && unique.length < count) {
    const error = new Error(`Moneycontrol calendar named ${unique.length} of ${count} scheduled companies for ${date}`);
    error.requestsMade = requestsMade;
    throw error;
  }
  const asOnDate = /Last Updated (?:on|Date)\s+(\d{2}\/\d{2}\/\d{4})/i.exec(firstHtml)?.[1] || null;
  return {
    rows: unique,
    asOnDate,
    pageSize: CALENDAR_PAGE_SIZE,
    pagesFetched,
    requestsMade,
    complete: count == null ? unique.length < pagesFetched * CALENDAR_PAGE_SIZE : unique.length >= count,
  };
}
