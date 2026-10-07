// data/announcement-query-local.js — THE CORPORATE ANNOUNCEMENTS QUERY, ANSWERED IN THIS BROWSER.
//
// The normal path is the Worker's index object (worker/announcement-index-store.mjs): one ranked page
// at a time, nothing else downloaded. This engine is what answers when that index cannot be read — a
// static copy of the dashboard with no Worker, or a deployment whose first index build has not run —
// so the tab still works, with the same categories, the same ranking and the same filters.
//
// IT IS THE SAME CODE, NOT A SECOND VERSION. It loads the stream the way the tab always did
// (corporate-announcements.js), tags, scores and stitches the period on screen with the runner's own
// build (announcement-index-build.js), and selects with the index's own query (createSelection in
// announcement-index-shared.js). The work is driven in slices, so a long period never freezes the page.
//
// TWO HONEST DIFFERENCES, both stated in the tab's provenance: related filings are linked within the
// selected period only (the server links across the whole history), and building a long period here
// takes seconds rather than one request.
import { corporateAnnouncements as feed } from './corporate-announcements.js';
import { buildIndexSteps } from './announcement-index-build.js';
import { buildCompanyProfiles } from './company-profile.js';
import {
  normaliseQuery, periodRange, createSelection, displayRow, UNDATED, ROW, queryKey,
} from './announcement-index-shared.js';
import { runStepsInSlices } from '../core/slices.js';
import { revalidatedJson } from '../core/store.js';
import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let profiles = null, profilesPending = null;
let built = null; // { key, byDay, companies, byKey, dict, days, rows, meta }
let building = null;
let buildGeneration = 0;
let loadPending = null;
let progress = null;
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* listener's own failure */ } });

/**
 * The captures changed: the question is asked again. A preparation is reused when the stream's rows
 * are the very same array (a status-only change), and made again when they are not.
 */
export const onChange = (fn) => feed.onChange(fn);
/** Preparation progress, for the tab's progress line. Never a data change. */
export const onProgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const buildProgress = () => progress;
export const feedMeta = () => feed.meta();
export const startLive = (live) => feed.startLive(live);
export const stopLive = (live) => feed.stopLive(live);
export const refresh = () => feed.refresh().then(() => { built = null; });

function loadProfiles() {
  if (profiles) return Promise.resolve(profiles);
  if (!profilesPending) {
    profilesPending = Promise.all([
      revalidatedJson('data/mc-ticker-map.json', { optional: true }),
      revalidatedJson('data/technicals.json', { optional: true }),
      revalidatedJson('data/sector-kpis.json', { optional: true }),
    ]).then(([tickerMap, technicals, sectorKpis]) => (profiles = buildCompanyProfiles({ tickerMap, technicals, sectorKpis })))
      .catch(() => (profiles = buildCompanyProfiles({})));
  }
  return profilesPending;
}

/**
 * Load the stream as the tab always did, but only for a table the reader stays on. The stream's load
 * goes on to walk every company's captured history — hundreds of files, three at a time — and that
 * walk outlives the tab, so a tab passed through on the way to another must not start it. The old
 * tab got that from a slow first preparation; here the table has to stay on screen for
 * LOAD_DWELL_MS (`prepareWhile`). One completed load is enough: later questions re-read what it
 * brought, and the 90-second poller (`refresh`) brings what is new.
 * Resolves true once the first rows can be answered, false when the table went away first.
 */
const LOAD_DWELL_MS = 600;
let loadedOnce = false;
async function ensureLoaded(prepareWhile = () => true) {
  if (loadedOnce || (feed.isLoaded?.() && feed.rows().length)) return true;
  if (!loadPending) {
    await feed.prepareRows?.();
    await new Promise((done) => setTimeout(done, LOAD_DWELL_MS));
    if (!prepareWhile()) return false;
    loadPending ||= Promise.all([feed.load([]), loadProfiles()])
      .then(() => { loadedOnce = true; })
      .finally(() => { loadPending = null; });
  }
  await loadPending;
  return true;
}

const rowDay = (row) => (DAY_RE.test(row.date || '') ? row.date : UNDATED);

