// data/deep-dive.js — the client for the Concall Deep Dive dashboard's trigger API.
//
//   configured()                    is a base URL set?
//   setBaseUrl(url) / baseUrl()     where that dashboard lives
//   readyReportsByTicker()          every report the provider ALREADY holds — free, no run
//   start(row, { onProgress })      dispatch a run and poll it to completion
//   resume(slug, { onProgress })    reattach to an existing run or open a finished report
//   remembered(ticker, recordId)    a slug we already have for this exact call row
//   savedReport(slug)               a finished report KEPT ON THIS DEVICE — no network at all
//   saveReport({ slug, report })    keep one, so the next open costs nothing
//   savedByRecord() / savedForRecord() exact call rows this device already holds a report for
//
// TWO KINDS OF CALL, AND ONLY ONE OF THEM COSTS ANYTHING.
//   Reading — `GET /api/summary` (their index of finished reports) and `GET /api/report` — is
//   free. Writing — `POST /api/analyze` — starts a real LLM pipeline. So the index is fetched
//   once per page load to mark the rows that are already free to open, and a dispatch happens
//   only from the explicit Deep Dive row-button click. Never blur those two.
//
// THIS TALKS TO A DIFFERENT DASHBOARD, AND EVERY FIELD IT RENDERS IS THAT DASHBOARD'S.
//   Concall Deep Dive runs its own LLM pipeline over a company's call and publishes a report. We
//   trigger it, watch it, and show what it returns. We compute nothing on top and we re-band
//   nothing — same rule as the StockScans scores and the Trendlyne holding values. Every surface
//   says whose analysis it is, while only the primary transcript/presentation links are exposed.
//
// A NEW DEEP DIVE CLICK CAN COST THEM A PIPELINE RUN.
//   `POST /api/analyze` dispatches a real LLM + compute run and the endpoint is unauthenticated.
//   So nothing here fires on render or from a poller. The Deep Dive button itself is the explicit
//   instruction: its click dispatches and opens progress immediately. A cached report (<14 days)
//   comes back instantly with `status: "done"` and costs nothing.
//
// WHERE THE BASE URL COMES FROM
//   `window.SATTVA_DEEPDIVE_URL` in index.html is the deployment configuration. A localStorage
//   override remains for the browser verification stub, but neither address is printed or editable
//   in the customer-facing panel. Until it is set, the panel says Deep Dive is unavailable.
//
// A FINISHED REPORT IS KEPT ON THE DEVICE, AND THAT IS NOT AN OPTIMISATION.
//   Everywhere else on this dashboard a cache miss costs bytes and a moment. Here it can cost a
//   metered LLM run: their store drops a report after about a fortnight, and once it is gone the
//   only way back to an analysis the reader has already read is to pay for it again. So every
//   finished report is written to IndexedDB under their slug, and reopening paints from there with
//   no request at all — the same device-first shape as the Superstar Investors books, for a
//   sharper reason. Three rules come with it, and they are the store's usual ones:
//     - What is kept is THEIR bytes under THEIR slug. Nothing is patched, trimmed or recomputed.
//     - A failed re-check never deletes a report we hold. A copy of a real run is worth more than
//       a fresh "could not be read", and their forgetting it is exactly when ours matters most.
//     - A stored paint may not claim a freshness it has not confirmed, so the panel says it came
//       from this device and when it was last checked against them.

import { KEYS, readEntry, writeEntry, deleteEntry, isPersistent } from '../core/store.js';

const LS_BASE = 'sattva:deepdive-base';
const LS_SLUGS = 'sattva:deepdive-slugs';
const LS_REPORTS = 'sattva:deepdive-reports';

// Their frontend polls every 3-5s and gives up around the pipeline's own ~20 minute ceiling.
export const POLL_MS = 4000;
export const TIMEOUT_MS = 25 * 60 * 1000;

/**
 * THEIR STAGE VOCABULARY, COPIED FROM THEIR OWN FRONTEND — keys, order, wording and percentages.
 *
 * The API sends a bare `stage` key and nothing else: `{ ok, slug, status: "running", stage:
 * "research" }`. No message, no percentage. Their dashboard turns that key into a sentence and a
 * position on a bar using this table, which lives in `js/analyze.js` on their side.
 *
 * So this is reproduction, not invention — the same rule as the StockScans tiers. If we wrote our
 * own wording for "extract" we would be describing their pipeline in our words and would drift the
 * first time they changed it. The percentages are theirs too; they are a position in a known
 * sequence of stages, not a measurement of work done.
 *
 * An unknown key resolves to the first entry rather than throwing, so a stage they add lands as
 * "starting" instead of blanking the panel.
 */
