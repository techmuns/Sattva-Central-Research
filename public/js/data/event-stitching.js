// data/event-stitching.js — WHICH FILINGS ARE THE SAME UNDERLYING EVENT.
//
// A company rarely files an event once. Results arrive as a board-meeting intimation, the outcome,
// the results themselves, a press release, an investor presentation, the earnings-call notice, the
// newspaper copy and the transcript; a capital raise as a board approval, an EGM notice, an
// in-principle approval, an allotment and a listing approval; most filings also arrive twice, once
// from each exchange. This module ties those filings into one event so a row can say "4 related
// filings" and the AI Read popup can show the whole history. Nothing is merged or hidden: every
// filing stays its own row, and an event is only a shared id.
//
// HOW TWO FILINGS ARE JUDGED TO BE ONE EVENT — generic rules over every company, no example rule:
//
//   1. SAME COMPANY, ALWAYS. Events never cross issuers.
//   2. SAME FAMILY. A filing's family is read from its category tags (results, capital, deal,
//      governance, legal, payout, order, rating, meeting, listing). Calendar filings — a board
//      meeting, an investor call, an AGM notice — join the family their own words name ("board
//      meeting to consider the financial results" joins the results family).
//   3. CLOSE IN TIME. Each family has a window between consecutive filings and a ceiling on the
//      whole event (a results cycle runs about five weeks; a scheme of arrangement many months).
//   4. ABOUT THE SAME THING. Except where a family is one-per-period (a quarter's results, one AGM),
//      the two filings must share salient words — a counterparty's name, the instrument, the person —
//      so two different acquisitions in one month stay two events.
//   5. EXCHANGE COPIES. The same day, from the other exchange, saying substantially the same thing,
//      is the same event whatever its family.
//
// An event's id is derived from its company and its FIRST filing's own id, so it is stable while the
// event grows; an earlier filing arriving late (company history backfills) starts the event earlier
// and gives it a new id, which is the honest result — it is a different, longer event.

import { categoryInput } from './announcement-categories.js';
import { runSteps } from '../core/slices.js';

const STITCH_STEP = 400;

export const STITCH_VERSION = '2026-10-01-v1';
const DAY = 86_400_000;

// [gap between consecutive filings, ceiling on the whole event, needs shared words?]
export const FAMILIES = {
  results: { gap: 25 * DAY, span: 45 * DAY, overlap: false },
  capital: { gap: 60 * DAY, span: 150 * DAY, overlap: true },
  deal: { gap: 90 * DAY, span: 270 * DAY, overlap: true },
  governance: { gap: 20 * DAY, span: 45 * DAY, overlap: true },
  legal: { gap: 45 * DAY, span: 180 * DAY, overlap: true },
  distress: { gap: 45 * DAY, span: 365 * DAY, overlap: false },
  payout: { gap: 30 * DAY, span: 60 * DAY, overlap: false },
  order: { gap: 3 * DAY, span: 7 * DAY, overlap: true },
  rating: { gap: 3 * DAY, span: 10 * DAY, overlap: true },
  meeting: { gap: 30 * DAY, span: 60 * DAY, overlap: false },
  listing: { gap: 30 * DAY, span: 90 * DAY, overlap: true },
  update: { gap: 2 * DAY, span: 5 * DAY, overlap: true },
  other: { gap: 1 * DAY, span: 2 * DAY, overlap: true },
};

