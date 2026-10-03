// data/announcement-index-build.js — TAG, SCORE AND STITCH THE CORPORATE ANNOUNCEMENTS STREAM, ONCE.
//
// The one implementation of what the announcement index holds, driven in two places:
//   - on the runner, over the whole retained stream (scripts/build-announcement-index.mjs), where it
//     produces the artifact the Worker's index object serves;
//   - in the browser, over the rows of the period on screen, when that index cannot be read — the
//     fallback engine (announcement-query-local.js) — so the table reads the same either way.
//
// Each row gains four readings and nothing else: category tags (announcement-categories.js), a base
// relevance (relevance.js), its company's market cap (company-profile.js), and the event it belongs to
// (event-stitching.js). No capture, retention rule or source is changed, and no row is dropped.
//
// Written as a generator that yields between slices of rows, so the browser can drive it in slices
// (core/slices.js) without one long task; the runner drives the same generator synchronously.
import { categoriesOf } from './announcement-categories.js';
import { relevanceReading, REPEAT_STEP, REPEAT_CAP } from './relevance.js';
import { stitchEventsSteps, eventHash } from './event-stitching.js';
import { sourceStatement, clip } from './alert-claims.js';
import { announcementDocumentIdentity } from './announcements-shared.js';
import { UNDATED, ROW, encodeRow, emptyDict } from './announcement-index-shared.js';
import { runSteps } from '../core/slices.js';

