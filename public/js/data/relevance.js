// data/relevance.js — HOW MUCH AN ITEM SHOULD MATTER TO A BUY-SIDE ANALYST, AS A NUMBER NOBODY SEES.
//
// Corporate Announcements, News and All Alerts keep every item visible and keep their newest-first
// order by day. Within a day, items are ordered by this score: the filing a portfolio manager would
// read first comes first, routine paperwork sinks to the bottom of its day, and nothing disappears.
// No label is printed — no High/Medium/Low — because the order is the whole of the output.
//
// THE SCORE IS FEATURES, NEVER EXAMPLES. Nothing here names a company, a regulator's notice or a
// particular kind of filing the desk once discussed. Every item is read through the same seven
// inputs, each of which the request named:
//
//   category    what the item is about (announcement-categories.js), each category's prior reading
//               of materiality, financial impact, governance and future implications;
//   impact      an amount the item states (an order's value, a tax demand, a fund raise), measured
//               against the company's market cap — the same ₹100 Cr is a rounding error for one
//               company and a third of another;
//   size        the company's market-cap band (company-profile.js);
//   sector      whether the desk's own sector → KPI ontology says this kind of event moves this
//               sector's KPIs (kpi-impact.js TRIGGERS) — an inspection matters in pharma, an order
//               in capital goods — read from the ontology, not written here;
//   direction   the existing, tested filing rule (filing-signals.js): an adverse governance or credit
//               event reads higher than a neutral one;
//   duplicate   a second exchange's copy of a filing already counted ranks just below the first;
//   source      what the owning feed already says about the item (All Alerts' stated importance, a
//               news story's company match).
//
// Then the desk's shared feedback (relevance-feedback-shared.js) adds a learned adjustment on the
// same feature keys. The parts are returned so a test — or the provenance panel — can say why an
// item ranks where it does.

import { categoriesOf, categoryById, OTHER_CATEGORY, ROUTINE_CATEGORY } from './announcement-categories.js';
import { sectorAffinity } from './sector-affinity.js';
import { announcementSignal } from './filing-signals.js';
import { learnedAdjustment, featureKeys, EMPTY_MODEL } from './relevance-feedback-shared.js';

export const RELEVANCE_VERSION = '2026-10-01-v2';

// ---------------------------------------------------------------------------------------------
// Category prior
// ---------------------------------------------------------------------------------------------

const DIM_WEIGHTS = { materiality: 0.9, financial: 0.6, governance: 0.6, future: 0.5 };
export const ROUTINE_SCORE = -2.5;
const dimScore = (dims = {}) => Object.entries(DIM_WEIGHTS).reduce((sum, [k, w]) => sum + w * (Number(dims[k]) || 0), 0);

/**
 * The strongest tag counts in full, every further tag a quarter, capped so tags cannot stack. A tag
 * read only from a generic word (announcement-categories.js rule 3) carries half its weight.
 */
export function categoryPrior(ids = [], weak = []) {
  if (!ids.length) return dimScore(categoryById(OTHER_CATEGORY)?.dims);
  if (ids.includes(ROUTINE_CATEGORY)) return ROUTINE_SCORE;
  const scores = ids.map((id) => dimScore(categoryById(id)?.dims) * (weak.includes(id) ? 0.5 : 1)).sort((a, b) => b - a);
  return Math.min(9, scores[0] + 0.25 * scores.slice(1).reduce((a, b) => a + b, 0));
}

// ---------------------------------------------------------------------------------------------
// Stated amounts → ₹ crore
// ---------------------------------------------------------------------------------------------

