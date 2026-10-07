// data/announcement-index-shared.js — THE SERVER-SIDE CORPORATE ANNOUNCEMENTS INDEX: ITS FORMAT AND ITS
// QUERY, defined once.
//
// The Corporate Announcements stream is every retained filing from BSE's date capture, its monthly
// archive, NSE's retained window and live feed, the scheduled per-company captures and the backup
// index — 192,598 filings for 5,931 companies on 1 October 2026, about 180 MB of JSON. The tab used to
// download and merge all of it in the browser. Now `scripts/build-announcement-index.mjs` performs that
// same merge ONCE on the runner (with the browser's own modules, so the rows are identical), tags,
// scores and stitches every filing, and publishes the result as one Actions artifact; a Durable
// Object answers filtered, ranked, paginated queries over it (worker/announcement-index-store.mjs).
// The browser receives one page at a time.
//
// This module is the contract between the three. It is pure — no fetch, no DOM, no Node API — so the
// runner, the Worker and the browser's fallback engine (data/announcement-query-local.js) all import
// it and cannot disagree about what a row is, which rows a query selects, or the order they come in.

import { newsDay, newsPeriodBounds } from './news-window.js';
import { ANNOUNCEMENT_CATEGORIES, categoryMask, maskCategories, maskHas, CATEGORY_VERSION } from './announcement-categories.js';
import { parseMcapRange, inMcapRange, mcapBand, MCAP_BANDS, MCAP_UNKNOWN } from './company-profile.js';
import { featureKeys, learnedAdjustment } from './relevance-feedback-shared.js';

export const INDEX_CONTRACT = 'announcement-index-v1';
export const INDEX_ARTIFACT = 'announcement-index';
export const INDEX_WORKFLOW = 'announcement-index-refresh.yml';
export const INDEX_MEMBER = 'index.json';
export const COMPANIES_MEMBER = 'companies.json.gz';
export const UNDATED = 'undated';
export const packMember = (month) => `packs/${month}.bin`;
export const isIndexMember = (name) => name === INDEX_MEMBER || name === COMPANIES_MEMBER || /^packs\/(?:\d{4}-\d{2}|undated)\.bin$/.test(name);

export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 500;
export const QUERY_TEXT_MAX = 200;
export const SCOPE_COMPANIES_MAX = 1500;