/** Tag, score and stitch the scoped rows of one period — once per (rows, period, scope). */
async function buildFor(q, now, keepGoing) {
  // A stream that can prepare its merge in slices does so first, so the read below finds it ready
  // rather than merging a retained history in one task.
  await feed.prepareRows?.();
  const range = periodRange(q.period, now);
  const scopeCompanies = q.scope === 'portfolio' ? coverage.holdings() : q.scope === 'watchlist' ? watchlist.all() : null;
  const all = feed.rows();
  // The stream's status is read right after its rows, while that read is free — read later, a
  // capture that arrived in between would make the status merge the whole stream in one task.
  const meta = feed.meta();
  // The period's own bounds are in the key, so a midnight rollover prepares the new day's rows.
  const scopeKey = scopeCompanies ? scopeCompanies.map((c) => c.ticker || c.isin || c.bseCode || c.name || '').join(',') : '';
  const key = `${q.period}|${range.from}|${range.to}|${q.scope}|${scopeKey}|${all.length}|${meta.identity?.revision || 0}`;
  if (built?.key === key && built.rows === all) { built.meta = meta; return built; }
  if (building?.key === key) return building.promise;
  // A newer preparation supersedes an older one still in its slices: two would only compete.
  const mine = ++buildGeneration;
  const stillWanted = () => keepGoing() && mine === buildGeneration;
  const inPeriod = all.filter((row) => {
    const day = rowDay(row);
    return day === UNDATED ? range.undated : range.dated && day >= range.from && day <= range.to;
  });
  const scoped = scopeCompanies ? feed.filterByScope(inPeriod, q.scope, coverage.holdings()) : inPeriod;
  progress = { share: 0, total: scoped.length };
  emit();
  const promise = (async () => {
    const steps = buildIndexSteps({ rows: scoped, feed, profiles });
    // Each yield names its phase and how far it is; the tab shows it as one progress line. Reading
    // (tagging and scoring) is most of the work, so it is weighted as four-fifths of the bar.
    let last = 0;
    const counted = (function* () {
      for (;;) {
        const step = steps.next();
        if (step.done) return step.value;
        const at = step.value || {};
        const share = at.phase === 'reading' ? 0.8 * (at.done / Math.max(1, at.total)) : at.phase === 'linking' ? 0.82 : 0.82 + 0.18 * (at.done / Math.max(1, at.total));
        if (share - last >= 0.04) { last = share; progress = { share, total: scoped.length }; emit(); }
        yield;
      }
    })();
    const result = await runStepsInSlices(counted, { keepGoing: stillWanted });
    if (!result) { if (mine === buildGeneration) { progress = null; emit(); } return null; }
    const next = {
      key, rows: all, byDay: result.byDay, companies: result.companies,
      byKey: new Map(result.companies.map((c, i) => [c.k, i])),
      dict: { sources: result.dict.sources.list, providers: result.dict.providers.list },
      days: [...result.byDay.keys()].sort((a, b) => (a === UNDATED ? 1 : b === UNDATED ? -1 : b.localeCompare(a))),
      counts: result.counts, meta,
    };
    built = next;
    progress = null;
    return next;
  })().finally(() => { if (building?.key === key) building = null; });
  building = { key, promise };
  return promise;
}

const selections = new Map();

/**
 * One page of the query, in exactly the server's response shape. `model` is the shared relevance
 * model (relevance-feedback.js), so a vote re-orders this engine's answer as it does the server's.
 */
export async function query(input, { model = null, now = Date.now(), keepGoing = () => true, prepareWhile = () => true } = {}) {
  const q = normaliseQuery(input);
  if (!(await ensureLoaded(prepareWhile))) return null;
  // The prepared period is shared by every question about it, so one superseded question never
  // abandons it — only the table going away does (`prepareWhile`); this question's own selection
  // stops as soon as nobody is waiting for it.
  const index = await buildFor(q, now, prepareWhile);
  if (!index) return null;
  const companyAt = (idx) => index.companies[idx];
  let companyFilter = null;
  if (q.company) {
    const key = feed.companyKey({ ticker: q.company.ticker, isin: q.company.isin, bseCode: q.company.bseCode, scripCode: q.company.bseCode, company: q.company.name });
    companyFilter = new Set(key != null && index.byKey.has(key) ? [index.byKey.get(key)] : []);
  }
  const selectionKey = `${index.key}|${model?.revision || ''}|${queryKey(q)}|${companyFilter ? [...companyFilter].join(',') : ''}`;
  let selection = selections.get(selectionKey);
  if (!selection) {
    // One day per step, in slices: "All time" is the whole retained history.
    const acc = createSelection(q, { companyAt, companyFilter, model });
    const finished = await runStepsInSlices((function* () {
      for (const day of index.days) { acc.add({ day, rows: index.byDay.get(day) }); yield; }
      return true;
    })(), { keepGoing });
    if (!finished) return null;
    selection = acc.result();
    selections.clear();
    selections.set(selectionKey, selection);
  }
  const page = selection.selected.slice(q.offset, q.offset + q.limit).map(([day, i, score]) =>
    displayRow(index.byDay.get(day)[i], day, { companies: index.companies, dict: index.dict, score: Math.round(score * 100) / 100 }));
  const m = index.meta || feed.meta();
  return {
    ok: true, rows: page, total: selection.total, companies: selection.companies, facets: selection.facets,
    offset: q.offset, limit: q.limit, nextOffset: q.offset + page.length < selection.total ? q.offset + page.length : null, unmatched: [],
    index: { local: true, builtAt: new Date(now).toISOString(), counts: index.counts, range: null, live: { at: m.nse?.capturedAt || null, rows: 0, error: m.nse?.error || null }, meta: m },
  };
}

/** Every filing of one stitched event within the built period, oldest first. */
export async function event(id) {
  const index = built;
  if (!index) return { ok: true, id, members: [] };
  const members = [];
  for (const day of index.days) {
    for (const row of index.byDay.get(day)) if (row[ROW.EVENT] === id) members.push(displayRow(row, day, { companies: index.companies, dict: index.dict }));
  }
  members.sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`));
  return { ok: true, id, members, local: true };
}
