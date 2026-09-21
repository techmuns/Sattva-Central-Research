// worker/newsletter-brief.mjs — the brief itself: what goes in it, where each figure comes from,
// and the email it is rendered into. Pure apart from the injected `fetcher` and `env.ASSETS`, so
// `scripts/verify-newsletter.mjs` builds one offline against fixtures.
//
// WHAT THE DESK ASKED FOR, in their words: "the global indices — S&P, NASDAQ, what was the movement
// on the previous day; then the morning Asian indices move, Japan, Taiwan, China; then certain
// commodities like Brent, which is critical for us, and then gold, silver; then certain currencies
// like the dollar index, and USDJPY" — plus "corporate announcements and news", and "in the email,
// I would just send for direct ones". So:
//
//   1. GLOBAL MARKET SCAN — live quotes read at send time from Yahoo's public chart endpoint, one
//      symbol per request, each row carrying its OWN state and time: `Close · Wed 16:00 EDT` for a
//      market that has shut, `Live · 07:58 JST` for one still trading. A symbol Yahoo would not
//      answer prints `unavailable` and NEVER a number: this dashboard keeps no macro series store,
//      so there is no second reading to fall back to, and a stale close dressed as this morning's
//      is the one thing the row may not become. (Glow Central Research, which this brief is ported
//      from, has such a store and fills the row from it; Sattva has no equivalent file, so the code
//      that would read one is deliberately absent rather than present and unreachable.)
//   2. CORPORATE ANNOUNCEMENTS · DIRECT HOLDINGS — NSE's live announcements feed, read the way
//      /api/nse-announcements reads it, PLUS the retained NSE history the hourly scraper commits
//      under data/nse-filings/<day>.json, PLUS BSE's date-indexed capture — all narrowed to the
//      book's listed lines and to the brief's window. The live RSS is the exchange's last ~40 items
//      (measured: 40 items spanning 39 minutes), so on its own it covers a sliver of a sixteen-hour
//      window; the retained history is what covers the rest of it.
//   3. NEWS · DIRECT HOLDINGS — the publishers' feeds already captured for the News tab, joined to
//      the book by the same identity match the tab uses (`matchPortfolioNews`), PLUS the portfolio
//      headlines TradingView tags to each holding's symbol (data/tradingview-news/latest.json,
//      captured every fifteen minutes), admitted only where the dashboard's own attribution
//      confirms the story names the company — so an email can never name a company the dashboard
//      would not.
//   4. PRICE MOVES · DIRECT HOLDINGS — a holding whose last completed session closed MOVE_PCT (5%)
//      or more away from the previous close, read from the technicals capture General Alerts reads,
//      dated by the session (`bar_date`) and marked whether the close was verified against the
//      exchange's own figure. The dashboard's own alert rule, and no new reading.
//
// A LATE CAPTURE IS NOT A MISSED FILING. Every window is fixed, and every source here is a capture
// that lands on its own cadence — BSE two-hourly, NSE hourly, the publishers hourly, the closes the
// next morning — so a filing lodged at 15:50 and captured at 16:15 belongs to the evening brief's
// window and reaches the file only after that brief was sent. Under fixed windows alone it would
// never be sent at all. So each edition also reaches back over the PREVIOUS edition's window and
// carries whatever it finds there that no earlier brief sent (`sent`: the keys of every story the
// last few deliveries carried, kept in the delivery log), marked on its face as having arrived
// after the previous brief. The same mechanism carries a whole window forward when an edition was
// missed or could not be sent.
//
// "DIRECT ONES" MEANS `portfolio-companies.json`: the family's listed direct-equity lines, one per
// NSE symbol, the same file the Portfolio scope means on every tab. Fund units, AIFs and the
// ring-fenced holding are outside it there and outside it here.
//
// Source headlines remain verbatim. Optional, explicitly labelled AI notes form a separate reading layer.
// SOURCE EVIDENCE IS PRESERVED. Headlines and filing subjects are the publishers' and
// the exchanges' own words; a tracked-keyword tag says what a story is ABOUT, never what it means
// (see data/news-keywords.js). Every section states its window, its source and when that source
// was read, and a source that could not be read says so in the email rather than going quiet.

import { clusterStories, readAiNotes } from './newsletter-reading.mjs';
import { FEED_URL as NSE_FEED_URL, HEADERS as NSE_HEADERS, assertShape as assertNseShape, buildResolver, parseAnnouncements, resolveAll } from './nse-ann.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { matchPortfolioNews } from '../public/js/data/portfolio-news-matching.js';
import { matchKeywords } from '../public/js/data/news-keywords.js';
import { announcementSignal } from '../public/js/data/filing-signals.js';
import { attributeNewsRow } from '../public/js/data/company-news-attribution.js';
import { articleUrlKey } from '../public/js/data/filings-shared.js';
import { factStatement, filingParticulars, isXbrlFilingUrl, parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';
import { EDITIONS, editionWindow, istDay, istDateLong, istInstant, istLabel, istTime, previousWeekday } from '../public/js/data/newsletter-shared.js';

export const PRODUCTION_ORIGIN = 'https://sattva-central-research.tech-441.workers.dev';
export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
export const YAHOO_USER_AGENT = 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)';
export const QUOTE_POOL = 6;
export const QUOTE_TIMEOUT_MS = 8000;
export const NSE_TIMEOUT_MS = 15000;
export const ANNOUNCEMENT_LIMIT = 80;
export const NEWS_LIMIT = 60;
export const PER_COMPANY_LIMIT = 8;

export const BOOK_PATH = '/data/portfolio-companies.json';
export const BSE_PATH = '/data/corp-announcements.json';
export const PUBLISHERS_PATH = '/data/market-news.json';
export const NSE_HISTORY_INDEX_PATH = '/data/nse-filings/index.json';
export const nseHistoryPath = (day) => `/data/nse-filings/${day}.json`;
export const TRADINGVIEW_PATH = '/data/tradingview-news/latest.json';
export const TECHNICALS_PATH = '/data/technicals.json';
// The dashboard's own price-move threshold — `MOVE_PCT` in public/js/data/daily-alerts.js, which
// the Worker cannot import (that module reaches for the browser's feeds at import time). The suite
// asserts the two agree.
export const MOVE_PCT = 5;
export const MOVES_LIMIT = 40;
// An Indian equity session closes at 15:30 IST; a session's move is dated to that instant.
export const SESSION_CLOSE = '15:30';
// One filing lodged with both exchanges: the same text within twelve hours, or the same subject
// family within forty-five minutes (measured lodgement gaps are minutes apart).
export const TEXT_FOLD_MS = 12 * 3600 * 1000;
export const FAMILY_FOLD_MS = 45 * 60 * 1000;
// NSE publishes many filings twice — a readable PDF and an XBRL twin minutes apart.
export const XBRL_TWIN_MS = 30 * 60 * 1000;
// About one NSE announcement in eleven is a raw XBRL data file with no readable twin, and the
// exchange's description of one is often its category and nothing else. The filing itself carries
// the particulars, so the brief reads the ones it is about to print — bounded, because a send is
// one Worker invocation with a subrequest budget it shares with the quotes, the RSS and the
// captures, and because a filing nobody is shown is a read nobody needed.
export const XBRL_DETAIL_LIMIT = 12;
export const XBRL_DETAIL_POOL = 4;
export const XBRL_TIMEOUT_MS = 8000;

// The scan, in the order the desk reads it.
export const MARKET_GROUPS = [
  { id: 'us', label: 'United States' },
  { id: 'asia', label: 'Asia' },
  { id: 'india', label: 'India' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'currencies', label: 'Currencies' },
  { id: 'rates', label: 'Rates' },
];
export const MARKET_ROWS = [
  { id: 'sp500', symbol: '^GSPC', label: 'S&P 500', group: 'us', kind: 'index' },
  { id: 'nasdaq', symbol: '^IXIC', label: 'Nasdaq Composite', group: 'us', kind: 'index' },
  { id: 'dow', symbol: '^DJI', label: 'Dow Jones', group: 'us', kind: 'index' },
  { id: 'nikkei', symbol: '^N225', label: 'Nikkei 225', group: 'asia', kind: 'index' },
  { id: 'taiex', symbol: '^TWII', label: 'Taiwan TAIEX', group: 'asia', kind: 'index' },
  { id: 'shanghai', symbol: '000001.SS', label: 'Shanghai Composite', group: 'asia', kind: 'index' },
  { id: 'hangseng', symbol: '^HSI', label: 'Hang Seng', group: 'asia', kind: 'index' },
  { id: 'kospi', symbol: '^KS11', label: 'Kospi', group: 'asia', kind: 'index' },
  { id: 'nifty', symbol: '^NSEI', label: 'Nifty 50', group: 'india', kind: 'index' },
  { id: 'sensex', symbol: '^BSESN', label: 'Sensex', group: 'india', kind: 'index' },
  { id: 'brent', symbol: 'BZ=F', label: 'Brent crude', unit: '$/bbl', group: 'commodities', kind: 'price' },
  { id: 'gold', symbol: 'GC=F', label: 'Gold', unit: '$/oz', group: 'commodities', kind: 'price' },
  { id: 'silver', symbol: 'SI=F', label: 'Silver', unit: '$/oz', group: 'commodities', kind: 'price' },
  { id: 'dxy', symbol: 'DX-Y.NYB', label: 'Dollar index (DXY)', group: 'currencies', kind: 'index' },
  { id: 'usdjpy', symbol: 'JPY=X', label: 'USD/JPY', group: 'currencies', kind: 'fx' },
  { id: 'usdinr', symbol: 'INR=X', label: 'USD/INR', group: 'currencies', kind: 'fx' },
  { id: 'us10y', symbol: '^TNX', label: 'US 10-year yield', group: 'rates', kind: 'yield' },
];
const GLANCE = { morning: ['sp500', 'nikkei', 'brent', 'usdjpy'], evening: ['nifty', 'sensex', 'brent', 'usdinr'] };