/** The periods the table offers, in IST — the same calendar windows the other news views use. */
export const ANNOUNCEMENT_PERIODS = Object.freeze([
  { value: 'today', label: 'Today' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: 'month', label: 'This month' },
  { value: '30', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
  { value: 'undated', label: 'Date not supplied' },
]);
export const DEFAULT_PERIOD = 'today';

// ---------------------------------------------------------------------------------------------
// The compact row — a positional array, because 192,598 objects with named keys are most of the
// artifact's size and most of a Durable Object's memory.
// ---------------------------------------------------------------------------------------------
export const ROW = Object.freeze({
  ID: 0, TIME: 1, COMPANY: 2, TITLE: 3, SUB: 4, CATEGORY: 5, SOURCES: 6, URL: 7, EXTRA_URLS: 8, MASK: 9, WEAK: 10, BASE: 11,
  IMPACT: 12, DIRECTION: 13, FLAGS: 14, EVENT: 15, EVENT_SIZE: 16, EVENT_POS: 17, EVENT_FIRST: 18, EVENT_LAST: 19,
  PROVIDERS: 20, SUMMARY: 21, REFERENCE: 22, DOC: 23, NAME: 24,
});
export const FLAG = Object.freeze({ PROSPECTIVE: 1, PROCESS: 2, DUPLICATE: 4, REPEAT: 8, NO_DOCUMENT: 16, CRITICAL: 32 });
export const IMPACTS = Object.freeze([null, 'vhigh', 'high', 'mid', 'low', 'tiny', 'abs-large', 'abs-mid', 'abs-small']);
export const DIRECTIONS = Object.freeze([null, 'positive', 'negative', 'neutral']);
const code = (list, value) => Math.max(0, list.indexOf(value ?? null));

/**
 * One filing as the index stores it. `dict` interns repeated strings (source sets, providers); the
 * builder writes it into index.json and the reader passes it back to `displayRow`.
 */
export function encodeRow(r, { companyIdx, dict }) {
  const intern = (table, value) => {
    const key = JSON.stringify(value || []);
    let i = table.index.get(key);
    if (i === undefined) { i = table.list.length; table.list.push(value || []); table.index.set(key, i); }
    return i;
  };
  const flags = (r.prospective ? FLAG.PROSPECTIVE : 0) | (r.processUpdate ? FLAG.PROCESS : 0) | (r.duplicate ? FLAG.DUPLICATE : 0)
    | (r.repeat ? FLAG.REPEAT : 0) | (r.documentUnavailable ? FLAG.NO_DOCUMENT : 0) | (r.critical ? FLAG.CRITICAL : 0);
  return [
    r.id, r.time || '', companyIdx, r.title || '', r.subCategory || '', r.category || '', intern(dict.sources, r.sources), r.url || '',
    r.extraUrls?.length ? r.extraUrls : 0, categoryMask(r.categories), categoryMask(r.weak || []), r.base,
    code(IMPACTS, r.impact), code(DIRECTIONS, r.direction), flags,
    r.eventId || 0, r.eventSize || 1, r.eventPos || 0, r.eventFirst || 0, r.eventLast || 0,
    intern(dict.providers, r.providers), r.summary || '', r.referenceUrl || '', r.doc || '', r.company || '',
  ];
}

/** The size bands in the order a day's facet counts store them. */
export const BAND_ORDER = Object.freeze([...MCAP_BANDS.map((b) => b.id), MCAP_UNKNOWN]);

/**
 * A day's counts by category and size band: `{ '*': [n per band], [categoryId]: [n per band] }`.
 * The index writes one per day so an unfiltered query — or one narrowed to one category and one band
 * — knows how many rows every day holds without decoding it, and decodes only the days its page shows.
 */
export function dayFacets(rows, companyAt) {
  const out = { '*': BAND_ORDER.map(() => 0) };
  for (const row of rows) {
    const company = companyAt(row[ROW.COMPANY]) || {};
    const band = Math.max(0, BAND_ORDER.indexOf(company.b || mcapBand(company.m)));
    out['*'][band] += 1;
    for (const id of maskCategories(row[ROW.MASK])) (out[id] ||= BAND_ORDER.map(() => 0))[band] += 1;
  }
  return out;
}

export function emptyDict() {
  return { sources: { list: [], index: new Map() }, providers: { list: [], index: new Map() } };
}

/**
 * A stored row as the table, the AI Read popup and the export read it. Field names follow the rows
 * the browser's own feed produces, so the table renderer reads both alike.
 */
export function displayRow(row, day, { companies, dict, score = null }) {
  const c = companies[row[ROW.COMPANY]] || {};
  const sources = dict.sources[row[ROW.SOURCES]] || [];
  const extra = Array.isArray(row[ROW.EXTRA_URLS]) ? row[ROW.EXTRA_URLS] : [];
  const sourceUrls = [...(row[ROW.URL] ? [{ source: sources[0] || null, url: row[ROW.URL] }] : []), ...extra.map(([source, url]) => ({ source, url }))];
  const mask = row[ROW.MASK];
  return {
    id: row[ROW.ID], date: day === UNDATED ? null : day, time: row[ROW.TIME] || null,
    companyKey: c.k || null, ticker: c.t || null, isin: c.i || null, scripCode: c.s || null,
    company: row[ROW.NAME] || c.n || null, title: row[ROW.TITLE] || null, subCategory: row[ROW.SUB] || null, category: row[ROW.CATEGORY] || null,
    summary: row[ROW.SUMMARY] || null, sources, source: sources[0] || null, providers: dict.providers[row[ROW.PROVIDERS]] || [],
    url: row[ROW.URL] || null, referenceUrl: row[ROW.REFERENCE] || null, sourceUrls,
    documentUnavailable: !!(row[ROW.FLAGS] & FLAG.NO_DOCUMENT) || undefined,
    critical: !!(row[ROW.FLAGS] & FLAG.CRITICAL) || undefined,
    categories: maskCategories(mask), weakCategories: maskCategories(row[ROW.WEAK]),
    mcapCr: Number.isFinite(c.m) ? c.m : null, mcapAsOf: c.ma || null, mcapSource: c.ms || null, band: c.b || MCAP_UNKNOWN, group: c.g || null,
    event: row[ROW.EVENT] ? { id: row[ROW.EVENT], size: row[ROW.EVENT_SIZE], position: row[ROW.EVENT_POS], first: row[ROW.EVENT_FIRST] || null, last: row[ROW.EVENT_LAST] || null } : null,
    relevance: score ?? row[ROW.BASE],
    // The keys the shared feedback learns on, so a vote cast on this row teaches the same features
    // the ranking reads (relevance-feedback-shared.js featureKeys).
    keys: storedKeys(row, c),
  };
}

/** The learning keys of a stored row — the same keys `relevanceReading` gave it at build time. */
export function storedKeys(row, company = {}) {
  const flags = row[ROW.FLAGS];
  return featureKeys({ categories: maskCategories(row[ROW.MASK]), band: company.b || MCAP_UNKNOWN, group: company.g || null, kind: 'filing',
    impact: IMPACTS[row[ROW.IMPACT]] || null, direction: DIRECTIONS[row[ROW.DIRECTION]] || null,
    prospective: !!(flags & FLAG.PROSPECTIVE), processUpdate: !!(flags & FLAG.PROCESS), duplicate: !!(flags & FLAG.DUPLICATE), repeat: !!(flags & FLAG.REPEAT) });
}

/** Base relevance plus the shared learned adjustment, for the Corporate Announcements surface. */
export function storedScore(row, company, model) {
  if (!model || !model.votes) return row[ROW.BASE];
  return Math.round((row[ROW.BASE] + learnedAdjustment(model, { keys: storedKeys(row, company), surface: 'announcements',
    itemKey: row[ROW.ID], eventKey: row[ROW.EVENT] || null })) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------------------------

const clean = (value, max) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
/** Lower-case, accents folded, punctuation as spaces — the same folding for text and needle. */
export const searchFold = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();

/**
 * A query as the index answers it. Unknown or malformed values fall back to the broadest reading
 * rather than failing — except the scope list, which is bounded because it is caller-supplied.
 */
export function normaliseQuery(input = {}) {
  const period = ANNOUNCEMENT_PERIODS.some((p) => p.value === input.period) ? input.period : DEFAULT_PERIOD;
  const scope = ['portfolio', 'watchlist', 'universe'].includes(input.scope) ? input.scope : 'universe';
  const companies = scope === 'universe' ? [] : (Array.isArray(input.companies) ? input.companies : []).slice(0, SCOPE_COMPANIES_MAX)
    .map(scopeEntry).filter(Boolean);
  const known = new Set(ANNOUNCEMENT_CATEGORIES.map((c) => c.id));
  const categories = [...new Set((Array.isArray(input.categories) ? input.categories : String(input.categories || '').split(','))
    .map((c) => String(c).trim()).filter((c) => known.has(c)))].sort();
  const mcap = parseMcapRange(input.mcap);
  const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(input.offset, 10) || 0));
  const limit = Math.max(1, Math.min(PAGE_MAX, Number.parseInt(input.limit, 10) || PAGE_DEFAULT));
  const company = input.company ? scopeEntry(input.company) : null;
  const sort = input.sort === 'time' ? 'time' : 'relevance';
  return { period, scope, companies, categories, mcap: mcapKey(input.mcap, mcap), q: clean(input.q, QUERY_TEXT_MAX), company, offset, limit, sort };
}
function scopeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const field = (v, re) => (re.test(String(v ?? '').trim()) ? String(v).trim().toUpperCase() : null);
  const entry = { ticker: field(raw.ticker, /^[A-Za-z0-9&._-]{1,40}$/), isin: field(raw.isin, /^[A-Za-z]{2}[A-Za-z0-9]{9}\d$/),
    bseCode: field(raw.bseCode || raw.scripCode, /^\d{6}$/), name: clean(raw.name || raw.company, 120) || null };
  return entry.ticker || entry.isin || entry.bseCode ? entry : null;
}
function mcapKey(raw, range) {
  if (range.kind === 'all') return 'all';
  if (range.kind === 'unknown') return 'unknown';
  return range.band || `${range.min || ''}-${Number.isFinite(range.max) ? range.max : ''}`;
}

