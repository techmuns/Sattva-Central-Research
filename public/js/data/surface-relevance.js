// data/surface-relevance.js — THE RELEVANCE READING FOR ROWS THE BROWSER ALREADY HOLDS.
//
// Corporate Announcements is ranked by the server index. News and All Alerts rank the rows they
// already have, in the browser, with the very same reading (relevance.js) and the very same shared
// feedback model (relevance-feedback.js) — so an order win at a mid cap reads the same on all three
// surfaces, and a vote cast on any of them moves all three.
//
// One reading per row object, memoised in a WeakMap and re-read only when the shared model or the
// company profiles change (CLAUDE.md: a per-row cache is keyed on the row object). Nothing here hides
// a row: the score only decides the order within a day.
import { relevanceReading, relevanceScore, rankKey } from './relevance.js';
import { categoriesOf } from './announcement-categories.js';
import { eventHash } from './event-stitching.js';
import { profileOf, profilesRevision, loadProfiles, onChange as onProfilesChange } from './company-profiles.js';
import { currentModel, modelRevision, loadModel, onChange as onModelChange } from './relevance-feedback.js';
import { runStepsInSlices, yieldToInput } from '../core/slices.js';

const memo = new WeakMap();

// RELEVANCE ORDERS THE RECENT DAYS, AND IT IS NEVER READ IN ONE LONG TASK.
//
// The desk asked for relevance "within recent items", newest day first. One reading costs tens of
// microseconds (the category rules run over the subject and the source's description), and All
// Alerts under Universe retains a few hundred thousand events: reading every one inside a table
// sort froze the page for seconds. So:
//   - only the last RECENT_RELEVANCE_DAYS days (IST, today included) are ordered by relevance; an
//     older day keeps the plain time order it always had;
//   - one synchronous run (a sort) reads at most SYNC_BUDGET_MS of new readings; a row past that
//     budget sorts by time for now and is read in slices behind the paint;
//   - when those slices finish, onRelevanceChange fires once and the surface re-sorts in place, with
//     every reading in hand. Nothing is hidden at any point; only the order inside a day moves.
export const RECENT_RELEVANCE_DAYS = 7;
const SYNC_BUDGET_MS = 120;
const DAY_MS = 86_400_000;
const istDay = (at = Date.now()) => new Date(at + 19_800_000).toISOString().slice(0, 10);

/** The first IST day that is still "recent" — today and the six days before it. */
export const recentFrom = (now = Date.now()) => istDay(now - (RECENT_RELEVANCE_DAYS - 1) * DAY_MS);
export const isRecentDay = (day, from = recentFrom()) => /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && day >= from;

const waiting = new Map(); // row -> read(row), readings a sort could not afford
const warmListeners = new Set();
let warming = null;
let warmGeneration = 0;
let budgetFrom = null;

// The budget belongs to one synchronous run: it opens at the first reading and closes in the
// microtask after the run, so the next sort — whenever it comes — starts with a full allowance.
function inBudget() {
  const now = performance.now();
  if (budgetFrom === null) {
    budgetFrom = now;
    queueMicrotask(() => { budgetFrom = null; });
  }
  return now - budgetFrom < SYNC_BUDGET_MS;
}

function* warmSteps() {
  for (const [row, read] of waiting) {
    waiting.delete(row);
    try { read(row); } catch { /* an unreadable row keeps its time order */ }
    yield;
  }
}

function scheduleWarm() {
  if (warming) return;
  warming = (async () => {
    // Let the paint that queued these finish first; the reader sees rows before the order settles.
    await yieldToInput();
    while (waiting.size) await runStepsInSlices(warmSteps());
    warmGeneration++;
    for (const fn of [...warmListeners]) { try { fn(); } catch { /* a listener's failure is its own */ } }
  })().finally(() => { warming = null; if (waiting.size) scheduleWarm(); });
}

/** Resolves once every reading a sort deferred has been made (tests and exports wait on it). */
export const relevanceSettled = async () => { while (warming) await warming; };

export const relevanceRevision = () => `${modelRevision()}|${profilesRevision()}|${warmGeneration}`;

/** Start loading what the reading needs (company profiles, the shared model). Never throws. */
export function primeRelevance() {
  void loadProfiles();
  void loadModel();
}

/** Called when either input changes, so a surface can repaint its order. */
export function onRelevanceChange(fn) {
  const offModel = onModelChange(fn);
  const offProfiles = onProfilesChange(fn);
  warmListeners.add(fn);
  return () => { offModel(); offProfiles(); warmListeners.delete(fn); };
}