const reasonOf = (error) => {
  if (error?.reason) return String(error.reason);
  const name = String(error?.name || '');
  if (/abort|timeout/i.test(name)) return 'timeout';
  return /shape/i.test(String(error?.message || '')) ? 'shape' : 'unreachable';
};

async function pooled(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** One committed JSON asset, read through the Worker's own assets binding; null when unavailable. */
export async function readAsset(env, path) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(path, PRODUCTION_ORIGIN)));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---- 1. the market scan -------------------------------------------------------------------------

/**
 * One quote from a Yahoo chart response. `live` is decided by Yahoo's own session bounds: the
 * last print fell inside the current regular session and that session has not yet ended.
 */
export function quoteFromChart(body, row, now) {
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) throw Object.assign(new Error('Yahoo chart shape'), { reason: 'shape' });
  const last = meta.regularMarketPrice;
  const prev = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : null;
  const asOf = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null;
  const regular = meta.currentTradingPeriod?.regular;
  const live = !!regular && asOf != null && asOf >= regular.start * 1000 && now < regular.end * 1000;
  return {
    ...row, last, prev,
    change: prev != null ? last - prev : null,
    changePct: prev ? ((last - prev) / prev) * 100 : null,
    asOf, state: live ? 'live' : 'close',
    timezone: typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : null,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    origin: 'yahoo',
  };
}

export async function readMarkets({ env, fetcher = fetch, now = Date.now() } = {}) {
  const rows = [];
  await pooled(MARKET_ROWS, QUOTE_POOL, async (row) => {
    try {
      const url = `${YAHOO_CHART_BASE}${encodeURIComponent(row.symbol)}?range=5d&interval=1d`;
      const res = await fetcher(url, { headers: { 'user-agent': YAHOO_USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS), redirect: 'manual' });
      if (!res.ok) throw Object.assign(new Error(`Yahoo HTTP ${res.status}`), { reason: res.status === 429 ? 'rate-limited' : 'upstream' });
      rows.push(quoteFromChart(await res.json(), row, now));
    } catch (error) {
      rows.push({ ...row, last: null, prev: null, change: null, changePct: null, asOf: null, state: 'unavailable', origin: null, reason: reasonOf(error) });
    }
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    readAt: now,
    rows: MARKET_ROWS.map((r) => byId.get(r.id)),
    // A refused symbol stays refused. `reason` keeps WHY on the row — timeout, rate-limited,
    // upstream, shape — so the sheet can say the quote is unavailable rather than going quiet.
    failed: rows.filter((r) => r.state === 'unavailable').map((r) => r.id),
  };
}

// ---- 2. announcements on direct holdings ----------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// NSE prefixes every description with the filer's own name and "has informed the Exchange about".
// The block heading already names the company, so the preamble is dropped and the exchange's own
// description of the filing is the headline — nothing is added, reworded or summarised. Where
// dropping it would leave the exchange's own category and nothing else, the whole sentence stands
// instead; see `headlineOfNse` below.
const NSE_PREAMBLE = /^.{0,160}?\bhas (?:informed|intimated) the exchange\b\s*(?:about|regarding|that|of|on)?\s*(?:the\s+)?/i;
const nseText = (row) => String(row.description || '').split('|SUBJECT:')[0].trim();

/** What the filing is ABOUT — the description with the filer's name and the boilerplate dropped. */
export function eventOfNse(row) {
  const text = nseText(row);
  return text.replace(NSE_PREAMBLE, '').trim() || text || row.subject || row.company || '';
}

/**
 * Does NSE's description say anything the exchange's own subject line does not?
 *
 * Measured on the retained capture: a large share of NSE's descriptions are the category and
 * nothing else — "PB Fintech Limited has informed the Exchange regarding Acquisition (including
 * agreement to acquire) |SUBJECT: Acquisition (including agreement to acquire)-XBRL". Strip the
 * preamble from one of those and what is left is the word "Acquisition", which is the filing's
 * FORM and not its content. That is the row the desk read as telling them nothing.
 */
export const categoryOnlyNse = (row) => {
  const subject = norm(String(row.subject || '').replace(/-\s*xbrl\s*$/i, ''));
  return !!subject && norm(eventOfNse(row)) === subject;
};

/**
 * The headline for a filing NSE published.
 *
 * The preamble is dropped because the block heading already names the company — but only where
 * what remains still says something. Where the description is the bare category, the exchange's
 * WHOLE sentence stands instead: it names the filer, which a one-word category does not, and it is
 * still the exchange's own words rather than a headline of ours. The filing's own particulars come
 * from the filing itself (`readFilingDetails`), never from a sentence we assembled.
 */
export function headlineOfNse(row) {
  const text = nseText(row);
  const event = text.replace(NSE_PREAMBLE, '').trim();
  if (!event) return text || row.subject || row.company || '';
  return categoryOnlyNse(row) ? text : event;
}

// THE SUBJECT FAMILY, FOR FOLDING ONE FILING LODGED WITH BOTH EXCHANGES. NSE and BSE describe the
// same filing in different words — NSE "Analysts/Institutional Investor Meet/Con. Call Updates",
// BSE "Analyst / Investor Meet"; NSE "Credit rating", BSE "Credit Rating" under a headline reading
// "Please refer the enclosed file." — so the text alone folded one pair in sixteen, measured on the
// shipped captures. Both vocabularies are small; this maps each onto one family, and two filings by
// one company in the same family minutes apart on DIFFERENT exchanges are one filing. A subject
// with no family folds only on identical text.
const FAMILIES = [
  ['meet', /analyst|investor meet|con\.? ?call|earnings call|transcript|investor presentation|meeting update/],
  ['rating', /\brating/],
  ['results', /financial result|\bresults?\b/],
  ['board', /board meeting|outcome without intimation/],
  ['distribution', /dividend|record date|buy ?back|bonus/],
  ['insider', /\bsast\b|insider|trading window|pledge|reg\.? ?(?:29|31|7)\b/],
  ['meeting', /\bagm\b|\begm\b|postal ballot|shareholders? meeting|voting result/],
  ['capital', /allotment|esop|esos|esps|issue of securities|preferential|rights issue|\bqip\b|alteration of capital|fund raising|open offer|scheme of arrangement/],
  ['people', /change in director|change in management|appointment|resignation|cessation|\bkmp\b|auditor/],
  ['orders', /\border|contract|bagging|receiving/],
  ['deal', /acquisition|memorandum|agreement|joint venture|\bmou\b|merger|amalgamation|demerger/],
  ['press', /press release|media release|newspaper|clarification|rumour/],
  ['debt', /redemption|payment of interest|principal|debenture|\bncds?\b|\bbonds?\b/],
  ['production', /commencement|commercial production|postponement/],
  ['general', /general|\bupdates?\b|intimation|others/],
];
export const familyOf = (...parts) => {
  const text = parts.filter(Boolean).join(' ').toLowerCase();
  return FAMILIES.find(([, re]) => re.test(text))?.[0] || null;
};

const isXbrl = (row) => /xbrl/i.test(row.subject || '');
const generic = (headline) => norm(headline).length < 40;
const sameFiling = (a, b) => {
  const gap = Math.abs(a.at - b.at);
  const [short, long] = a.text.length <= b.text.length ? [a.text, b.text] : [b.text, a.text];
  if (gap <= TEXT_FOLD_MS && short.length >= 25 && long.includes(short)) return true;
  return gap <= FAMILY_FOLD_MS && !!a.family && a.family === b.family;
};

/**
 * Raw exchange rows → one story per FILING. It never folds two filings from the same exchange:
 * the sixty-character headline prefix that used to be the key did, and dropped 6 of 61 book
 * filings in one three-day capture — "Please refer the enclosed file." twice is two filings, and
 * two Regulation 30 intimations minutes apart are two events. It folds an NSE XBRL twin into its
 * readable copy, and NSE's copy of a BSE filing into the BSE row, which then names both venues.
 * Every story keeps the keys of every copy it absorbed, so a later brief can tell it was sent.
 */
export function foldAnnouncements(rows, { from }) {
  const byTicker = new Map();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push({ ...row, text: norm(row.event || row.headline), copies: [] });
  }
  const out = [];
  for (const list of byTicker.values()) {
    list.sort((a, b) => a.at - b.at);
    const readable = list.filter((r) => r.exchange === 'NSE' && !isXbrl(r));
    const nse = [];
    for (const r of list.filter((r) => r.exchange === 'NSE')) {
      const twin = isXbrl(r) ? readable.find((t) => Math.abs(t.at - r.at) <= XBRL_TWIN_MS && (!r.family || t.family === r.family)) : null;
      if (twin) twin.copies.push(r); else nse.push(r);
    }
    const stories = list.filter((r) => r.exchange === 'BSE').map((r) => ({ ...r, exchanges: ['BSE'] }));
    for (const r of nse) {
      const host = stories.find((s) => s.exchanges[0] === 'BSE' && sameFiling(s, r));
      if (!host) { stories.push({ ...r, exchanges: ['NSE'] }); continue; }
      if (!host.exchanges.includes('NSE')) host.exchanges.push('NSE');
      host.copies.push(r, ...r.copies);
      // BSE's headline is often a placeholder ("Intimation attached."); NSE's description of the
      // same filing is then the exchange text worth printing — still an exchange's own words.
      if (generic(host.headline) && r.text.length > host.text.length) { host.headline = r.headline; host.event = r.event; host.text = r.text; }
    }
    out.push(...stories);
  }
  return out.sort((a, b) => b.at - a.at).map(({ copies, ...s }) => ({
    ...s,
    late: s.at < from,
    keys: [...new Set([...[s, ...copies].map((r) => `${r.ticker}|${r.exchange}:${r.url || r.at}`), `${s.ticker}|text:${s.text.slice(0, 120)}`])],
  }));
}