/** The stable cache key of everything that changes WHICH rows a query selects (not the page). */
export function queryKey(q, resolvedKeys = null) {
  return JSON.stringify([q.period, q.scope, resolvedKeys ? [...resolvedKeys].sort() : null, q.categories, q.mcap, searchFold(q.q),
    q.company ? [q.company.ticker, q.company.isin, q.company.bseCode] : null, q.sort]);
}

/** Inclusive IST day bounds for a period, and whether undated filings belong to it. */
export function periodRange(period, now = Date.now()) {
  if (period === 'all') return { from: '0000-00-00', to: '9999-99-99', dated: true, undated: true };
  if (period === 'undated') return { from: null, to: null, dated: false, undated: true };
  const bounds = newsPeriodBounds(period, now);
  return { from: bounds.from, to: bounds.to, dated: true, undated: false };
}
export const todayIst = (now = Date.now()) => newsDay(now);

/** The haystack a search reads: the subject, the exchange's labels, the description and the company. */
export function haystackOf(row, company = {}) {
  return searchFold([row[ROW.TITLE], row[ROW.SUB], row[ROW.CATEGORY], row[ROW.SUMMARY], row[ROW.NAME], company.n, company.t, company.s, company.i].filter(Boolean).join(' '));
}

/**
 * Select, rank and count, one day at a time. Feed `add()` every day the period covers, newest first
 * (undated last), then read `result()`. Streaming is what lets a whole-history query run inside a
 * bounded memory: a day is scanned, its selected rows are kept as references, and the day itself can
 * be dropped. `onSelected(day, i, position, score, row, company)` sees each selected row as it is
 * placed, so the page being asked for can be materialised during the same pass.
 *
 * Ordering: newest day first; within a day by relevance (base + shared feedback), then time.
 * With `sort: 'time'` the order is strictly newest first. Every selected row is kept — the ranking
 * moves rows within their day and never drops one.
 */