export const STAGES = [
  { key: 'queued', pct: 5, label: 'Starting the analysis…' },
  { key: 'resolve', pct: 15, label: 'Gathering price, financials & balance sheet…' },
  { key: 'transcript', pct: 30, label: 'Pulling the latest earnings call & deck…' },
  { key: 'extract', pct: 50, label: "Reading management's commentary…" },
  { key: 'research', pct: 68, label: 'Researching risks & the bull/bear case…' },
  { key: 'verify', pct: 80, label: 'Fact-checking every claim against the transcript…' },
  { key: 'model', pct: 90, label: 'Building the financial model & valuation…' },
  { key: 'finalize', pct: 97, label: 'Assembling your report…' },
  { key: 'done', pct: 100, label: 'Report ready.' },
];

/** The stages drawn as a checklist — their bookends (`queued`, `done`) are not steps. */
export const CHECKLIST_STAGES = STAGES.filter((s) => s.key !== 'queued' && s.key !== 'done');

/** stage key -> { key, pct, label, index }. Unknown or blank resolves to the start. */
export function stageInfo(stage) {
  const i = Math.max(0, STAGES.findIndex((s) => s.key === stage));
  return { ...STAGES[i], index: i };
}

const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private window: the session still works, it just does not persist */
  }
};

/** Trailing slashes stripped so `${base}/api/analyze` cannot become a double slash. */
export function normaliseBase(url) {
  const t = String(url || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function baseUrl() {
  return normaliseBase(read(LS_BASE, '') || (typeof window !== 'undefined' ? window.SATTVA_DEEPDIVE_URL : '') || '');
}

export function setBaseUrl(url) {
  const clean = normaliseBase(url);
  write(LS_BASE, clean);
  return clean;
}

export const configured = () => !!baseUrl();

// ticker -> { slug, at }. A run takes minutes; remembering the slug means closing the panel and
// coming back reattaches to the job in flight rather than dispatching a second one.
export const remembered = (ticker, recordId = null) => {
  const entry = ticker ? read(LS_SLUGS, {})[String(ticker).toUpperCase()] || null : null;
  if (!entry || !recordId) return entry;
  return entry.recordId === recordId ? entry : null;
};

/**
 * The whole map, read once.
 *
 * The scan table marks every row that already has a run on record, and it is a 500-row table that
 * repaints on a live tick. Asking `remembered()` per row would be 500 localStorage reads and 500
 * `JSON.parse` calls per paint for a map that changes at most once a minute.
 */
export const rememberedMap = () => read(LS_SLUGS, {});

/** exact visible-row id -> remembered in-flight/completed run. */
export function rememberedByRecord() {
  const out = {};
  for (const entry of Object.values(rememberedMap())) if (entry?.recordId) out[entry.recordId] = entry;
  return out;
}

function remember(ticker, slug, { recordId = null, date = null } = {}) {
  if (!ticker || !slug) return;
  const all = read(LS_SLUGS, {});
  all[String(ticker).toUpperCase()] = { slug, at: Date.now(), recordId, date };
  write(LS_SLUGS, all);
}

// ---------------------------------------------------------------------------------------
// Reports kept on this device — see the header
//
// Two stores, on purpose:
//   IndexedDB  the report BODY, under their slug. Prose-carrying and tens of KB, so it does not
//              belong in localStorage beside the watchlist and the keyword sets.
//   localStorage  a small INDEX of what the body store holds — slug -> { ticker, company, quarter,
//              recordId, callDate, summary, savedAt }. It is read synchronously on every table
//              paint to mark the exact rows that open for free, which an async IndexedDB read
//              could not do.
//
// The index is written only after the body write lands on a working IndexedDB. In a private window
// the mark never appears and the panel still gets the in-memory copy for the session — better than
// a table promising a saved report that a reload has already lost.
// ---------------------------------------------------------------------------------------

/** How many finished reports this device keeps. Oldest beyond this are dropped, body and all. */
export const MAX_SAVED = 60;

/** slug -> { ticker, company, quarter, recordId, callDate, summary, savedAt }. */
export const savedMap = () => read(LS_REPORTS, {});

/** ticker (upper-case) -> the newest saved entry, with its slug. Built once per paint. */
export function savedByTicker() {
  const out = {};
  for (const [slug, e] of Object.entries(savedMap())) {
    const t = String(e?.ticker || '').toUpperCase();
    if (!t) continue;
    if (!out[t] || (e.savedAt || 0) > (out[t].savedAt || 0)) out[t] = { ...e, slug };
  }
  return out;
}

/** ticker -> every saved index entry, newest first. */
export function savedReportsByTicker() {
  const out = {};
  for (const [slug, entry] of Object.entries(savedMap())) {
    const ticker = String(entry?.ticker || '').toUpperCase();
    if (!ticker) continue;
    (out[ticker] ||= []).push({ ...entry, slug });
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return out;
}

/** exact visible-row id -> newest saved entry. One localStorage read for the whole table paint. */
export function savedByRecord() {
  const out = {};
  for (const [slug, entry] of Object.entries(savedMap())) {
    const id = entry?.recordId;
    if (!id) continue;
    if (!out[id] || (entry.savedAt || 0) > (out[id].savedAt || 0)) out[id] = { ...entry, slug };
  }
  return out;
}

/** The newest report this device holds for one company, or null. Index only — no body read. */
export const savedFor = (ticker) => (ticker ? savedByTicker()[String(ticker).toUpperCase()] || null : null);

/** A report filed against this exact visible call row, or null. */
export function savedForRecord(recordId) {
  return recordId ? savedByRecord()[recordId] || null : null;
}

/** The compact list fields the provider itself exposes for a finished report. No scoring here. */
export function reportSummary({ slug = null, report = null } = {}) {
  if (!report || typeof report !== 'object') return null;
  const meta = report.meta || {};
  const tags = Array.isArray(report?.concall?.classification)
    ? report.concall.classification.map((entry) => entry?.tag).filter(Boolean)
    : [];
  return {
    slug: slug || meta.slug || null,
    company: meta.company || null,
    ticker: meta.ticker || null,
    quarter: meta.quarter || report?.earnings?.quarter || null,
    quarter_confirmed: meta.quarter_confirmed === true,
    generated_at: meta.generated_at || null,
    transcript_available: meta.transcript_available === true,
    verdict: report?.next_steps?.conviction || null,
    result: report?.earnings?.beat_miss?.overall || null,
    headline: Array.isArray(report.key_takeaways) ? report.key_takeaways.find(Boolean) || null : null,
    tags: tags.slice(0, 4),
  };
}

/**
 * The stored body for one slug, or null.
 *
 * Null means "fetch it", never an error — same contract as every other read through the store. An
 * index entry whose body has gone (a cleared store, a different browser profile) is dropped here
 * rather than left to promise something that is not there.
 */
export async function savedReport(slug) {
  if (!slug) return null;
  const entry = savedMap()[slug];
  if (!entry) return null;
  const hit = await readEntry(KEYS.deepDiveReport(slug));
  if (!hit?.value?.report) {
    forgetReport(slug);
    return null;
  }
  return {
    slug,
    report: hit.value.report,
    partial: !!hit.value.partial,
    savedAt: hit.savedAt || entry.savedAt || null,
    ticker: entry.ticker || null,
    company: entry.company || null,
    quarter: entry.quarter || null,
  };
}

/**
 * Keep one finished report.
 *
 * Stores THEIR object exactly as it arrived — the whole point of holding it is that it is a copy of
 * what that pipeline produced, and a locally reshaped one would be worth less than no copy at all.
 * Resolves once the index is durable, so a caller can mark the row only when the claim is true.
 */
export function saveReport({ slug, ticker, company, quarter, recordId = null, callDate = null, report, partial = false }) {
  if (!slug || !report) return Promise.resolve(false);
  const savedAt = Date.now();
  return writeEntry(KEYS.deepDiveReport(slug), { value: { report, partial, slug, ticker: ticker || null }, savedAt })
    .then(() => {
      if (!isPersistent()) return false;
      const all = savedMap();
      all[slug] = {
        ticker: ticker ? String(ticker).toUpperCase() : null,
        company: company || null,
        quarter: quarter || null,
        recordId,
        callDate,
        summary: reportSummary({ slug, report }),
        savedAt,
      };
      // Oldest first out, body and index together, so the two can never disagree about what is here.
      for (const stale of Object.keys(all)
        .sort((a, b) => (all[b].savedAt || 0) - (all[a].savedAt || 0))
        .slice(MAX_SAVED)) {
        delete all[stale];
        deleteEntry(KEYS.deepDiveReport(stale));
      }
      write(LS_REPORTS, all);
      return true;
    })
    .catch(() => false);
}

/** Drop one saved report, body and index entry. */
export function forgetReport(slug) {
  if (!slug) return;
  const all = savedMap();
  if (slug in all) {
    delete all[slug];
    write(LS_REPORTS, all);
  }
  deleteEntry(KEYS.deepDiveReport(slug));
}

/**
 * Does a report contradict the ticker we opened it for?
 *
 * One company's analysis under another's name is the worst thing this feature could do, and a slug
 * is now resolved from three places — their index, this browser's memory of a dispatch, and this
 * device's saved reports. So the check is shared: the panel says so in a banner, and nothing that
 * fails it is ever filed under our ticker. Missing identity on their side is not a contradiction.
 */
export function conflictsWith(report, ticker) {
  const theirs = String(report?.meta?.ticker || '').toUpperCase();
  const ours = String(ticker || '').toUpperCase();
  return !!theirs && !!ours && theirs !== ours;
}

async function call(path, init) {
  const b = baseUrl();
  if (!b) throw new Error('Deep Dive is not configured for this deployment.');
  let res;
  try {
    res = await fetch(`${b}${path}`, init);
  } catch (err) {
    // Their CORS is open, so a failure here is the host being unreachable or the URL being wrong —
    // both worth saying plainly rather than as a bare TypeError.
    throw new Error('Could not reach the Deep Dive service. Try again in a moment.');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`The Deep Dive service returned an invalid response (HTTP ${res.status}).`);
  }
  return body;
}

/** Ask whether a fresh report already exists, without dispatching anything. */
export async function peek(ticker) {
  const known = remembered(ticker);
  if (!known?.slug) return null;
  try {
    return await call(`/api/report?slug=${encodeURIComponent(known.slug)}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Their index of finished reports — free, and the reason most clicks cost nothing
//
// `GET /api/summary` lists every report that dashboard has already produced. Reading it is a
// plain GET with no pipeline behind it, so unlike a dispatch it is safe to fetch on our own —
// and it is what lets the scan table say "this one is ready" instead of making the reader pay to
// find out. Fetched ONCE per page load: it is small, it changes only when a run completes, and
// polling someone else's service for a list that moves a few times a day would be rude.
// ---------------------------------------------------------------------------------------

let summaryPromise = null;

/** The raw `/api/summary` payload, fetched at most once per page load. Never throws. */
export function summary({ refresh = false } = {}) {
  if (refresh) summaryPromise = null;
  if (!summaryPromise) {
    summaryPromise = (async () => {
      if (!configured()) return null;
      try {
        const body = await call('/api/summary');
        return Array.isArray(body?.summaries) ? body : null;
      } catch {
        // A missing index is not an error: it means we cannot pre-mark rows, and a clicked row
        // follows the normal direct-run path.
        return null;
      }
    })();
  }
  return summaryPromise;
}

/**
 * ticker (upper-case) -> the summary row for the report they already hold.
 *
 * Only rows with a slug are kept, because the slug is the whole point: it is what opens the
 * finished report without dispatching anything.
 */
export async function readyByTicker() {
  const body = await summary();
  const out = {};
  for (const r of body?.summaries || []) {
    const t = String(r?.ticker || '').toUpperCase();
    if (!t || !r.slug) continue;
    // Several quarters of the same company can exist; keep the most recently generated.
    if (!out[t] || String(r.generated_at || '') > String(out[t].generated_at || '')) out[t] = r;
  }
  return out;
}

/** ticker -> every finished summary, newest first, so an older quarter is not hidden by the latest. */
export async function readyReportsByTicker() {
  const body = await summary();
  const out = {};
  for (const row of body?.summaries || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker || !row.slug) continue;
    (out[ticker] ||= []).push(row);
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  return out;
}

/**
 * Dispatch a run and poll it to completion.
 *
 * `onProgress(state)` fires on every tick with what THEIR pipeline reports — `status`, `stage`,
 * `message` — plus how long we have been waiting. That is the loading window: their words, not a
 * spinner of ours guessing at what is happening.
 *
 * Resolves with `{ status: 'done', slug, report }` or throws. `signal` aborts the polling loop
 * when the reader closes the panel — the run continues on their side, and reopening reattaches.
 */
export async function start({ company, ticker, recordId = null, date = null, force = false }, { onProgress = () => {}, signal } = {}) {
  if (!company && !ticker) throw new Error('A company name or ticker is required.');

  onProgress({ status: 'dispatching', stage: null, message: 'Asking the Deep Dive dashboard to start…', elapsedMs: 0 });

  const body = { company: company || ticker, force };
  // Always send the ticker when we have one: it is what makes "Tata Motors", "Tata Motors Ltd" and
  // "TMCV" resolve to one cached report instead of three runs.
  if (ticker) body.ticker = ticker;

  const dispatched = await call('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (dispatched?.ok === false) {
    throw new Error(dispatched.error || 'The Deep Dive dashboard refused the request.');
  }
  // The slug is theirs and is always derived server-side. Never construct one here.
  const slug = dispatched?.slug;
  if (!slug) throw new Error('The Deep Dive dashboard did not return a report id.');
  remember(ticker, slug, { recordId, date });

  if (dispatched.status === 'done') {
    onProgress({ status: 'done', stage: null, message: 'A recent report was already on file.', elapsedMs: 0, cached: true });
    const ready = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    return { status: 'done', slug, report: ready?.report ?? null, partial: !!ready?.partial, cached: true };
  }

  const started = Date.now();
  onProgress({ status: dispatched.status || 'queued', stage: dispatched.stage || null, message: dispatched.message || null, elapsedMs: 0, slug });

  for (;;) {
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');
    await sleep(POLL_MS, signal);
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');

    const elapsedMs = Date.now() - started;
    if (elapsedMs > TIMEOUT_MS) {
      throw new Error(`The run has been going for ${Math.round(elapsedMs / 60000)} minutes without finishing. Close this panel and reopen the same row later to reattach.`);
    }

    let tick;
    try {
      tick = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    } catch (err) {
      // A blip mid-run should not kill a twenty-minute job. Report it and keep polling.
      onProgress({ status: 'running', stage: null, message: `Lost contact for a moment (${err.message})`, elapsedMs, slug, transientError: true });
      continue;
    }

    if (tick?.status === 'done') {
      onProgress({ status: 'done', stage: null, message: null, elapsedMs, slug });
      return { status: 'done', slug, report: tick.report ?? null, partial: !!tick.partial, cached: false };
    }
    if (tick?.status === 'error') throw new Error(tick.error || 'The Deep Dive run failed.');
    // `unknown` is a brief KV propagation lag right after dispatch, not a failure.
    onProgress({
      status: tick?.status === 'unknown' ? 'queued' : tick?.status || 'running',
      stage: tick?.stage || null,
      message: tick?.status === 'unknown' ? 'Waiting for the run to register…' : tick?.message || null,
      elapsedMs,
      slug,
    });
  }
}

/**
 * Reattach to a run already dispatched, WITHOUT dispatching anything.
 *
 * Used when the reader reopens a panel they closed, or reloads the page mid-run. Their API would
 * dedup a second `POST /api/analyze` anyway, but not asking at all is the version that cannot
 * cost a run through a bug of ours.
 */
export async function resume(slug, { onProgress = () => {}, signal } = {}) {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');
    const elapsedMs = Date.now() - started;
    let tick;
    try {
      tick = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    } catch (err) {
      onProgress({ status: 'running', stage: null, message: `Lost contact for a moment (${err.message})`, elapsedMs, slug, transientError: true });
      await sleep(POLL_MS, signal);
      continue;
    }
    if (tick?.status === 'done') {
      onProgress({ status: 'done', stage: null, message: null, elapsedMs, slug });
      return { status: 'done', slug, report: tick.report ?? null, partial: !!tick.partial, cached: true };
    }
    if (tick?.status === 'error') throw new Error(tick.error || 'The Deep Dive run failed.');
    if (tick?.status === 'unknown') {
      // Not a failure — the slug this browser remembered has aged out of their store. The caller
      // may be auto-resuming on open, where the right answer is "offer to start one" rather than
      // an error card, so it is tagged instead of being thrown as a plain Error.
      const err = new Error('That run is no longer on record. Start a new one.');
      err.code = 'unknown';
      throw err;
    }
    onProgress({ status: tick?.status || 'running', stage: tick?.stage || null, message: tick?.message || null, elapsedMs, slug });
    if (elapsedMs > TIMEOUT_MS) throw new Error('The run has not finished in the expected window.');
    await sleep(POLL_MS, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}
