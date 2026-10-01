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

const memo = new WeakMap();

export const relevanceRevision = () => `${modelRevision()}|${profilesRevision()}`;

/** Start loading what the reading needs (company profiles, the shared model). Never throws. */
export function primeRelevance() {
  void loadProfiles();
  void loadModel();
}

/** Called when either input changes, so a surface can repaint its order. */
export function onRelevanceChange(fn) {
  const offModel = onModelChange(fn);
  const offProfiles = onProfilesChange(fn);
  return () => { offModel(); offProfiles(); };
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

/** "HH:MM:SS" in IST from an ISO time, or ''. */
export function istClock(iso) {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? new Date(at + 19_800_000).toISOString().slice(11, 19) : '';
}