// Reference rates for ranking only — never printed, never used to restate an amount.
const FX = { usd: 85, eur: 95, gbp: 110, jpy: 0.57 };
const UNIT_CR = { crore: 1, crores: 1, cr: 1, crs: 1, lakh: 0.01, lakhs: 0.01, lac: 0.01, lacs: 0.01, million: 0.1, mn: 0.1, billion: 100, bn: 100 };
const AMOUNT = /(?:\b(rs\.?|inr|usd|us\$|eur|gbp|jpy)|(₹|\$|€|£|¥))\s*([\d,]+(?:\.\d+)?)\s*(crores?|crs?\.?|cr\b|lakhs?|lacs?|million|mn\b|billion|bn\b)?|\b([\d,]+(?:\.\d+)?)\s*(crores?|cr\b|crs\b|lakhs?|lacs?)\b/g;
// Per-share figures, face values and percentages are not the size of an event.
const NOT_AN_AMOUNT = /^\s*(?:\/-?\s*)?(?:per\b|each\b|only\s+each\b|paid[- ]up\b|face value\b|fv\b|%|percent|per cent)/;
const CURRENCY = (symbol) => (/usd|us\$|\$/.test(symbol) ? 'usd' : /eur|€/.test(symbol) ? 'eur' : /gbp|£/.test(symbol) ? 'gbp' : /jpy|¥/.test(symbol) ? 'jpy' : 'inr');

/** Every amount the text states, in ₹ crore. An unreadable or per-share figure is skipped. */
export function statedAmountsCr(text) {
  const out = [];
  const value = String(text || '').toLowerCase();
  if (!/\d/.test(value)) return out;
  for (const m of value.matchAll(AMOUNT)) {
    const after = value.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (NOT_AN_AMOUNT.test(after)) continue;
    const currency = CURRENCY(m[1] || m[2] || 'rs');
    const number = Number(String(m[3] || m[5]).replace(/,/g, ''));
    const unit = String(m[4] || m[6] || '').replace(/\.$/, '');
    if (!Number.isFinite(number) || number <= 0) continue;
    let cr;
    if (currency === 'inr') {
      // A bare rupee figure with no unit is rupees: ₹5,00,00,000 is ₹5 crore.
      cr = unit ? number * (UNIT_CR[unit] ?? 1) : number / 1e7;
    } else {
      const units = unit === 'billion' || unit === 'bn' ? 1e9 : unit === 'million' || unit === 'mn' ? 1e6 : unit ? 1e7 * (UNIT_CR[unit] ?? 1) : 1;
      cr = (number * units * FX[currency]) / 1e7;
    }
    if (cr > 0 && cr < 5e7) out.push(cr);
  }
  return out;
}

// The categories whose stated amount IS the size of the event.
const AMOUNT_CATEGORIES = new Set(['order-win', 'order-loss', 'legal-regulatory', 'acquisition', 'divestment', 'capital-raise',
  'debt-financing', 'capacity-expansion', 'distress', 'merger-restructuring', 'governance-red-flag', 'operations-disruption', 'partnership-jv']);

export function impactLevel(amountCr, mcapCr) {
  if (!Number.isFinite(amountCr) || amountCr <= 0) return null;
  if (Number.isFinite(mcapCr) && mcapCr > 0) {
    const ratio = amountCr / mcapCr;
    return ratio >= 0.1 ? 'vhigh' : ratio >= 0.03 ? 'high' : ratio >= 0.01 ? 'mid' : ratio >= 0.002 ? 'low' : 'tiny';
  }
  // No market cap: the absolute size is the only reading, and a softer one.
  return amountCr >= 1000 ? 'abs-large' : amountCr >= 100 ? 'abs-mid' : 'abs-small';
}
const IMPACT_SCORE = { vhigh: 3, high: 2, mid: 1, low: 0, tiny: -0.75, 'abs-large': 1.5, 'abs-mid': 0.75, 'abs-small': 0 };

// ---------------------------------------------------------------------------------------------
// Size and sector
// ---------------------------------------------------------------------------------------------

// Size works twice: a small additive nudge, and a multiplier on the category prior — the same
// insolvency notice reads very differently at a ₹2 lakh crore company and at a dormant micro-cap.
// A company with no market cap is, in the retained captures, overwhelmingly a micro-cap, an SME or a
// suspended listing, so it is read like the smallest known band.
export const SIZE_SCORE = { mega: 1, large: 0.6, mid: 0.3, small: 0, micro: -0.3, unknown: -0.3 };
export const SIZE_MULTIPLIER = { mega: 1.25, large: 1.1, mid: 1, small: 0.9, micro: 0.75, unknown: 0.7 };