const FAMILY_OF_CATEGORY = {
  results: 'results', 'business-update': 'update', 'order-win': 'order', 'order-loss': 'order', 'capacity-expansion': 'update',
  'product-approval': 'update', 'quality-inspection': 'legal', 'operations-disruption': 'legal', acquisition: 'deal', 'partnership-jv': 'deal',
  'subsidiary-structure': 'deal', divestment: 'deal', 'merger-restructuring': 'deal', 'capital-raise': 'capital',
  // Debenture tranches and ESOP allotments recur every few weeks; each is its own event.
  'debt-financing': 'update',
  'shareholder-returns': 'payout', 'credit-rating': 'rating', 'shareholding-changes': 'listing', 'management-change': 'governance',
  'board-change': 'governance', 'governance-red-flag': 'governance', 'legal-regulatory': 'legal', distress: 'distress', clarification: 'legal',
  'record-date': 'payout', 'listing-delisting': 'listing', esop: 'update', 'shareholder-meeting': 'meeting',
};
// What a calendar or routine filing is ABOUT, in its own words — read from its subject and
// description, never from the exchange's label: NSE files every analyst meeting under "Analysts/
// Institutional Investor Meet/Con. Call Updates", and that label alone says nothing about results.
// "Quarter ended" is not evidence either: every compliance certificate is for a quarter.
const NAMES_RESULTS = /\b(?:financial results?|results? for the (?:quarter|half|year|period|nine months)|un-?audited|audited (?:standalone|consolidated|financial)|earnings (?:call|presentation|release)|(?:q[1-4]|h[12])\s?(?:fy)?\s?'?\d{2}\b.{0,30}\b(?:results?|earnings|call|presentation|performance)|(?:investor|earnings|results?) presentation\b.{0,40}\b(?:q[1-4]|h[12]|quarter|half[- ]year|results?)|(?:transcript|audio recording|recording)\b.{0,40}\b(?:earnings|results?|con(?:ference)?\.?\s?call|analysts?\b.{0,20}call)|con(?:ference)?\.?\s?call\b.{0,60}\b(?:results?|earnings|q[1-4]|quarter))\b/;
const NAMES_CAPITAL = /\b(?:fund[- ]?rais\w+|preferential|qualified institution\w*|qip|rights issue|warrants?|convertible|allotment|issue of (?:equity )?shares|issue of securities)\b/;
const NAMES_PAYOUT = /\b(?:dividend|bonus|buy-?back|split)\b/;
const NAMES_DEAL = /\b(?:scheme of (?:arrangement|amalgamation)|amalgamation|merger|demerger|court convened|nclt convened)\b/;
const CALENDAR = new Set(['board-meeting', 'investor-communication', 'shareholder-meeting', 'routine-admin', 'other', 'record-date']);

/**
 * The family a filing belongs to, from its tags and — for a calendar filing — its own words.
 * A routine filing joins an event only as a copy of one (the newspaper copy of the results
 * advertisement); a compliance certificate or a trading-window notice starts no event of its own.
 */
export function eventFamily(ids = [], text = '') {
  const specific = ids.filter((id) => !CALENDAR.has(id));
  if (specific.includes('results')) return 'results';
  if (specific.includes('distress')) return 'distress';
  if (specific.length) return FAMILY_OF_CATEGORY[specific[0]] || 'other';
  if (ids.includes('routine-admin')) return /\b(?:newspaper|advertisement)\b.{0,80}\bfinancial results?\b|\bfinancial results?\b.{0,80}\b(?:newspaper|advertisement)\b/.test(text) ? 'results' : 'other';
  if (NAMES_RESULTS.test(text)) return 'results';
  if (NAMES_DEAL.test(text)) return 'deal';
  if (NAMES_CAPITAL.test(text)) return 'capital';
  if (NAMES_PAYOUT.test(text)) return 'payout';
  if (ids.includes('shareholder-meeting') || ids.includes('record-date')) return ids.includes('record-date') ? 'payout' : 'meeting';
  return 'other';
}

// Words that say what KIND of filing this is, not what it is about.
const STOP = new Set(('the of and for with from under to in on at by a an as is are be has have that this its it our we us any all per '
  + 'regulation regulations reg sebi lodr listing obligations disclosure disclosures requirements requirement intimation intimations '
  + 'update updates general company limited ltd private pvt exchange exchanges informed inform informs submitted submission herewith '
  + 'please find enclosed attached copy pursuant read regarding about held dated date meeting board directors outcome '
  + 'announcement announcements press release media news letter notice notices bse nse national stock india indian schedule para part '
  + 'sub clause xbrl subject further continuation earlier reference ref dear sir madam members shareholders shareholder equity shares '
  + 'share securities financial year quarter ended month day days crore crores lakh rupees inr usd mr ms mrs').split(/\s+/));

export function salientTokens(text) {
  const out = new Set();
  for (const word of String(text || '').toLowerCase().match(/[a-z][a-z0-9&]{2,}/g) || []) if (!STOP.has(word)) out.add(word);
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared < 2 ? 0 : shared / Math.min(a.size, b.size);
}

/**
 * Stitch a company-agnostic list of filings into events.
 *
 * @param {object[]} rows
 * @param {object} accessors
 * @param {(row) => string|null} accessors.companyOf   the company key (rule 1); null rows stay single
 * @param {(row) => string} accessors.idOf             each filing's own stable id
 * @param {(row) => number|null} accessors.timeOf      epoch ms of publication; undated rows stay single
 * @param {(row) => string[]} accessors.tagsOf          category ids
 * @param {(row) => string[]} [accessors.sourcesOf]     exchange labels, for rule 5
 * @param {(row) => object} [accessors.rowOf]           the filing whose words are read, when `rows` wraps it
 * @returns {{ byRow: Map<string, {eventId, size, position}>, events: Map<string, {id, company, family, members: string[]}> }}
 */
export function stitchEvents(rows, accessors) {
  return runSteps(stitchEventsSteps(rows, accessors));
}

/**
 * The same stitching as a generator that yields every STITCH_STEP filings, so a browser linking a long
 * history does it in slices (core/slices.js). Driven synchronously it is exactly `stitchEvents`.
 */
export function* stitchEventsSteps(rows, { companyOf, idOf, timeOf, tagsOf, sourcesOf = () => [], rowOf = (row) => row }) {
  const byCompany = new Map();
  for (const row of rows) {
    const company = companyOf(row);
    const at = timeOf(row);
    if (!company || !Number.isFinite(at)) continue;
    let list = byCompany.get(company);
    if (!list) byCompany.set(company, (list = []));
    list.push(row);
  }
  const byRow = new Map();
  const events = new Map();
  let linked = 0;
  for (const [company, list] of byCompany) {
    list.sort((a, b) => timeOf(a) - timeOf(b) || String(idOf(a)).localeCompare(String(idOf(b))));
    const open = [];
    for (const row of list) {
      const at = timeOf(row);
      const ids = tagsOf(row) || [];
      const input = categoryInput(rowOf(row), 'filing');
      const own = [input.topic, input.subject, input.description].filter(Boolean).join(' ');
      const family = eventFamily(ids, own);
      const tokens = salientTokens(`${input.label} ${own}`);
      const day = Math.floor((at + 19_800_000) / DAY);
      const sources = new Set(sourcesOf(row) || []);
      let best = null, bestScore = 0;
      for (let i = open.length - 1; i >= 0; i--) {
        const event = open[i];
        const rules = FAMILIES[event.family];
        if (at - event.last > Math.max(rules.gap, DAY)) continue;
        // Rule 5: the other exchange's copy, the same day.
        const copy = day === event.lastDay && overlap(tokens, event.lastTokens) >= 0.5;
        let score = copy ? 2 : 0;
        if (!copy && event.family === family && at - event.first <= rules.span) {
          const shared = overlap(tokens, event.tokens);
          if (!rules.overlap) score = 1 + shared;
          else if (shared >= 0.34) score = 1 + shared;
        }
        if (score > bestScore) { best = event; bestScore = score; }
      }
      if (best) {
        best.members.push(String(idOf(row)));
        best.last = at; best.lastDay = day; best.lastTokens = tokens;
        for (const t of tokens) best.tokens.add(t);
        for (const s of sources) best.sources.add(s);
      } else {
        const id = `ev:${eventHash(`${company}|${idOf(row)}`)}`;
        const event = { id, company, family, first: at, last: at, lastDay: day, tokens: new Set(tokens), lastTokens: tokens, sources, members: [String(idOf(row))] };
        open.push(event);
        events.set(id, event);
      }
      // Drop events that can no longer grow, so a long history stays linear.
      for (let i = open.length - 1; i >= 0; i--) {
        const e = open[i];
        if (at - e.last > Math.max(FAMILIES[e.family].gap, DAY) * 2 || at - e.first > FAMILIES[e.family].span * 2) open.splice(i, 1);
      }
      if (++linked % STITCH_STEP === 0) yield { phase: 'linking', done: linked, total: rows.length };
    }
  }
  const out = new Map();
  for (const event of events.values()) {
    event.members.forEach((member, position) => out.set(member, { eventId: event.id, size: event.members.length, position }));
    delete event.tokens; delete event.lastTokens; delete event.lastDay; delete event.sources;
  }
  return { byRow: out, events };
}

// FNV-1a, 64 bits as two 32-bit halves — short, stable, dependency-free.
export function eventHash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}