/** A stable feedback id for a row on a surface: its own id where it has one, else its link or text. */
export function itemKeyFor(surface, row, explicit = null) {
  const basis = explicit || row?.id || row?.url || `${row?.ticker || ''}|${row?.title || row?.headline || ''}|${row?.date || ''}`;
  return `${surface}:${eventHash(String(basis))}`;
}

/**
 * The reading of one row on one surface: { score, reading, categories, weak, itemKey, features }.
 *
 * @param {object} row
 * @param {object} o
 * @param {'news'|'alerts'} o.surface
 * @param {'news'|'filing'|'alert'} o.kind     what the row is, for the reading
 * @param {'news'|'filing'} [o.categoryKind]    which words the categories read
 * @param {object} [o.context]                  extra reading inputs: direction, importance, match, feed
 * @param {string} [o.itemKey]
 */
export function surfaceReading(row, { surface, kind, categoryKind = kind === 'news' ? 'news' : 'filing', context = {}, itemKey = null, tags: given = null }) {
  // Three layers with three lifetimes: the category tags never change for a row (categoriesOf keeps
  // its own memo); the reading changes only when company profiles arrive; the score changes with
  // every model revision but costs one sum over a dozen keys.
  const profiles = profilesRevision(), model = modelRevision();
  let entry = memo.get(row);
  if (!entry || entry.surface !== surface || entry.profiles !== profiles) {
    const profile = profileOf({ ticker: row.ticker, scripCode: row.scripCode || row.bseCode, isin: row.isin });
    const tags = given || categoriesOf(row, categoryKind);
    const reading = relevanceReading(row, { kind, profile, categories: tags.ids, weakCategories: tags.weak, ...context });
    entry = { surface, profiles, model: null, reading, itemKey: itemKey || itemKeyFor(surface, row), score: reading.base,
      categories: tags.ids, weak: tags.weak || [], features: reading.keys };
    memo.set(row, entry);
  }
  if (entry.model !== model) {
    entry.model = model;
    entry.score = relevanceScore(entry.reading, { model: currentModel(), surface, itemKey: entry.itemKey });
  }
  return entry;
}

/** The feedback descriptor the Important / Not important controls send for a row. */
export function feedbackItemFor(entry, row, { label, company } = {}) {
  return {
    surface: entry.surface, itemKey: entry.itemKey, eventKey: null, features: entry.features,
    label: String(label ?? row.title ?? row.headline ?? '').slice(0, 300), company: company ?? row.company ?? row.ticker ?? null,
    categories: entry.categories,
  };
}

/** Day, then relevance, then time — as one string a table can sort descending. */
export const rankFor = (day, entry, time = '') => rankKey(day, entry.score, time);

/** A row's reading if it is already made and still current, without making one. */
function heldReading(row, surface) {
  const entry = memo.get(row);
  if (!entry || entry.surface !== surface || entry.profiles !== profilesRevision()) return null;
  const model = modelRevision();
  if (entry.model !== model) {
    entry.model = model;
    entry.score = relevanceScore(entry.reading, { model: currentModel(), surface, itemKey: entry.itemKey });
  }
  return entry;
}

/**
 * The sort key of one row: its day; then, on one of the recent days, its relevance; then its time.
 * `read(row)` makes the row's surfaceReading — within this run's budget, or later in slices.
 *
 * @param {object} row
 * @param {{ day: string|null, time?: string, surface: string, read: (row: object) => object, from?: string }} o
 */
export function rankedKey(row, { day, time = '', surface, read, from = undefined }) {
  if (!isRecentDay(day, from)) return rankKey(day, 0, time);
  const held = heldReading(row, surface);
  if (held) return rankKey(day, held.score, time);
  if (inBudget()) return rankKey(day, read(row).score, time);
  waiting.set(row, read);
  scheduleWarm();
  return rankKey(day, 0, time);
}

/** Make every reading a list needs, in slices — before an export reads all of them at once. */
export function warmReadings(rows, read, { keepGoing } = {}) {
  function* steps() { for (const row of rows) { try { read(row); } catch { /* left to its fallback */ } yield; } }
  return runStepsInSlices(steps(), keepGoing ? { keepGoing } : undefined);
}

/** "HH:MM:SS" in IST from an ISO time, or ''. */
export function istClock(iso) {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? new Date(at + 19_800_000).toISOString().slice(11, 19) : '';
}