// A notice that something WILL be considered is not the thing itself: "Board meeting to be held on
// 15 October to consider the results" is calendar, and the results it names arrive later as their own
// filing. Its non-calendar tags keep a little over half their weight.
const PROSPECTIVE = /\b(?:to be held|will be held|is scheduled|scheduled to be held|to (?:inter alia )?consider|proposal to (?:consider|raise)|intimation of (?:the )?(?:board )?meeting|prior intimation|notice of (?:the )?board meeting|board meeting intimation)\b/;
export const PROSPECTIVE_MULTIPLIER = 0.55;
// An update inside a proceeding already under way (a creditors' committee meeting, a resolution
// professional's report) adds less than the event that started it.
const PROCESS_UPDATE = /\b(?:committee of creditors|coc meeting|undergoing cirp|in cirp\b|monitoring committee|updates? - corporate insolvency|resolution professional|interim resolution professional)\b/;
export const PROCESS_MULTIPLIER = 0.6;
// The second, third… filing a company makes on one day under the same primary category (an
// exchange copy, a re-filing, a string of process notices) is damped so one company cannot fill a day.
export const REPEAT_STEP = 0.8;
export const REPEAT_CAP = 2;

// Sector affinity is read from the desk's KPI ontology (sector-affinity.js, derived from
// kpi-impact.js TRIGGERS and asserted equal to it).
export { sectorAffinity };

// ---------------------------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------------------------

const DIRECTION_SCORE = { negative: 1, positive: 0.4, neutral: 0 };
const NEWS_MATCH_SCORE = { confirmed: 0.5, uncertain: -0.5, related: -0.75, unrelated: -1.5 };
// HOW MUCH THE SOURCE ITSELF VOUCHES FOR WHAT IT SAYS. An exchange filing is the company's own
// statement; a publisher's story is reporting; a social post or a chatter snapshot is unverified
// discussion that the reader is asked to corroborate. Read per source type, never per item.
export const SOURCE_RELIABILITY = { twitter: -1.5, telegram: -1.5, chatter: -1, 'market-news': -0.5 };

/**
 * One item's base relevance and the feature keys the shared feedback learns on.
 *
 * @param {object} item     a filing row, a news row or an All Alerts event
 * @param {object} ctx
 * @param {'filing'|'news'|'alert'} ctx.kind
 * @param {object} [ctx.profile]      { mcapCr, band, group } from company-profile.js
 * @param {string[]} [ctx.categories] tag ids, when the caller already has them
 * @param {boolean} [ctx.duplicate]   a later exchange copy of a filing already in the list
 * @param {number} [ctx.repeatIndex]  0 for a company's first filing of the day in its primary category, 1, 2… after
 * @param {string} [ctx.direction]    'positive' | 'negative' | 'neutral', when the feed states one
 * @param {string} [ctx.importance]   All Alerts' own 'high' | 'low'
 * @param {string} [ctx.match]        a news story's company match: confirmed / uncertain / related / unrelated
 * @param {string} [ctx.feed]         the All Alerts feed id
 */