export async function readAnnouncements({ env, fetcher = fetch, now = Date.now(), window, holdings, sent = new Set() }) {
  const byTicker = new Map(holdings.map((h) => [h.ticker.toUpperCase(), h]));
  const inSpan = (at) => Number.isFinite(at) && at >= window.since && at < window.to;
  const rows = [];
  const seen = new Set();
  // The live feed and the retained history overlap by design; one URL is one filing.
  const admit = (row) => {
    const id = `${row.exchange}:${row.url || `${row.ticker}|${row.at}`}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push(row);
  };
  const nseRow = (r, ticker) => ({
    exchange: 'NSE', ticker, company: byTicker.get(ticker).name, subject: r.subject || null, category: null, family: familyOf(r.subject),
    // `headline` is what the reader sees and `event` is what the READINGS are taken from: the
    // keyword and direction rules are about the filing, and a headline that (rightly) carries the
    // filer's name would put a company's own name into a vocabulary written for events.
    headline: headlineOfNse(r), event: eventOfNse(r), categoryOnly: categoryOnlyNse(r),
    url: r.url || null, at: Date.parse(r.publishedAt || ''), critical: false,
  });

  let nse;
  try {
    const res = await fetcher(NSE_FEED_URL, { headers: NSE_HEADERS, signal: AbortSignal.timeout(NSE_TIMEOUT_MS), redirect: 'manual' });
    const xml = await res.text();
    if (!res.ok) throw Object.assign(new Error(`NSE HTTP ${res.status}`), { reason: res.status === 403 || res.status === 430 ? 'blocked' : 'upstream' });
    assertNseShape(xml, { status: res.status });
    const parsed = resolveAll(parseAnnouncements(xml), buildResolver({ book: holdings }));
    nse = { ok: true, readAt: now, count: parsed.length, resolved: parsed.filter((r) => r.ticker).length, matched: 0 };
    for (const r of parsed) {
      const ticker = r.ticker ? r.ticker.toUpperCase() : null;
      if (!ticker || !byTicker.has(ticker)) continue;
      const row = nseRow(r, ticker);
      if (!inSpan(row.at)) continue;
      nse.matched += 1;
      admit(row);
    }
  } catch (error) {
    nse = { ok: false, readAt: now, reason: reasonOf(error), count: 0, resolved: 0, matched: 0 };
  }

  // The retained NSE history: one file per IST day, written by scrape-nse-announcements.mjs from
  // every successful hourly read, rows already resolved to a ticker. Only the days the window
  // touches are read.
  let history = { ok: false, reason: 'capture-unavailable', capturedAt: null, days: [], rows: 0, matched: 0 };
  const index = await readAsset(env, NSE_HISTORY_INDEX_PATH);
  if (Array.isArray(index?.days)) {
    const first = istDay(window.since);
    const last = istDay(window.to);
    const days = index.days.map((d) => d?.day).filter((day) => typeof day === 'string' && day >= first && day <= last).sort();
    const files = await Promise.all(days.map((day) => readAsset(env, nseHistoryPath(day))));
    history = { ok: true, reason: null, capturedAt: index.capturedAt || null, days: [], rows: 0, matched: 0 };
    files.forEach((file, i) => {
      if (!Array.isArray(file?.rows)) return;
      history.days.push(days[i]);
      for (const r of file.rows) {
        history.rows += 1;
        const ticker = r?.ticker ? String(r.ticker).toUpperCase() : null;
        if (!ticker || !byTicker.has(ticker)) continue;
        const row = nseRow(r, ticker);
        if (!inSpan(row.at)) continue;
        history.matched += 1;
        admit(row);
      }
    });
  }

  const capture = await readAsset(env, BSE_PATH);
  let bse;
  if (capture?.byTicker && typeof capture.byTicker === 'object') {
    bse = { ok: true, capturedAt: capture.capturedAt || null, from: capture.from || null, to: capture.to || null, matched: 0 };
    for (const [ticker, list] of Object.entries(capture.byTicker)) {
      const key = String(ticker).toUpperCase();
      if (!byTicker.has(key) || !Array.isArray(list)) continue;
      for (const a of list) {
        if (!a?.date) continue;
        // BSE prints the filing's own exchange time, which is Indian time.
        const at = istInstant(a.date, String(a.time || '00:00').slice(0, 5));
        if (!inSpan(at)) continue;
        bse.matched += 1;
        admit({
          exchange: 'BSE', ticker: key, company: byTicker.get(key).name,
          subject: a.subCategory || a.category || null, category: a.category || null, family: familyOf(a.subCategory, a.category),
          headline: a.headline || a.title || a.subCategory || a.category || key, event: a.headline || a.title || a.subCategory || a.category || key,
          url: a.url || null, at, critical: a.critical === true,
        });
      }
    }
  } else {
    bse = { ok: false, reason: 'capture-unavailable', capturedAt: null, from: null, to: null, matched: 0 };
  }

  const stories = foldAnnouncements(rows, { from: window.from }).map((row) => {
    const reading = matchKeywords(row.event || row.headline);
    const signal = announcementSignal({ category: row.category, subCategory: row.subject, headline: row.event || row.headline, critical: row.critical });
    return { ...row, keywords: reading.map((k) => k.label), keywordIds: reading.map((k) => k.id), keywordGroups: [...new Set(reading.map((k) => k.group))], direction: signal.direction, importance: signal.importance, filingRule: signal.filingRule };
  });
  // A late row an earlier brief already carried is not news twice; a late row nobody sent is.
  const kept = stories.filter((s) => !(s.late && s.keys.some((k) => sent.has(k))));
  const grouped = group(kept, ANNOUNCEMENT_LIMIT);
  const filings = await readFilingDetails({ fetcher, groups: grouped.groups });
  return { nse, history, bse, filings, suppressed: stories.length - kept.length, late: kept.filter((s) => s.late).length, ...grouped };
}

/**
 * THE FILING'S OWN PARTICULARS, FOR THE FILINGS THIS BRIEF WILL ACTUALLY PRINT.
 *
 * "Acquisition (including agreement to acquire)" is what NSE's feed says about one of these rows,
 * and the desk's complaint about it was exactly right: it names a form, not an event. The document
 * behind it is an XBRL instance carrying the particulars as separate facts — who, how much, when,
 * on what terms — and the dashboard already reads those through `parseXbrlFiling` for its own
 * filing panel. This reads the same document, through the same parser, for the email.
 *
 * FOUR THINGS BOUND IT, and they are the rules this file already runs on:
 *   - it runs AFTER the grouping, so it reads what the brief prints rather than everything the
 *     window held (80 rows → at most `XBRL_DETAIL_LIMIT` reads);
 *   - the reads it does spend go FIRST to the rows whose description says least (`categoryOnly`),
 *     because those are the rows a reader cannot act on;
 *   - each read has its own timeout and a small pool, so a slow archive costs the send seconds
 *     rather than the whole edition; and
 *   - a filing that could not be read leaves the story exactly as it was. Nothing is guessed, and
 *     a failure is counted (`failed`) rather than silently reading as a filing with no content.
 */
export async function readFilingDetails({ fetcher = fetch, groups = [] } = {}) {
  const items = groups.flatMap((g) => g.items).filter((item) => isXbrlFilingUrl(item.url));
  if (!items.length) return { candidates: 0, read: 0, ok: 0, failed: 0 };
  // The thin ones first, then newest first — `group()` already ordered each company's items.
  const queue = [...items.filter((i) => i.categoryOnly), ...items.filter((i) => !i.categoryOnly)].slice(0, XBRL_DETAIL_LIMIT);
  let ok = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < queue.length; i = next++) {
      const item = queue[i];
      try {
        const res = await fetcher(item.url, { headers: NSE_HEADERS, signal: AbortSignal.timeout(XBRL_TIMEOUT_MS), redirect: 'manual' });
        const xml = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // A 200 that is not the filing is not an empty filing — the route's rule, for the same
        // reason: the document's own shape is the only evidence that it IS the document.
        const filing = parseXbrlFiling(xml);
        if (!filing.ok) throw new Error('no XBRL facts');
        const { facts, omitted, total } = filingParticulars(filing);
        if (!facts.length) throw new Error('no printable fact');
        item.detail = facts;
        item.detailOmitted = omitted;
        item.detailTotal = total;
        ok += 1;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(XBRL_DETAIL_POOL, queue.length) }, worker));
  return { candidates: items.length, read: queue.length, ok, failed };
}

// ---- 3. news on direct holdings ---------------------------------------------------------------------

const newsKeys = (row) => [...new Set([row.url ? `${row.ticker}|url:${articleUrlKey(row)}` : null, `${row.ticker}|title:${norm(row.headline).slice(0, 120)}`].filter(Boolean))];

export async function readNews({ env, window, holdings, sent = new Set() }) {
  const byTicker = new Map(holdings.map((h) => [h.ticker.toUpperCase(), h]));
  const inSpan = (at) => Number.isFinite(at) && at >= window.since && at < window.to;
  const entities = portfolioNewsEntities(holdings);
  const rows = [];
  const story = ({ ticker, company, title, summary, url, publisher, at, attribution, origin }) => {
    const reading = matchKeywords(title);
    return {
      ticker, company, headline: String(title || ''), summary: typeof summary === 'string' ? summary : '',
      url: typeof url === 'string' && /^https?:\/\//.test(url) ? url : null,
      publisher: publisher || null, at, attribution: attribution || null, origin,
      keywords: reading.map((k) => k.label), keywordIds: reading.map((k) => k.id), keywordGroups: [...new Set(reading.map((k) => k.group))],
    };
  };

  const feed = await readAsset(env, PUBLISHERS_PATH);
  let source;
  if (Array.isArray(feed?.articles)) {
    let inWindow = 0;
    let oldest = null;
    for (const article of feed.articles) {
      const at = Date.parse(article?.publishedAt || '');
      if (Number.isFinite(at) && (oldest == null || at < oldest)) oldest = at;
      if (!inSpan(at)) continue;
      inWindow += 1;
      for (const match of matchPortfolioNews(article, entities)) {
        const ticker = String(match.ticker || match.entityId || '').toUpperCase();
        if (!ticker) continue;
        rows.push(story({
          ticker, company: match.company || match.attribution?.companyName || ticker, title: article.title, summary: article.summary,
          url: article.url, publisher: article.publisher || article.source, at, attribution: match.attribution?.status, origin: 'publishers',
        }));
      }
    }
    const publishers = (feed.sources || []).map((s) => (typeof s === 'string' ? s : s?.name || s?.label || s?.publisher || s?.id)).filter(Boolean);
    // The head is a bounded file — 600 stories — and on a heavy day it can stop short of the
    // window's start. That is a fact about coverage and the sheet states it rather than implying
    // a quiet evening.
    source = { ok: true, capturedAt: feed.capturedAt || null, publishers, articles: feed.articles.length, inWindow, oldestAt: oldest, reachesWindow: oldest == null || oldest <= window.since };
  } else {
    source = { ok: false, reason: 'capture-unavailable' };
  }

  // TradingView's headlines per holding, captured every fifteen minutes (data/tradingview-news).
  // TradingView tags a story to a symbol; the dashboard's own attribution then decides whether the
  // story names the company, and only a confirmed or reviewed-related match reaches the sheet —
  // exactly what the News tab and the AI ranking admit.
  const snapshot = await readAsset(env, TRADINGVIEW_PATH);
  let tradingView;
  if (snapshot?.byTicker && typeof snapshot.byTicker === 'object' && Array.isArray(snapshot.entities)) {
    const identities = new Map();
    for (const entity of snapshot.entities) for (const key of [entity?.entityId, entity?.key, entity?.ticker].filter(Boolean)) identities.set(String(key).toUpperCase(), entity);
    tradingView = { ok: true, capturedAt: snapshot.capturedAt || null, rows: 0, inWindow: 0, matched: 0, unverified: 0 };
    for (const [key, list] of Object.entries(snapshot.byTicker)) {
      if (!Array.isArray(list)) continue;
      const identity = identities.get(String(key).toUpperCase()) || null;
      for (const row of list) {
        tradingView.rows += 1;
        const at = Date.parse(row?.publishedAt || '');
        if (!inSpan(at)) continue;
        tradingView.inWindow += 1;
        const read = attributeNewsRow(row, identity || row);
        const ticker = String(read.ticker || '').toUpperCase();
        if (!ticker || !byTicker.has(ticker)) continue;
        if (!['confirmed', 'related'].includes(read.attribution?.status)) { tradingView.unverified += 1; continue; }
        tradingView.matched += 1;
        rows.push(story({ ticker, company: byTicker.get(ticker).name, title: row.title, summary: '', url: row.url, publisher: row.source, at, attribution: read.attribution.status, origin: 'tradingview' }));
      }
    }
  } else {
    tradingView = { ok: false, reason: 'capture-unavailable' };
  }

  // One story under one company once, whichever feeds carried it: the publisher's own address
  // first, then the same headline from the aggregator. One story about two holdings stays under
  // both — the dashboard's rule.
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const keys = newsKeys(row);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    deduped.push({ ...row, late: row.at < window.from, keys });
  }
  const kept = deduped.filter((s) => !(s.late && s.keys.some((k) => sent.has(k))));
  return { source, tradingView, suppressed: deduped.length - kept.length, late: kept.filter((s) => s.late).length, ...group(kept.sort((a, b) => b.at - a.at), NEWS_LIMIT) };
}

// ---- 4. price moves on direct holdings -------------------------------------------------------------

const numeric = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Holdings whose last completed session moved MOVE_PCT or more, from the technicals capture. The
 * move is dated by its SESSION (`bar_date`, closing 15:30 IST), never by the capture — the file's
 * own rule — so a session belongs to the evening brief's window and its closes reach the file
 * the next morning: it travels as a late arrival in the morning brief, which is the truth.
 */
export async function readMoves({ env, window, holdings, sent = new Set() }) {
  const byTicker = new Map(holdings.map((h) => [h.ticker.toUpperCase(), h]));
  const tech = await readAsset(env, TECHNICALS_PATH);
  if (!Array.isArray(tech?.companies)) return { source: { ok: false, reason: 'capture-unavailable' }, rows: [], count: 0, late: 0, suppressed: 0 };
  const rows = [];
  for (const c of tech.companies) {
    const ticker = String(c?.ticker || '').toUpperCase();
    if (!byTicker.has(ticker)) continue;
    const pct = numeric(c.pct_change_today);
    if (pct == null || Math.abs(pct) < MOVE_PCT) continue;
    const barDate = typeof c.bar_date === 'string' ? c.bar_date : tech.price_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(barDate || '')) continue;
    const at = istInstant(barDate, SESSION_CLOSE);
    if (!(at >= window.since && at < window.to)) continue;
    rows.push({
      ticker, company: byTicker.get(ticker).name, pct, close: numeric(c.cmp), barDate, prevBarDate: c.prev_bar_date || c.move_prev_date || null,
      // `move_check` is the scrape's re-derivation of the move from the exchange's own closes.
      verified: c.move_check === 'confirmed' || c.move_check === 'corrected',
      at, late: at < window.from, keys: [`${ticker}|move:${barDate}`],
    });
  }
  rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  const kept = rows.filter((r) => !(r.late && r.keys.some((k) => sent.has(k)))).slice(0, MOVES_LIMIT);
  return {
    source: { ok: true, provider: typeof tech.source === 'string' ? tech.source : 'Yahoo Finance', priceDate: tech.price_date || null, generatedAt: tech.generated_at || null, threshold: MOVE_PCT },
    rows: kept, count: kept.length, late: kept.filter((r) => r.late).length, suppressed: rows.length - kept.length,
  };
}

/** Rows grouped per company, busiest company first, capped per company and overall. */
function group(rows, limit) {
  const byTicker = new Map();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, { ticker: row.ticker, company: row.company, items: [], more: 0 });
    byTicker.get(row.ticker).items.push(row);
  }
  const groups = [...byTicker.values()].sort((a, b) => b.items.length - a.items.length || a.company.localeCompare(b.company));
  let budget = limit;
  for (const g of groups) {
    g.items.sort((a, b) => b.at - a.at);
    const keep = Math.max(0, Math.min(PER_COMPANY_LIMIT, budget));
    g.more = g.items.length - keep;
    g.items = g.items.slice(0, keep);
    budget -= g.items.length;
  }
  return { groups: groups.filter((g) => g.items.length), count: rows.length, more: rows.length - groups.reduce((n, g) => n + g.items.length, 0) };
}

// ---- the brief -----------------------------------------------------------------------------------

/** The window an edition covers, plus `since`: where the PREVIOUS edition's window began. */
export function briefWindow(edition, day, settings, { to = null } = {}) {
  const window = editionWindow(edition, day, settings, { to });
  const previous = edition === 'morning' ? editionWindow('evening', previousWeekday(day), settings) : editionWindow('morning', day, settings);
  return { ...window, since: previous.from };
}

/**
 * Build one edition. Throws only when the BOOK cannot be read — an email about "direct holdings"
 * with no book behind it would be about nothing. Every other source reports its own failure on
 * the page instead. `sent` is the keys of the stories earlier briefs carried, from the delivery
 * log: a story from the previous window is included only if none of them sent it.
 */
export async function buildBrief({ edition, day, settings, env, fetcher = fetch, now = Date.now(), to = null, sent = null }) {
  if (!EDITIONS[edition]) throw Object.assign(new Error('Unknown edition'), { code: 'invalid-edition' });
  const book = await readAsset(env, BOOK_PATH);
  if (!Array.isArray(book?.holdings)) throw Object.assign(new Error('The portfolio book could not be read'), { code: 'book-unavailable' });
  const holdings = book.holdings.filter((h) => h?.ticker && h?.name);
  const window = briefWindow(edition, day, settings, { to });
  const sentKeys = sent instanceof Set ? sent : new Set(Array.isArray(sent) ? sent : []);
  const [markets, announcements, news, moves] = await Promise.all([
    readMarkets({ env, fetcher, now }),
    readAnnouncements({ env, fetcher, now, window, holdings, sent: sentKeys }),
    readNews({ env, window, holdings, sent: sentKeys }),
    readMoves({ env, window, holdings, sent: sentKeys }),
  ]);
  const brief = {
    version: 2, edition, day, at: window.at, builtAt: now,
    onDemand: to != null,
    window: { from: window.from, to: window.to, since: window.since },
    book: { asOf: book.asOf || null, lines: book.count ?? book.holdings.length, listed: holdings.length },
    markets, announcements, news, moves,
  };
  brief.ai = await readAiNotes({ env, fetcher, now, companies: briefCompanies(briefStories(brief)) });
  return brief;
}


// ---- stories -------------------------------------------------------------------------------------
//
// THE EMAIL IS A SATTVA VENTURES BROADSHEET, AND IT LEADS WITH THE PORTFOLIO COMPANIES. The desk
// reads it for what happened to the companies they own, so every filing and story is filed under
// its COMPANY, companies with a tracked or directional item first, and the global market scan
// follows them. Filings and published stories become one list of STORIES for that purpose, and
// two readings travel on each — both of them readings this dashboard already makes:
//
//   TOPIC  what the story is ABOUT, from the desk's thirty tracked keywords (data/news-keywords.js).
//          The seven topics fold those keyword families: Orders is the three order keywords,
//          Growth the rest of that family, Money is capital raising and results, Approvals & IP is
//          regulatory, Trouble is risk and governance, and a story matching nothing is Other.
//   MOOD   a direction, and only where a stated rule gives one: `announcementSignal()` over a
//          filing's own subject and category (dividend, order award, downgrade, default…). A
//          published headline carries NO sentiment reading anywhere on this dashboard, so a news
//          story's dot is Neutral — never a guess dressed as a judgement.

// The masthead is the family office's own name: this is Sattva Ventures' dashboard, not a platform
// newsletter. Munshot stays only as the small platform credit in the footer.
export const BRAND = 'Sattva Ventures';
export const PRODUCT_NAME = 'Research Central';
export const EDITION_NAME = 'Portfolio companies';
export const TAGLINES = { morning: 'Morning Portfolio Brief', evening: 'Evening Portfolio Brief' };

export const TOPICS = [
  { id: 'growth', label: 'Growth', color: '#10b981' },
  { id: 'orders', label: 'Orders', color: '#3b82f6' },
  { id: 'deals', label: 'Deals', color: '#8b5cf6' },
  { id: 'money', label: 'Money', color: '#f59e0b' },
  { id: 'approvals', label: 'Approvals & IP', color: '#14b8a6' },
  { id: 'trouble', label: 'Trouble', color: '#f43f5e' },
  { id: 'other', label: 'Other', color: '#64748b' },
];
const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
const ORDER_KEYWORDS = new Set(['order', 'orderbook', 'receipt-of-order']);
const TOPIC_BY_GROUP = { growth: 'growth', deals: 'deals', capital: 'money', results: 'money', regulatory: 'approvals', risk: 'trouble', research: 'other' };
export const MOODS = {
  good: { id: 'good', label: 'Good', color: '#10b981' },
  watch: { id: 'watch', label: 'Watch-out', color: '#f43f5e' },
  neutral: { id: 'neutral', label: 'Neutral', color: '#94a3b8' },
};

export function topicOf({ keywordIds = [], keywordGroups = [] } = {}) {
  if (keywordIds.some((id) => ORDER_KEYWORDS.has(id))) return TOPIC_BY_ID.get('orders');
  for (const group of keywordGroups) {
    const topic = TOPIC_BY_GROUP[group];
    if (topic && topic !== 'other') return TOPIC_BY_ID.get(topic);
  }
  return TOPIC_BY_ID.get('other');
}

// A filing's direction is `announcementSignal()`'s; a move's is its sign, by the dashboard's own
// price-move rule (a fall of MOVE_PCT or more is an alert there). A published headline has none.
const directional = (item) => item.kind === 'filing' || item.kind === 'move';
export const moodOf = (item) => (directional(item) && item.direction === 'positive' ? MOODS.good
  : directional(item) && item.direction === 'negative' ? MOODS.watch : MOODS.neutral);

/**
 * "NSE filing · Credit Rating" — the venue, and the exchange's own category where the headline
 * does not already carry it. A thin description puts that category IN the headline (see
 * `headlineOfNse`), and printing it again on the line underneath is one thing said twice. The
 * subject is reproduced as the exchange writes it, `-XBRL` suffix and all; only the comparison
 * ignores that suffix.
 */
export const filingDek = (item) => {
  const venue = `${item.exchanges.join(' and ')} filing`;
  const subject = item.subject ? String(item.subject).trim() : '';
  if (!subject) return venue;
  return norm(item.headline).includes(norm(subject.replace(/-\s*xbrl\s*$/i, ''))) ? venue : `${venue} · ${subject}`;
};

/** Every filing and story in the brief as one list, strongest first. */
export function briefStories(brief) {
  const rows = [];
  for (const g of brief.announcements.groups) {
    for (const item of g.items) rows.push({
      kind: 'filing', ticker: g.ticker, company: g.company, headline: item.headline,
      dek: filingDek(item), detail: Array.isArray(item.detail) && item.detail.length ? item.detail : null, detailOmitted: item.detailOmitted || 0,
      url: item.url, source: item.exchanges.join(' · '), at: item.at,
      keywords: item.keywords, keywordIds: item.keywordIds || [], keywordGroups: item.keywordGroups || [],
      direction: item.direction || 'neutral', importance: item.importance || 'low', late: item.late === true, keys: item.keys || [],
    });
  }
  for (const g of brief.news.groups) {
    for (const item of g.items) rows.push({
      kind: 'news', ticker: g.ticker, company: g.company, headline: item.headline,
      dek: item.summary || null, url: item.url, source: item.publisher || 'Publisher not recorded', at: item.at,
      keywords: item.keywords, keywordIds: item.keywordIds || [], keywordGroups: item.keywordGroups || [],
      direction: 'neutral', importance: item.keywords.length ? 'high' : 'low', related: item.attribution === 'related', late: item.late === true, keys: item.keys || [],
    });
  }
  for (const m of brief.moves?.rows || []) rows.push({
    kind: 'move', ticker: m.ticker, company: m.company,
    headline: `${m.pct < 0 ? 'Fell' : 'Rose'} ${Math.abs(m.pct).toFixed(1)}% at the ${storyDate(m.at)} close${m.close != null ? ` · ₹${fmtNumber(m.close, 2)}` : ''}`,
    dek: `${m.verified ? 'Close verified against the exchange\u2019s own figure' : 'Yahoo Finance close, not yet verified against the exchange'}${m.prevBarDate ? ` · against the ${m.prevBarDate} close` : ''}.`,
    url: null, source: `Price feed · ${brief.moves?.source?.provider || 'Yahoo Finance'}`, at: m.at,
    keywords: [], keywordIds: [], keywordGroups: [],
    direction: m.pct < 0 ? 'negative' : 'positive', importance: 'high', late: m.late === true, keys: m.keys || [],
  });
  const stories = rows.map((row) => {
    const topic = topicOf(row);
    const mood = moodOf(row);
    const score = (row.keywords.length ? 2 : 0) + (mood.id !== 'neutral' ? 1 : 0) + (row.importance === 'high' ? 1 : 0);
    return { ...row, topic, mood, score };
  });
  return stories.sort((a, b) => b.score - a.score || b.at - a.at);
}

/**
 * The stories filed under their companies. A company's rank is its strongest story (tracked
 * keyword, then a directional mood, then importance), then how much it had, then how recently —
 * so a downgrade or an order win leads the sheet, and a day of routine intimations reads newest
 * first. Within a company the same order holds. Nothing new is read: the score is `briefStories`'.
 */
export function briefCompanies(stories) {
  const byTicker = new Map();
  for (const s of stories) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, { ticker: s.ticker, company: s.company, stories: [] });
    const entry = byTicker.get(s.ticker);
    // The book's own name wins over a publisher match's spelling of it.
    if (s.kind === 'filing') entry.company = s.company;
    entry.stories.push(s);
  }
  const companies = [...byTicker.values()].map((c) => {
    c.stories.sort((a, b) => b.score - a.score || b.at - a.at);
    return {
      ...c, clusters: clusterStories(c.stories, { company: c.company }),
      score: c.stories[0].score,
      latest: Math.max(...c.stories.map((s) => s.at)),
      good: c.stories.filter((s) => s.mood.id === 'good').length,
      watch: c.stories.filter((s) => s.mood.id === 'watch').length,
    };
  });
  return companies.sort((a, b) => b.score - a.score || b.stories.length - a.stories.length || b.latest - a.latest || a.company.localeCompare(b.company));
}

export function briefStats(brief) {
  const stories = briefStories(brief);
  const companies = briefCompanies(stories);
  return {
    updates: companies.reduce((n, c) => n + c.clusters.length, 0),
    stories: stories.length,
    good: stories.filter((s) => s.mood.id === 'good').length,
    watch: stories.filter((s) => s.mood.id === 'watch').length,
    late: stories.filter((s) => s.late).length,
    companies,
  };
}

/** Every key the stories in this brief were sent under — what the next brief must not repeat. */
export const briefStoryKeys = (brief) => [...new Set(briefStories(brief).flatMap((s) => s.keys || []))];

/** The figures the panel keeps for a delivery — counts, never rows. */
export function briefSummary(brief) {
  const stats = briefStats(brief);
  return {
    quotes: brief.markets.rows.filter((r) => r.last != null).length,
    quotesFailed: brief.markets.failed,
    announcements: brief.announcements.count,
    news: brief.news.count,
    updates: stats.updates, aiAnswered: brief.ai?.answered || 0, aiEligible: brief.ai?.eligible || 0, aiReason: brief.ai?.reason || null,
    stories: stats.stories, companies: stats.companies.length, good: stats.good, watch: stats.watch,
    moves: brief.moves?.count ?? 0, late: stats.late,
    suppressed: (brief.announcements.suppressed || 0) + (brief.news.suppressed || 0) + (brief.moves?.suppressed || 0),
    nse: brief.announcements.nse.ok, history: brief.announcements.history?.ok === true, bse: brief.announcements.bse.ok,
    // How many XBRL filings gave up their own particulars, and how many would not be read. Two
    // numbers rather than one: a send that reached none of them and a send that had none to reach
    // are different states, and only the first is worth looking at.
    filingsRead: brief.announcements.filings?.ok ?? 0, filingsUnread: (brief.announcements.filings?.candidates ?? 0) - (brief.announcements.filings?.ok ?? 0),
    publishers: brief.news.source.ok, tradingView: brief.news.tradingView?.ok === true, prices: brief.moves?.source?.ok === true,
  };
}

// ---- formatting ----------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNumber = (v, decimals) => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const signed = (v, decimals, suffix = '') => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNumber(Math.abs(v), decimals) + suffix;
// The sheet is Sattva's own palette, resolved to literals because an email carries no stylesheet
// and no custom property: --ink-900, --ink-600, --neutral and the slate ramp from index.html.
const INK = '#0f172a', PAPER = '#ffffff', SHELL = '#eef2f7', RULE = '#e2e8f0', META = '#64748b', BODY = '#334155', BODY2 = '#475569';
// Sattva Ventures' indigo, from the :root tokens in public/index.html (--brand-600 / indigo-300).
// The ramp's purple and pink are a GRADIENT on the page and email clients do not render one, so
// the brand reaches the sheet as its indigo start — never as a semantic emerald/amber/rose.
const ACCENT = '#4f46e5', ACCENT_LIGHT = '#a5b4fc';
const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = 'Arial,Helvetica,sans-serif';
const toneOf = (v) => (v > 0 ? MOODS.good.color : v < 0 ? MOODS.watch.color : MOODS.neutral.color);

export function formatLast(row) {
  if (row.last == null) return null;
  if (row.kind === 'yield') return `${fmtNumber(row.last, 2)}%`;
  if (row.kind === 'fx') return fmtNumber(row.last, row.last < 10 ? 4 : 2);
  return fmtNumber(row.last, 2);
}

export function formatChange(row) {
  if (row.change == null) return null;
  if (row.kind === 'yield') return signed(row.change * 100, 1, ' bp');
  return signed(row.change, row.kind === 'fx' && row.last < 10 ? 4 : 2);
}

export const formatPct = (row) => (row.changePct == null ? null : signed(row.changePct, 2, '%'));

const zoneShort = (ms, timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', hour12: false }).formatToParts(ms);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
  } catch {
    return istLabel(ms);
  }
};

/** "Close · Wed 16:00 EDT", "Live · Thu 07:58 JST", or "unavailable" — never a number. */
export function asOfLabel(row) {
  if (row.state === 'unavailable') return 'unavailable';
  const when = row.timezone ? zoneShort(row.asOf, row.timezone) : istLabel(row.asOf);
  return `${row.state === 'live' ? 'Live' : 'Close'} · ${when}`;
}

export function glanceLine(brief) {
  const byId = new Map(brief.markets.rows.map((r) => [r.id, r]));
  const parts = [];
  for (const id of GLANCE[brief.edition] || []) {
    const row = byId.get(id);
    if (!row || row.last == null) continue;
    const pct = formatPct(row);
    if (row.kind === 'price') parts.push(`${row.label} $${formatLast(row)}`);
    else if (row.kind === 'fx') parts.push(`${row.label} ${formatLast(row)}`);
    else if (pct) parts.push(`${row.label} ${pct}`);
  }
  return parts.join(' · ');
}

const shortDate = (ms) => istLabel(ms, { time: false }).replace(/^\w{3} /, '');
const STORY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
/** "16 Sept" — the story date as the broadsheet prints it; the window strip carries the times. */
export const storyDate = (ms) => { const d = new Date(ms + 5.5 * 3600 * 1000); return `${d.getUTCDate()} ${STORY_MONTHS[d.getUTCMonth()]}`; };
/** "8:00 AM IST" from "08:00". */
const clockLabel = (time) => { const [h, m] = String(time).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} IST`; };

/** "Sattva Ventures · 12 updates on your portfolio companies — 17 Sep" */
export function briefSubject(brief, { brand = BRAND } = {}) {
  const n = briefStats(brief).updates;
  return `${brand} · ${n} update${n === 1 ? '' : 's'} on your ${EDITION_NAME.toLowerCase()} — ${shortDate(brief.at)}`;
}

const windowLine = (brief) => `${istLabel(brief.window.from)} → ${istLabel(brief.window.to)}`;
const groupNote = (brief, groupId) => {
  if (groupId === 'us') return brief.edition === 'morning' ? 'previous session' : 'last close';
  if (groupId === 'asia') return brief.edition === 'morning' ? 'this morning' : 'today';
  if (groupId === 'india') return brief.edition === 'morning' ? 'previous close' : "today's close";
  return null;
};

// ---- the email -----------------------------------------------------------------------------------
//
// Email-safe only: tables, inline styles, web-safe fonts, a fluid 760px sheet, light mode declared.
// No stylesheet, no script, no web font, no gradient — what Gmail, Outlook and Apple Mail render.

const dot = (color, size = 8, square = false) => `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:${square ? 1 : size}px;background:${color};vertical-align:middle;"></span>`;
const caps = (text, extra = '') => `<span style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;${extra}">${text}</span>`;
// Every link opens in a new tab — in the preview page and in a web mail client alike — so reading a
// filing never takes the reader away from the brief they were working down.
const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';
const link = (url, inner, style) => (url ? `<a href="${esc(url)}" ${NEW_TAB} style="${style}text-decoration:none;">${inner}</a>` : inner);

/**
 * WHERE "READ" GOES FOR A FILING NSE PUBLISHED AS XBRL — the dashboard's own readable copy of it.
 *
 * The exchange's address for one of these is a `WebXMLFile....xml`, and a browser opens it as
 * "This XML file does not appear to have any style information associated with it" above a tree of
 * SEBI namespaces. That is what the desk was clicking into. `/filing` renders the same document
 * server-side through the same parser the dashboard's filing panel uses, and links the original
 * file from its own head and foot — so this moves where the link LANDS and takes nothing away.
 * Every other link in the brief still goes straight to the publisher or the exchange.
 */
export const readableUrl = (url, dashboardUrl) => (isXbrlFilingUrl(url) && dashboardUrl
  ? `${dashboardUrl}/filing?src=${encodeURIComponent(url)}` : url);

/** The filing's own particulars, as filed — the label muted, the company's value in full. */
const detailHtml = (s) => (Array.isArray(s.detail) && s.detail.length ? `
  <div style="margin-top:5px;font-family:${SANS};font-size:14px;line-height:1.65;color:${BODY2};">${s.detail
    .map((f) => `<span style="color:${META};">${esc(f.label)}:</span> ${esc(f.value)}${f.unit && !/^pure$/i.test(f.unit) ? ` <span style="color:${META};">${esc(f.unit)}</span>` : ''}`)
    .join(' &nbsp;·&nbsp; ')}${s.detailOmitted ? ` <span style="color:${META};">· and ${s.detailOmitted} more field${s.detailOmitted === 1 ? '' : 's'} in the filing</span>` : ''}</div>` : '');

/** The filing's own particulars as one line, for the plain-text copy. */
export const detailLine = (s) => (Array.isArray(s.detail) && s.detail.length
  ? `${s.detail.map(factStatement).join(' · ')}${s.detailOmitted ? ` · and ${s.detailOmitted} more field${s.detailOmitted === 1 ? '' : 's'} in the filing` : ''}`
  : null);
/** The dashboard's All Alerts view, narrowed to one company — the same route the host ticker chip opens. */
const companyUrl = (dashboardUrl, ticker) => (/^[A-Z0-9&_.-]{1,20}$/.test(ticker || '')
  ? `${dashboardUrl}/#/research/daily-alerts?scope=portfolio&company=${encodeURIComponent(ticker)}` : null);

function marketSection(brief) {
  const m = brief.markets;
  const note = [
    `quotes ${esc(istTime(m.readAt))} IST`,
    m.failed.length ? `${m.failed.length} unavailable` : null,
  ].filter(Boolean).join(' · ');
  const glance = glanceLine(brief);
  const rows = [];
  for (const g of MARKET_GROUPS) {
    const members = m.rows.filter((r) => r.group === g.id);
    if (!members.length) continue;
    const gnote = groupNote(brief, g.id);
    rows.push(`<tr><td colspan="3" style="padding:10px 0 3px;font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${META};">${esc(g.label)}${gnote ? ` <span style="letter-spacing:0;text-transform:none;">· ${esc(gnote)}</span>` : ''}</td></tr>`);
    for (const r of members) {
      const last = formatLast(r);
      const pct = formatPct(r);
      const tone = r.changePct == null ? META : toneOf(r.changePct);
      rows.push(`<tr>
        <td width="46%" style="padding:9px 6px 9px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:13px;line-height:1.5;color:${INK};">${esc(r.label)}${r.unit ? ` <span style="color:${META};font-size:10px;">${esc(r.unit)}</span>` : ''}<br><span style="font-size:10px;color:${META};">${esc(asOfLabel(r))}</span></td>
        <td width="30%" align="right" style="padding:9px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:12px;line-height:1.5;color:${INK};">${last == null ? `<span style="color:${META};">—</span>` : esc(last)}${r.change == null ? '' : `<br><span style="font-size:10px;color:${META};">${esc(formatChange(r))}</span>`}</td>
        <td width="24%" align="right" style="padding:9px 0 9px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:12px;font-weight:bold;color:${tone};">${pct == null ? `<span style="color:${META};font-weight:normal;">—</span>` : esc(pct)}</td>
      </tr>`);
    }
  }
  return `<tr><td style="padding:30px 24px 0;">
    <div style="padding-bottom:8px;border-bottom:1px solid ${INK};">${caps('Global market scan', `color:${INK};font-weight:bold;letter-spacing:2px;`)}<div style="margin-top:5px;font-family:${SANS};font-size:11px;color:${META};">${note}</div></div>
    ${glance ? `<div style="padding:8px 0 2px;font-family:${SANS};font-size:14px;line-height:1.65;color:${BODY};">${esc(glance)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.join('')}</table>
  </td></tr>`;
}

const aiNoteHtml = note => `<div style="margin-top:10px;padding:12px 14px;background:#eef2ff;border-left:3px solid ${ACCENT_LIGHT};font-family:${SANS};font-size:14px;line-height:1.65;color:${BODY};"><strong style="font-size:11px;letter-spacing:1px;color:${ACCENT};">AI SUMMARY</strong><br>${esc(note.summary)}<br><strong style="font-size:11px;letter-spacing:1px;color:${ACCENT};">POTENTIAL IMPACT · AI</strong><br>${esc(note.impact)}</div>`;
const relatedHtml = (k, dashboardUrl) => k.others.length ? `<div style="margin-top:9px;font-family:${SANS};font-size:12px;line-height:1.65;color:${META};"><strong>Related coverage</strong><br>${k.others.map(r => `${link(readableUrl(r.url, dashboardUrl), esc(r.headline), `color:${BODY};text-decoration:underline;`)}<br>${esc(r.source)} · ${esc(storyDate(r.at))}, ${esc(istTime(r.at))} IST${r.related ? ' · related entity' : ''}${r.late ? ' · not in the previous brief' : ''}${r.dek ? `<br>${esc(r.dek)}` : ''}`).join('<br>')}</div>` : '';

const topicTag = (topic) => caps(esc(topic.label), `color:${topic.color};font-weight:bold;letter-spacing:1px;`);

/** One story under its company: the exchange's or publisher's own headline, then where and when. */
const companyStory = (k, note, isFirst, dashboardUrl) => {
  const s = k.main;
  const href = readableUrl(s.url, dashboardUrl);
  const label = href !== s.url ? 'Read the filing →' : 'Read →';
  return `<tr><td style="padding:${isFirst ? '10px' : '12px'} 0 11px;${isFirst ? '' : `border-top:1px solid ${RULE};`}">
  <div style="font-family:${SERIF};font-size:19px;line-height:1.45;font-weight:bold;color:${INK};">${link(href, esc(s.headline), `color:${INK};`)}</div>
  ${s.dek ? `<div style="margin-top:4px;font-family:${SANS};font-size:14px;line-height:1.65;color:${BODY2};">${esc(s.dek)}</div>` : ''}
  ${note ? aiNoteHtml(note) : ''}
  ${detailHtml(s)}
  <div style="margin-top:6px;font-family:${SANS};font-size:12px;line-height:1.65;color:${META};">${topicTag(s.topic)} &nbsp;·&nbsp; ${dot(s.mood.color)} ${esc(s.mood.label)} · ${esc(s.source)} · ${esc(storyDate(s.at))}, ${esc(istTime(s.at))} IST${s.related ? ' · related entity' : ''}${s.late && s.kind !== 'move' ? ' · not in the previous brief' : ''}${href ? ` · <a href="${esc(href)}" ${NEW_TAB} style="color:${ACCENT};font-weight:bold;text-decoration:none;">${label}</a>` : ''}</div>
  ${relatedHtml(k, dashboardUrl)}
</td></tr>`;
};

/** A portfolio company and everything filed or published about it in the window. */
function companyBlock(c, dashboardUrl, ai) {
  const n = c.clusters.length;
  const counts = [
    `${n} update${n === 1 ? '' : 's'}${c.stories.length > n ? ` from ${c.stories.length} source items` : ''}`,
    c.good ? `<span style="color:${MOODS.good.color};">${c.good} good</span>` : null,
    c.watch ? `<span style="color:${MOODS.watch.color};">${c.watch} watch-out${c.watch === 1 ? '' : 's'}</span>` : null,
  ].filter(Boolean).join(' · ');
  const href = companyUrl(dashboardUrl, c.ticker);
  return `<tr><td style="padding:28px 0 0;">
    <div style="padding-bottom:10px;border-bottom:2px solid ${INK};">
      <div style="font-family:${SERIF};font-size:26px;line-height:1.2;font-weight:bold;color:${INK};">${link(href, esc(c.company), `color:${INK};`)}</div>
      <div style="margin-top:6px;font-family:${SANS};font-size:14px;line-height:1.65;color:${META};">${esc(c.ticker)} · ${counts}</div>
      ${href ? `<div style="margin-top:4px;font-family:${SANS};font-size:12px;"><a href="${esc(href)}" ${NEW_TAB} style="color:${ACCENT};font-weight:bold;text-decoration:none;">On the dashboard →</a></div>` : ''}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${c.clusters.map((k, i) => companyStory(k, ai?.items?.[k.id], i === 0, dashboardUrl)).join('')}</table>
  </td></tr>`;
}

export function sourcesNote(brief) {
  const a = brief.announcements;
  const n = brief.news;
  const m = brief.moves || { source: { ok: false } };
  const dated = (iso) => (iso ? istLabel(Date.parse(iso)) : 'an unknown time');
  const before = (iso) => iso && Date.parse(iso) < brief.window.to;
  const bits = [];
  bits.push(a.nse.ok ? `NSE feed read ${istLabel(a.nse.readAt)}` : `NSE feed could not be read (${a.nse.reason || 'unavailable'})`);
  bits.push(a.history?.ok && a.history.days.length ? `retained NSE filings for ${a.history.days.join(', ')} (captured ${dated(a.history.capturedAt)})` : 'no retained NSE filings for this window');
  bits.push(a.bse.ok ? `BSE capture dated ${dated(a.bse.capturedAt)}${before(a.bse.capturedAt) ? ', so later BSE filings follow in the next brief' : ''}` : 'BSE capture unavailable');
  // COVERAGE THAT STOPS SHORT SAYS SO. A filing whose particulars were read carries them on its
  // line; one the budget did not reach, or that NSE would not answer for, carries its headline
  // exactly as before — so the difference between the two is stated rather than inferred from
  // which rows happen to look fuller.
  if (brief.announcements.filings?.candidates) {
    const f = brief.announcements.filings;
    const unread = f.candidates - f.ok;
    bits.push(`${f.ok} of ${f.candidates} XBRL filing${f.candidates === 1 ? '' : 's'} read for the particulars they carry${unread ? `, ${unread} not read here and reachable in full through ${unread === 1 ? 'its own link' : 'their own links'}` : ''}`);
  }
  bits.push(n.source.ok
    ? `publisher feeds (${n.source.publishers.join(', ') || 'four publishers'}) captured ${dated(n.source.capturedAt)}${before(n.source.capturedAt) ? ', so later stories follow in the next brief' : ''}${n.source.reachesWindow === false && n.source.oldestAt ? `, reaching back only to ${istLabel(n.source.oldestAt)}` : ''}`
    : 'publisher capture unavailable');
  bits.push(n.tradingView?.ok ? `TradingView portfolio headlines captured ${dated(n.tradingView.capturedAt)}` : 'TradingView portfolio headlines unavailable');
  if (m.source.ok) {
    // The session a brief could carry: yesterday's for the morning, today's for the evening —
    // and today's closes are captured overnight, so the evening says so instead of "not captured".
    const expected = brief.edition === 'morning' ? previousWeekday(brief.day) : brief.day;
    if (m.source.priceDate && m.source.priceDate >= expected) bits.push(`closes for the ${m.source.priceDate} session captured ${dated(m.source.generatedAt)} (moves of ${m.source.threshold}% or more)`);
    else if (brief.edition === 'evening') bits.push(`today's closes are captured overnight and reach the morning brief (moves of ${m.source.threshold}% or more)`);
    else bits.push(`closes for the ${expected} session not yet captured (latest ${m.source.priceDate || 'unknown'}), so its moves follow in the next brief`);
  } else {
    bits.push('session closes unavailable, so price moves are not included');
  }
  const ai = brief.ai;
  if (ai?.eligible) bits.push(ai.ok ? `AI notes on ${ai.answered} of ${ai.eligible} eligible updates; other updates retain their source text` : `AI notes unavailable (${ai.reason || 'unavailable'}); source text retained`);
  const late = briefStats(brief).late;
  const carried = late ? ` ${late} item${late === 1 ? '' : 's'} from before this window were not in the previous brief and ${late === 1 ? 'is' : 'are'} included.` : '';
  return `Window ${windowLine(brief)} · ${bits.join(' · ')}.${carried}`;
}