const STEP_ROWS = 400;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (row) => (DAY_RE.test(row.date || '') ? row.date : UNDATED);
const timeOf = (row) => (DAY_RE.test(row.date || '') ? Date.parse(`${row.date}T${/^\d{2}:\d{2}(:\d{2})?$/.test(row.time || '') ? row.time.padEnd(8, ':00').slice(0, 8) : '00:00:00'}+05:30`) : null);
const nameKey = (value) => String(value || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').replace(/\b(LIMITED|LTD)\b/g, '').replace(/\s+/g, ' ').trim();

/**
 * Enrich and stitch every row. Returns the company table, the encoded rows per day, the string
 * dictionary and counts. Deterministic: the same captures always produce the same index.
 */
export function* buildIndexSteps({ rows, feed, profiles }) {
  const companies = [];
  const companyIndex = new Map();
  const companyNames = new Map();
  const companyOf = (row) => {
    const key = feed.companyKey(row) || (row.company ? `name:${nameKey(row.company)}` : null);
    if (!key) return -1;
    let idx = companyIndex.get(key);
    if (idx === undefined) {
      const identity = feed.companyIdentity(row);
      const scripCode = identity.bseCode || identity.scripCode || row.scripCode || null;
      const profile = profiles.profileOf({ ticker: identity.ticker || row.ticker, scripCode });
      idx = companies.length;
      companies.push({ k: key, t: identity.ticker || row.ticker || null, i: identity.isin || row.isin || null, s: scripCode,
        n: row.company || identity.name || null, m: profile.mcapCr, ma: profile.mcapAsOf, ms: profile.mcapSource, b: profile.band, g: profile.group });
      companyIndex.set(key, idx);
    }
    // The most frequent spelling of the company's name is the one the company table prints.
    if (row.company) {
      const names = companyNames.get(idx) || new Map();
      names.set(row.company, (names.get(row.company) || 0) + 1);
      companyNames.set(idx, names);
    }
    return idx;
  };

  // 1. One record per filing: identity, tags, base relevance.
  const records = [];
  const ids = new Map();
  for (const row of rows) {
    const idx = companyOf(row);
    const company = idx >= 0 ? companies[idx] : null;
    const doc = announcementDocumentIdentity(row.url) || '';
    const day = dayOf(row);
    const base = `${company?.k || ''}|${doc || row.url || row.title || ''}|${day}|${row.time || ''}`;
    let id = `a:${eventHash(base)}`;
    const n = (ids.get(id) || 0) + 1;
    ids.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    const tags = categoriesOf(row, 'filing');
    const reading = relevanceReading(row, { kind: 'filing', profile: company ? { mcapCr: company.m, band: company.b, group: company.g } : {}, categories: tags.ids, weakCategories: tags.weak });
    records.push({ row, idx, id, day, at: timeOf(row), doc, tags, reading });
    if (records.length % STEP_ROWS === 0) yield { phase: 'reading', done: records.length, total: rows.length };
  }

  yield { phase: 'linking', done: rows.length, total: rows.length };
  // 2. Events.
  const recordById = new Map(records.map((r) => [r.id, r]));
  const { byRow, events } = yield* stitchEventsSteps(records, {
    companyOf: (r) => (r.idx >= 0 ? companies[r.idx].k : null), idOf: (r) => r.id, timeOf: (r) => r.at, tagsOf: (r) => r.tags.ids,
    sourcesOf: (r) => r.row.sources || [r.row.source], rowOf: (r) => r.row,
  });
  const dayOfId = (id) => recordById.get(id)?.day || null;

  // 3. Repetition within an event on one day: the strongest filing keeps its score, each further one
  //    is damped (relevance.js REPEAT_STEP) — an exchange's second copy, a re-filing, a string of notices.
  const groups = new Map();
  let grouped = 0;
  for (const r of records) {
    const ev = byRow.get(r.id);
    const key = `${ev?.size > 1 ? ev.eventId : r.id}|${r.day}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(r);
    if (++grouped % STEP_ROWS === 0) yield { phase: 'linking', done: rows.length, total: rows.length };
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.reading.base - a.reading.base || (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
    list.forEach((r, i) => {
      if (!i) return;
      r.repeat = true;
      r.reading.base = Math.round((r.reading.base - Math.min(REPEAT_CAP, REPEAT_STEP * i)) * 1000) / 1000;
    });
  }

  yield { phase: 'ordering', done: 0, total: records.length };
  // 4. Encode, grouped by day, strongest first within a day.
  const dict = emptyDict();
  const byDay = new Map();
  let encodedCount = 0;
  for (const r of records) {
    const ev = byRow.get(r.id);
    const multi = ev && ev.size > 1 ? events.get(ev.eventId) : null;
    const facts = r.reading.facts;
    const sources = r.row.sources || (r.row.source ? [r.row.source] : []);
    const extraUrls = (r.row.sourceUrls || []).filter((s) => s?.url && s.url !== r.row.url).map((s) => [s.source || null, s.url]);
    const encoded = encodeRow({
      id: r.id, time: r.row.time ? String(r.row.time).slice(0, 8) : '', title: r.row.title || r.row.headline || '', subCategory: r.row.subCategory || '',
      category: r.row.category || '', sources, url: r.row.url || '', extraUrls, categories: r.tags.ids, weak: r.tags.weak || [], base: r.reading.base,
      impact: facts.impact, direction: facts.direction, prospective: facts.prospective, processUpdate: facts.processUpdate, duplicate: false, repeat: !!r.repeat,
      documentUnavailable: !!r.row.documentUnavailable, critical: !!r.row.critical,
      eventId: multi ? multi.id : 0, eventSize: multi ? multi.members.length : 1, eventPos: multi ? ev.position : 0,
      eventFirst: multi ? dayOfId(multi.members[0]) : 0, eventLast: multi ? dayOfId(multi.members[multi.members.length - 1]) : 0,
      providers: r.row.providers || [], summary: summaryOf(r.row), referenceUrl: r.row.referenceUrl || '', doc: r.doc,
      company: r.row.company || '',
    }, { companyIdx: r.idx, dict });
    let list = byDay.get(r.day);
    if (!list) byDay.set(r.day, (list = []));
    list.push(encoded);
    if (++encodedCount % STEP_ROWS === 0) yield { phase: 'ordering', done: encodedCount, total: records.length };
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => b[ROW.BASE] - a[ROW.BASE] || (a[ROW.TIME] < b[ROW.TIME] ? 1 : a[ROW.TIME] > b[ROW.TIME] ? -1 : 0) || (a[ROW.ID] < b[ROW.ID] ? -1 : 1));
    yield { phase: 'ordering', done: encodedCount, total: records.length };
  }
  for (const [idx, names] of companyNames) companies[idx].n = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const multiEvents = [...events.values()].filter((e) => e.members.length > 1).length;
  return { companies, byDay, dict, counts: { rows: records.length, companies: companies.length, events: events.size, multiEvents } };
}

/** The same build, driven to completion now. */
export const buildIndex = (input) => runSteps(buildIndexSteps(input));

// NSE's description, with its mechanical lead-in removed (alert-claims.js), where it says more than the subject.
function summaryOf(row) {
  const raw = row.summary || row.description || '';
  if (!raw) return '';
  const stated = sourceStatement(raw);
  if (!stated || stated.toLowerCase() === String(row.title || '').toLowerCase()) return '';
  return clip(stated, 400);
}