export function relevanceReading(item = {}, ctx = {}) {
  const kind = ctx.kind || 'filing';
  const categoryKind = kind === 'news' ? 'news' : 'filing';
  const tagged = ctx.categories ? { ids: ctx.categories, weak: ctx.weakCategories || [] } : categoriesOf(item, categoryKind);
  const ids = tagged.ids;
  const profile = ctx.profile || {};
  const band = profile.band || 'unknown';
  const text = textOf(item);
  const routine = ids.includes(ROUTINE_CATEGORY);
  const lower = text.toLowerCase();
  const prospective = !routine && PROSPECTIVE.test(lower);
  const processUpdate = !routine && ids.includes('distress') && PROCESS_UPDATE.test(lower);
  const multiplier = routine ? 1 : (SIZE_MULTIPLIER[band] ?? 1) * (prospective ? PROSPECTIVE_MULTIPLIER : 1) * (processUpdate ? PROCESS_MULTIPLIER : 1);
  const parts = { category: categoryPrior(ids, tagged.weak || []) * multiplier, impact: 0, size: SIZE_SCORE[band] ?? 0, sector: 0, direction: 0, duplicate: 0, repeat: 0, source: 0 };
  if (profile.group && !routine) parts.sector = sectorAffinity(ids, profile.group, text);
  let impact = null;
  if (!routine && ids.some((id) => AMOUNT_CATEGORIES.has(id))) {
    const amounts = statedAmountsCr(text);
    if (amounts.length) {
      impact = impactLevel(Math.max(...amounts), profile.mcapCr);
      parts.impact = IMPACT_SCORE[impact] ?? 0;
    }
  }
  const stated = ctx.direction || (kind === 'filing' ? announcementSignal(filingFields(item)).direction : null);
  const direction = stated && !routine ? stated : null;
  if (direction) parts.direction = DIRECTION_SCORE[direction] ?? 0;
  if (ctx.duplicate) parts.duplicate = -1;
  if (ctx.repeatIndex > 0) parts.repeat = -Math.min(REPEAT_CAP, REPEAT_STEP * ctx.repeatIndex);
  if (kind === 'alert' && ctx.importance === 'high') parts.source += 1.5;
  if (ctx.match && ctx.match in NEWS_MATCH_SCORE) parts.source += NEWS_MATCH_SCORE[ctx.match];
  if (ctx.feed && ctx.feed in SOURCE_RELIABILITY) parts.source += SOURCE_RELIABILITY[ctx.feed];
  const base = Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 1000) / 1000;
  const facts = { categories: ids, band, group: profile.group || null, kind, feed: ctx.feed || null, impact, direction, prospective, processUpdate,
    duplicate: !!ctx.duplicate, repeat: ctx.repeatIndex > 0, importance: ctx.importance || null, match: ctx.match in NEWS_MATCH_SCORE ? ctx.match : null };
  return { base, parts, keys: featureKeys(facts), facts, categories: ids, weak: tagged.weak || [] };
}

/** Base plus the shared learned adjustment. `surface` is 'announcements' | 'news' | 'alerts'. */
export function relevanceScore(reading, { model = EMPTY_MODEL, surface = null, itemKey = null, eventKey = null } = {}) {
  const learned = learnedAdjustment(model, { keys: reading.keys, surface, itemKey, eventKey });
  return Math.round((reading.base + learned) * 1000) / 1000;
}

function filingFields(item) {
  return { category: item.category, subCategory: item.subCategory || item.filingSubCategory, title: item.title || item.filingSubject || item.headline,
    headline: item.headline, description: item.summary || item.description || item.filingDescription };
}
function textOf(item) {
  return [item.title || item.headline || item.subject || item.filingSubject, item.summary || item.description || item.filingDescription || item.detail]
    .filter(Boolean).join(' • ');
}

// ---------------------------------------------------------------------------------------------
// The order: newest day first, then relevance, then time — undated last.
// ---------------------------------------------------------------------------------------------

/**
 * A sort key that orders correctly under a plain DESCENDING string comparison: the day, then the
 * relevance (offset so negatives sort below positives), then the time. One string, so the table
 * kit's ordinary `sortValue` can carry it and its ascending direction remains the exact reverse.
 */
export function rankKey(day, score, time = '') {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : '0000-00-00';
  const s = Math.max(0, Math.min(99_999, Math.round((Number(score) || 0) * 100) + 50_000));
  return `${d}|${String(s).padStart(5, '0')}|${String(time || '').slice(0, 8).padEnd(8, '0')}`;
}

export function compareRanked(a, b) {
  // Descending: larger key first.
  return a < b ? 1 : a > b ? -1 : 0;
}