/**
 * The email. `recipient` personalises the footer only, so one build serves every subscriber.
 */
export function renderBriefHtml(brief, { dashboardUrl = PRODUCTION_ORIGIN, recipient = null, productName = PRODUCT_NAME, brand = BRAND, settings = null, pdfUrl = null } = {}) {
  const subject = briefSubject(brief, { brand });
  const stats = briefStats(brief);
  const sendTime = settings?.[brief.edition]?.time || EDITIONS[brief.edition].defaultTime;
  const unsubscribeUrl = `${dashboardUrl}/#/research/ask-research?newsletter=manage`;
  const parts = [];
  const downloadUrl = pdfUrl || `${dashboardUrl}/api/newsletter/preview?edition=${brief.edition}&format=pdf`;
  parts.push(`<tr><td align="right" style="padding:18px 24px 0;font-family:${SANS};"><a href="${esc(downloadUrl)}" ${NEW_TAB} style="display:inline-block;padding:10px 16px;background:${ACCENT};border-radius:4px;color:#ffffff;font-size:12px;font-weight:bold;text-decoration:none;">Download PDF ↓</a></td></tr>`);

  parts.push(`<tr><td align="center" style="padding:30px 24px 0;">
    <div style="font-family:${SERIF};font-size:30px;line-height:1.2;font-weight:bold;letter-spacing:3px;color:${INK};">${esc(brand.toUpperCase())}</div>
    <div style="border-top:3px double ${INK};margin:12px 0 7px;font-size:0;line-height:0;">&nbsp;</div>
    <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${META};">${esc(productName)} — ${esc(TAGLINES[brief.edition])}</div>
    <div style="margin-top:10px;padding:7px 0;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${META};">${esc(istDateLong(brief.at).replace(/^(\w+) /, '$1, '))} · Edition: ${esc(EDITION_NAME)}${brief.onDemand ? ' · built on request' : ''}</div>
  </td></tr>`);

  const reported = stats.companies.length;
  parts.push(`<tr><td style="padding:14px 24px 0;font-family:${SANS};font-size:14px;line-height:1.65;color:${BODY};">
    <strong style="color:${INK};">${stats.updates} ${stats.updates === 1 ? 'update' : 'updates'}</strong> across <strong style="color:${INK};">${reported} of ${brief.book.listed}</strong> portfolio compan${brief.book.listed === 1 ? 'y' : 'ies'} &nbsp;·&nbsp; ${dot(MOODS.good.color, 9)} ${stats.good} good &nbsp;·&nbsp; ${dot(MOODS.watch.color, 9)} ${stats.watch} watch-out${stats.watch === 1 ? '' : 's'}${stats.late ? ` &nbsp;·&nbsp; ${stats.late} not in the previous brief` : ''}
  </td></tr>`);

  parts.push(`<tr><td style="padding:24px 24px 0;">
    <div style="padding-bottom:8px;border-bottom:3px solid ${ACCENT_LIGHT};">${caps('Your portfolio companies', `color:${INK};font-weight:bold;letter-spacing:2px;`)}<div style="margin-top:6px;font-family:${SANS};font-size:12px;line-height:1.5;color:${META};">${esc(windowLine(brief))}</div></div>
  </td></tr>`);

  if (!stats.stories) {
    parts.push(`<tr><td align="center" style="padding:30px 24px 6px;">
      <div style="font-family:${SERIF};font-size:20px;line-height:1.3;font-style:italic;color:${INK};">Quiet window — nothing to report.</div>
      <div style="margin-top:8px;font-family:${SANS};font-size:12px;line-height:1.65;color:${META};">${brief.announcements.nse.ok || brief.announcements.history?.ok || brief.announcements.bse.ok || brief.news.source.ok || brief.news.tradingView?.ok ? 'Nothing was filed or published about a portfolio company in this window.' : 'No filing or publisher feed could be read for this window, so stories are not known — not absent.'}</div>
    </td></tr>`);
  } else {
    parts.push(`<tr><td style="padding:0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${stats.companies.map((c) => companyBlock(c, dashboardUrl, brief.ai)).join('')}</table>
    </td></tr>`);
    const more = brief.announcements.more + brief.news.more + (brief.moves?.more || 0);
    if (more > 0) parts.push(`<tr><td style="padding:14px 24px 0;font-family:${SANS};font-size:12px;line-height:1.65;color:${META};">${more} more in this window on the <a href="${esc(`${dashboardUrl}/#/research/daily-alerts?scope=portfolio`)}" ${NEW_TAB} style="color:${ACCENT};font-weight:bold;text-decoration:none;">dashboard →</a></td></tr>`);
  }

  parts.push(marketSection(brief));
  parts.push(`<tr><td style="padding:22px 24px 0;font-family:${SANS};font-size:10px;line-height:1.6;color:${META};">${esc(sourcesNote(brief))}</td></tr>`);

  const subscribedLine = recipient?.test
    ? 'This is a test copy you asked for.'
    : `You're subscribed to the ${esc(brand)} brief on your ${esc(EDITION_NAME.toLowerCase())}, every weekday at ${esc(clockLabel(sendTime))}.${recipient?.addedBy ? ` Added by ${esc(recipient.addedBy)}.` : ''}`;
  const disclaimer = 'Source headlines and filing particulars are preserved. Related publisher coverage is grouped with every source linked. AI summary and potential impact notes use the supplied headlines and summaries only, not the full documents; possible impacts are not established facts. Mood follows this dashboard’s stated filing and price-move rules; published stories are shown neutral. This brief is informational, not investment advice.';
  parts.push(`<tr><td style="padding:22px 24px;background:${INK};color:#cbd5e1;font-family:${SANS};font-size:12px;line-height:1.7;">
    ${subscribedLine}<br>
    <a href="${esc(unsubscribeUrl)}" ${NEW_TAB} style="color:${ACCENT_LIGHT};text-decoration:underline;">Unsubscribe</a> · <strong style="color:${ACCENT_LIGHT};letter-spacing:1px;">${esc(brand)}</strong> ${esc(productName)} · Automated by Munshot<br>
    <span style="color:#94a3b8;font-size:10px;">${esc(disclaimer)} Sent ${esc(istLabel(brief.builtAt, { year: true }))}.</span>
  </td></tr>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<base target="_blank">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${SHELL};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SHELL};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:760px;table-layout:fixed;overflow-wrap:break-word;background:${PAPER};border:1px solid ${RULE};">
${parts.join('\n')}
</table>
<div style="padding-top:12px;font-family:${SANS};font-size:10px;letter-spacing:1px;color:#94a3b8;">${esc(brand)} · ${esc(productName)}</div>
</td></tr></table>
</body>
</html>`;
}

/** The same brief as plain text — what the tests read, and a copy that survives any client. */
export function renderBriefText(brief, { productName = PRODUCT_NAME, brand = BRAND, dashboardUrl = PRODUCTION_ORIGIN } = {}) {
  const stats = briefStats(brief);
  const lines = [];
  lines.push(brand.toUpperCase(), `${productName} — ${TAGLINES[brief.edition]}`, `${istDateLong(brief.at)} · Edition: ${EDITION_NAME}`);
  lines.push(`${stats.updates} updates across ${stats.companies.length} of ${brief.book.listed} portfolio companies · ${stats.good} good · ${stats.watch} watch-outs`);
  lines.push('', `YOUR PORTFOLIO COMPANIES · ${windowLine(brief)}`);
  if (!stats.stories) lines.push('Quiet window — nothing to report.');
  for (const c of stats.companies) {
    lines.push('', `${c.company} (${c.ticker}) · ${c.clusters.length} update${c.clusters.length === 1 ? '' : 's'}${c.stories.length > c.clusters.length ? ` from ${c.stories.length} source items` : ''}`);
    for (const k of c.clusters) {
      const s = k.main;
      const note = brief.ai?.items?.[k.id];
      const detail = detailLine(s);
      const href = readableUrl(s.url, dashboardUrl);
      lines.push(`  [${s.topic.label}] ${s.headline}`);
      if (s.dek) lines.push(`    ${s.dek}`);
      if (note) lines.push(`    AI summary: ${note.summary}`, `    Potential impact (AI): ${note.impact}`);
      if (detail) lines.push(`    ${detail}`);
      lines.push(`    ${s.mood.label} · ${s.source} · ${istLabel(s.at)}${s.late && s.kind !== 'move' ? ' · not in the previous brief' : ''}${href ? ` · ${href}` : ''}`);
      for (const r of k.others) lines.push(`    Related: ${r.headline} · ${r.source} · ${istLabel(r.at)}${r.related ? ' · related entity' : ''}${r.late ? ' · not in the previous brief' : ''}${r.url ? ` · ${readableUrl(r.url, dashboardUrl)}` : ''}${r.dek ? ` · ${r.dek}` : ''}`);
    }
  }
  lines.push('', 'GLOBAL MARKET SCAN');
  for (const g of MARKET_GROUPS) {
    const members = brief.markets.rows.filter((r) => r.group === g.id);
    if (!members.length) continue;
    lines.push(`  ${g.label}`);
    for (const r of members) lines.push(`    ${r.label.padEnd(20)} ${(formatLast(r) ?? '—').padStart(11)} ${(formatPct(r) ?? '—').padStart(8)}   ${asOfLabel(r)}`);
  }
  lines.push('', sourcesNote(brief), '', 'Sattva Ventures · Automated by Munshot');
  return lines.join('\n');
}