export function createSelection(q, { companyAt, wantedCompanies = null, companyFilter = null, model = null, haystack = haystackOf, onSelected = null }) {
  // The search is a phrase, exactly as the tab's own search always matched it: the folded text must
  // contain the folded query (punctuation and case aside).
  const needle = searchFold(q.q);
  const range = parseMcapRange(q.mcap);
  const wantCats = q.categories.length ? q.categories : null;
  const categoryFacet = new Map(ANNOUNCEMENT_CATEGORIES.map((c) => [c.id, 0]));
  const bandFacet = new Map([...MCAP_BANDS.map((b) => [b.id, 0]), [MCAP_UNKNOWN, 0]]);
  const selected = [];
  const companiesSeen = new Set();
  return {
    add(segment) {
      const ranked = [];
      for (let i = 0; i < segment.rows.length; i++) {
        const row = segment.rows[i];
        const idx = row[ROW.COMPANY];
        if (wantedCompanies && !wantedCompanies.has(idx)) continue;
        if (companyFilter && !companyFilter.has(idx)) continue;
        const company = companyAt(idx) || {};
        if (needle && !haystack(row, company, segment, i).includes(needle)) continue;
        // A band filter compares the company's stored band, so the per-day facet counts (which are
        // counted by band) and the selection can never disagree about a company on a band's edge.
        const mcapOk = range.band ? (company.b || mcapBand(company.m)) === range.band : inMcapRange(company.m, range);
        const catOk = !wantCats || wantCats.some((id) => maskHas(row[ROW.MASK], id));
        // Facets: a category's count respects every other filter but itself, a band's likewise.
        if (mcapOk) for (const c of ANNOUNCEMENT_CATEGORIES) if (maskHas(row[ROW.MASK], c.id)) categoryFacet.set(c.id, categoryFacet.get(c.id) + 1);
        if (catOk) { const band = company.b || mcapBand(company.m); bandFacet.set(band, (bandFacet.get(band) || 0) + 1); }
        if (!mcapOk || !catOk) continue;
        ranked.push({ i, score: q.sort === 'time' ? 0 : storedScore(row, company, model), time: row[ROW.TIME] || '' });
        companiesSeen.add(idx);
      }
      ranked.sort((a, b) => b.score - a.score || (a.time < b.time ? 1 : a.time > b.time ? -1 : 0) || a.i - b.i);
      for (const r of ranked) {
        onSelected?.(segment.day, r.i, selected.length, r.score, segment.rows[r.i]);
        selected.push([segment.day, r.i, r.score]);
      }
    },
    result() {
      return {
        selected, total: selected.length, companies: companiesSeen.size,
        facets: { categories: Object.fromEntries(categoryFacet), bands: Object.fromEntries(bandFacet) },
      };
    },
  };
}

/** The whole selection over already-decoded days — the browser's fallback engine and the tests use it. */
export function selectRows(segments, q, options) {
  const selection = createSelection(q, options);
  for (const segment of segments) selection.add(segment);
  return selection.result();
}

export const INDEX_VERSIONS = Object.freeze({ contract: INDEX_CONTRACT, categories: CATEGORY_VERSION });
