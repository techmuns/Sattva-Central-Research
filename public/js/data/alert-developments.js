// data/alert-developments.js — ONE DEVELOPMENT, ONE ITEM.
//
// The customer's reading of Puravankara (September 2026): its ₹2,600 crore Goregaon redevelopment
// win reached the desk as seven or eight items — the press release it lodged with BSE, the same
// release on NSE through two routes, and a score of publisher write-ups of it — and the card led
// with one of the write-ups, so a corporate announcement read as generic news. Measured on the
// shipped captures for its Greater Noida land deal five days later: one press release, three
// exchange rows and thirty publisher stories, every one of them a separate row in All Alerts.
//
// So both alert surfaces fold what one development produced into ONE item, here, in one place:
//
//   * EXCHANGE COPIES. A filing lodged with both exchanges, and each exchange's own feed of it, is
//     one filing: rows carrying one document hash; rows lodged within the hour whose statements are
//     the same text (BSE files one corrigendum under three categories, NSE's feeds repeat each
//     other); a row on the OTHER exchange within the hour sharing a word of its statement; and
//     NSE's structured-form subject ("Resignation of Director/KMP/SMP") beside the statement of it.
//   * REPORTS OF IT. A publisher story joins the development when its headline carries one of the
//     development's figures and one of its words, or three of its words — or two, inside a day and
//     a half, where no rupee figure disagrees. Nothing is read but headlines and the filing's text.
//
// FOUR RULES KEEP THE FOLD HONEST, and each is one this codebase already runs on:
//
// 1. NOTHING IS DROPPED. A development carries every member; an item shows its lead and counts the
//    rest, search reads all of them and the export lists them. Folding is presentation, never a
//    collection rule — the source feeds, their counts and the saved pool are untouched.
// 2. THE COMPANY'S OWN STATEMENT LEADS. When a filing is among the members it is the lead, it is
//    labelled a Corporate announcement and the item links to that filing, not to a publisher's
//    account of it. BSE's wording before NSE's where both say the same, the richer claim first.
// 3. DIFFERENT DEVELOPMENTS STAY APART. Only one company's items fold together; a related-entity
//    report or a reviewed-unrelated result never folds; an unverified search match never opens a
//    development anybody else can join; a denial, cancellation or clarification never joins what it
//    answers; two rupee figures that disagree need far more than a shared word; a second filing is
//    never folded into a first by its words; and a report is matched against what the development
//    is ABOUT — its first report and its filings — so one broad story cannot chain two together.
// 4. ONLY COMPACT FIELDS ARE READ. The AI pool carries events without their source record, and a
//    fold that read one would group a pooled card differently from the same card read in full —
//    so this reads the headline, the filing's own subject, title, description and sub-category,
//    the URL, the detail line and the document hash, which every pooled event keeps. The one
//    exception is a story's publisher name, which the pool keeps for exactly this kind of reading.
import { clip, isTypeOnly, sourceStatement, filingClaim, CLAIM_MAX } from './alert-claims.js';
import { runSteps, runStepsInSlices } from '../core/slices.js';

/** A report joins a development whose first report is at most this many days away. */
export const DEVELOPMENT_WINDOW_DAYS = 7;
/** Rows lodged this close together can be one filing (see `isExchangeCopy`). */
export const FILING_COPY_MINUTES = 60;
/** Two shared words are enough only this close to the development's first report. */
export const NEAR_HOURS = 36;

const DAY_MS = 86_400_000;
const WINDOW_MS = DEVELOPMENT_WINDOW_DAYS * DAY_MS;
const COPY_MS = FILING_COPY_MINUTES * 60_000;
const NEAR_MS = NEAR_HOURS * 3_600_000;

const STORY_KINDS = { announcements: 'filing', 'nse-filings': 'filing', news: 'news', 'market-news': 'news', twitter: 'post' };
/** 'filing' | 'news' | 'post' for the feeds that report a development; null for a measurement. */
export const storyKindOf = (event) => STORY_KINDS[event?.feed] || null;

/** What an item IS, in the words the desk uses. A measurement keeps its feed's own label. */
export const KIND_LABEL = { filing: 'Corporate announcement', news: 'News', post: 'Social post' };

export function companyKeyOf(event) {
  const ticker = String(event?.ticker || '').trim().toUpperCase();
  if (ticker) return `T:${ticker}`;
  return event?.entityId ? `E:${event.entityId}` : null;
}

const hostOf = (url) => {
  const value = String(url || '');
  const scheme = value.indexOf('://');
  const from = scheme >= 0 && scheme <= 5 ? scheme + 3 : 0;
  let to = value.length;
  for (let i = from; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) { to = i; break; } // / ? #
  }
  return value.slice(from, to).toLowerCase();
};

/**
 * The exchanges a filing row came from: its detail line names them ("BSE · NSE · Company Update"),
 * and its URL is one of theirs.
 */
export function venuesOf(event) {
  const out = new Set();
  for (const name of String(event?.detail || '').split(' · ').slice(0, 2)) if (name === 'BSE' || name === 'NSE') out.add(name);
  const host = hostOf(event?.url);
  if (/(?:^|\.)bseindia\.com$/.test(host)) out.add('BSE');
  if (/(?:^|\.)nseindia\.com$/.test(host)) out.add('NSE');
  if (!out.size && event?.feed === 'nse-filings') out.add('NSE');
  return [...out].sort();
}

/** Who published a story: the capture's own publisher field, its byline, or the site it lives on. */
export function publisherOf(event) {
  const record = event?.sourceRecord && typeof event.sourceRecord === 'object' ? event.sourceRecord : {};
  for (const named of [record.source, record.publisher]) if (typeof named === 'string' && named.trim()) return named.trim();
  const byline = String(event?.detail || '').match(/^Published by (.+?)(?: · |$)/);
  if (byline) return byline[1].trim();
  return hostOf(event?.url).replace(/^www\./, '') || null;
}

const attributionOf = (event) => event?.attribution?.status || null;

/** When the source says it happened, in IST. A day-only row reads as that day's noon. */
const instants = new Map();
function instantOf(event) {
  const day = String(event?.day || '');
  const time = String(event?.time || '');
  const key = `${day} ${time}`;
  let at = instants.get(key);
  if (at === undefined) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
    at = valid ? Date.parse(`${valid}T${/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '12:00'}:00+05:30`) : NaN;
    if (instants.size > 8192) instants.clear();
    instants.set(key, at);
  }
  return at;
}

// ---------------------------------------------------------------------------------------
// WHAT A LINE IS ABOUT — content words and figures, nothing else
// ---------------------------------------------------------------------------------------

// Words that say nothing about WHICH development a line reports: grammar, exchange and filing
// boilerplate, market-move verbs, generic deal verbs, calendar words, the units of a figure and the
// fragments of a web address. A shared "secures" or "shares" is not evidence two headlines describe
// one event; a shared "Goregaon", "equinox" or "2600" is.
const STOP = new Set(`a an the and or but for nor of on in at to by with from into onto over under about after before
above below across amid among via per than then that this these those there here where when what which who whom whose why how
is are was were be been being am has have had having do does did done will would shall should can could may might must
it its they them their he him his she her we our us you your i me my
not no yes all any each every more most less least few many much some such only own same so too very just also even
new one two three four five six seven eight nine ten first second third last next latest top big major key amp
say says said tell tells told see sees seen get gets got set sets make makes made take takes took
informed exchange exchanges regarding limited company companies ltd dated titled announcement announcements intimation
intimations disclosure disclosures regulation regulations reg sebi listing obligations requirements schedule under press
release releases media update updates general board meeting outcome copy copies pursuant enclosed please find attached
herewith submission submitted lodr corporate filing filings pvt private inc corp group
crore crores cr lakh lakhs lac rupee rupees rs inr billion million bn mn cent percent pct
share shares stock stocks price prices market markets trade trading traded session sensex nifty bse nse ipo
india indian news live today yesterday tomorrow week weeks month months year years day days daily
january february march april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
rise rises rising rose jump jumps jumped jumping gain gains gained surge surges surged surging rally rallies rallied
fall falls fell falling drop drops dropped decline declines declined slump slumps slumped climb climbs climbed soar soars soared
up down high low higher lower focus buzz watch check details know here heres hindi
announces announced secures secured securing bags bagged bagging wins won win winning receives received lands landed
signs signed enters entered plans planned launches launched eyes eyed expects expected sees reports reported
ki ka ke mein hai ko se par aur com www net org http https html htm php aspx`.split(/\s+/).filter(Boolean));

/** A light suffix strip, so "resignation" / "resigns" and "projects" / "project" read as one word. */
function stem(word) {
  if (word.length <= 4) return word;
  if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'es', 'ed', 's']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

const UNIT_CRORE = { crore: 1, crores: 1, cr: 1, lakh: 0.01, lakhs: 0.01, lac: 0.01, lacs: 0.01, billion: 100, bn: 100, million: 0.1, mn: 0.1 };
const RUPEE_AFTER = /^\s*(?:rupees?|inr)\b/i;
const MONEY = /(₹|\b(?:rs|inr)\b\.?)?\s?(\d[\d,]*(?:\.\d+)?)\s*-?\s*(crores?|cr|lakhs?|lacs?|billion|bn|million|mn)\b/gi;

/**
 * The rupee amounts a line states, in crore, as strings — "Rs. 2600 Crore", "₹2,600-cr" and
 * "26 billion rupees" all read "2600". A billion or a million counts only beside a rupee sign or
 * word, so a dollar figure never masquerades as the same deal; a bare "₹500" is a price, not a size.
 */
// Most lines state no amount and many no figure at all; they share this one empty set, which
// nothing ever adds to (a development copies its sets before widening them — see `widen`).
const NONE = new Set();

const HAS_UNIT = /cr|la[ck]|illion|bn|mn/i;
function moneyOf(text) {
  const value = String(text || '');
  if (!/\d/.test(value) || !HAS_UNIT.test(value)) return NONE;
  const out = new Set();
  for (const match of value.matchAll(MONEY)) {
    const [whole, currency, digits, unitRaw] = match;
    const unit = unitRaw.toLowerCase();
    if (['billion', 'bn', 'million', 'mn'].includes(unit) && !currency && !RUPEE_AFTER.test(value.slice(match.index + whole.length))) continue;
    const amount = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.add(String(Math.round(amount * UNIT_CRORE[unit] * 100) / 100));
  }
  return out.size ? out : NONE;
}

const NEGATIVE = /\b(?:not|denies?|denied|rejects?|rejected|revokes?|revoked|bans?|banned|cancels?|cancell?ed|halts?|halted|suspends?|suspended|terminates?|terminated|withdraw\w*|scraps?|scrapped|clarif\w*)\b/i;
const PROSPECTIVE = /\b(?:talks|proposes?|proposed|plans? to|considering|explores?|exploring|mulls?|likely to|to acquire|to buy|bids? for|bidding)\b/i;
const COMPLETED = /\b(?:signs?|signed|wins?|won|awarded|approves?|approved|secures?|secured|completes?|completed|acquires?|acquired|bags?|bagged)\b/i;
const TOKEN = /[a-z]+|\d+(?:§\d+)?/g;

/**
 * The words and figures that identify what a line reports, company-agnostic so one reading of a row
 * serves every fold it is part of. Percentages are dropped first: "shares jump 3.8%" is the market's
 * reaction, and two stories sharing a percentage move are not thereby one event. Years and one- or
 * two-digit numbers say nothing either.
 */
export function lineTokens(text) {
  const raw = String(text || '');
  const money = moneyOf(raw);
  let cleaned = raw.toLowerCase();
  if (/\d/.test(cleaned)) {
    if (cleaned.includes('%') || cleaned.includes('per') || cleaned.includes('pct')) cleaned = cleaned.replace(/\d+(?:\.\d+)?\s*(?:%|per\s?cent\b|pct\b)/g, ' ');
    if (cleaned.includes(',')) cleaned = cleaned.replace(/(\d),(?=\d)/g, '$1');
    if (cleaned.includes('.')) cleaned = cleaned.replace(/(\d)\.(\d)/g, '$1§$2');
  }
  const words = new Set();
  let figures = money.size ? new Set(money) : null;
  for (const [piece] of cleaned.matchAll(TOKEN)) {
    const code = piece.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      const figure = piece.replace('§', '.');
      if (!figure.includes('.') && (figure.length < 3 || /^(?:19|20)\d\d$/.test(figure))) continue;
      (figures ||= new Set()).add(figure);
      continue;
    }
    if (piece.length < 3 || STOP.has(piece)) continue;
    const stemmed = stem(piece);
    if (!STOP.has(stemmed)) words.add(stemmed);
  }
  return { words, figures: figures || NONE, money };
}

const sizeOf = (text) => { const t = lineTokens(text); return t.words.size + t.figures.size; };

/**
 * THE RICHER OF THE EXCHANGE'S OWN STATEMENTS. NSE files a category as the subject — "Product
 * launch", "Resignation", "Corrigendum" — and the event in its description ("…about launch of Phase
 * 6 in the existing project Provident Equinox…"); a row lodged on both exchanges keeps NSE's bare
 * subject and carries BSE's full title beside it. `filingClaim` keeps a subject that names anything
 * at all, which is right for a one-line card sentence and too little for the line that has to say
 * which development this is. Choosing among the exchanges' own texts is selection, not rewording:
 * BSE's title first where it says as much, and a description only where it says two things more.
 */
export function filingStatement(event) {
  const titles = [event?.filingHeadline ? filingClaim({ ...event, filingSubject: event.filingHeadline, filingDescription: null }) : null, filingClaim(event)]
    .filter((text) => text && !isTypeOnly(text));
  let best = titles[0] || filingClaim(event);
  for (const text of titles.slice(1)) if (sizeOf(text) > sizeOf(best)) best = text;
  const described = sourceStatement(event?.filingDescription);
  if (!described || isTypeOnly(described)) return best;
  return isTypeOnly(best) || sizeOf(described) >= sizeOf(best) + 2 ? clip(described) : best;
}

/** A publisher's own name trailing its headline — " - The Economic Times", " | InvestyWise". */
const MASTHEAD = /\b(?:news|times|standard|mint|express|tribune|today|live|details|line|moneycontrol|investywise|tradingview|whalesbook|realty|print|excelsior|cnbc\s?tv18|et\s?realty|capital market|industry|company|business|markets?|stock)\b/i;
function withoutMasthead(text, publisher) {
  const parts = String(text || '').split(/\s+[|–—-]\s+/);
  const name = String(publisher || '').toLowerCase().slice(0, 12);
  while (parts.length > 1) {
    const tail = parts.at(-1).trim();
    if (tail.split(/\s+/).length <= 6 && ((name && tail.toLowerCase().includes(name)) || MASTHEAD.test(tail))) parts.pop();
    else break;
  }
  return parts.join(' - ');
}

/** The text a row is matched on: a filing's own statements, a story's headline without its masthead. */
function matchText(event, kind) {
  if (kind === 'filing') {
    // The filing's own texts, never the exchange's sub-category: "Award of Order / Receipt of
    // Order" is the category of every order filing and says nothing about which one this is.
    return [sourceStatement(event?.filingDescription), event?.filingSubject, event?.filingHeadline, event?.headline]
      .filter(Boolean).join(' . ');
  }
  // A publisher's masthead and a web address are not what the story is about: "- english.
  // punjabkesari.com" and "| Markets News - Business Standard" gave unrelated stories three words
  // in common.
  const headline = withoutMasthead(String(event?.headline || ''), publisherOf(event));
  return headline.includes('.') ? headline.replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|net|org|co|io|news)\b/gi, ' ') : headline;
}

/**
 * A statement reduced to its letters and digits, with the rupee written one way: BSE's "Rs. 2600
 * Crore redevelopment project in Goregaon" and NSE's "Rs 2,600 crore redevelopment project
 * inGoregaon" are one key. A row carries one key per statement it has — a merged BSE/NSE row both.
 */
const compactKey = (text) => String(text || '').toLowerCase()
  .replace(/₹|\binr\b|\brs\b\.?/g, 'rs').replace(/\bcrores?\b|\bcr\b\.?/g, 'crore').replace(/[^a-z0-9]+/g, '');

// NSE's structured-form subjects — "Resignation of Director/KMP/SMP", "Change in Directors/KMP/SMP/
// Auditor/RTA" — are the exchange's category for a filing it often also carries as a plain statement
// minutes earlier. Such a subject is the same filing when every word it has beyond the roles is in
// the statement: a resignation form joins the resignation, never the appointment beside it.
const CATEGORY_FORM = /\/\s*(?:kmp|smp|auditor|rta)\b/i;
const ROLE_WORDS = new Set(['director', 'kmp', 'smp', 'auditor', 'rta', 'secretary', 'compliance', 'officer', 'chief', 'financial',
  'executive', 'independent', 'additional', 'managing', 'whole', 'time', 'designated', 'person', 'key', 'managerial', 'personnel',
  'senior', 'management', 'statutory', 'internal', 'secretarial', 'cost', 'registrar', 'transfer', 'agent']);

const readings = new WeakMap();
const NO_VENUES = Object.freeze([]);

/**
 * What one row says, read once. Keyed on the row object — rows are replaced, never edited — and
 * validated on every field it reads, the same arrangement as the other per-row readings here. What
 * only a comparison or a lead needs is read on first use: most rows are compared with a handful of
 * others and lead nothing, and choosing a filing's statement costs several readings of its text.
 */
class Reading {
  constructor(event, kind) {
    this.event = event;
    this.kind = kind;
    this.headline = event.headline; this.subject = event.filingSubject; this.title = event.filingHeadline;
    this.description = event.filingDescription; this.day = event.day; this.time = event.time; this.url = event.url;
    this.ticker = event.ticker; this.entityId = event.entityId;
    this._text = undefined; this._tokens = null; this._digits = undefined;
    this.key = companyKeyOf(event);
    this.at = instantOf(event);
    // A row the source dated to the day alone reads as that day's noon — which says nothing about
    // whether it was lodged within the hour of another, so it takes no rule that needs the hour.
    this.timed = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(event.time || ''));
    this.categoryLike = kind === 'filing' && CATEGORY_FORM.test(`${event.filingSubject || ''} ${event.headline || ''}`);
    this.venues = kind === 'filing' ? venuesOf(event) : NO_VENUES;
    this.documentHash = typeof event.documentHash === 'string' && event.documentHash ? event.documentHash : null;
    this._claim = undefined; this._claimKeys = undefined; this._typeOnly = undefined; this._flags = null;
  }
  current(event) {
    return this.headline === event.headline && this.subject === event.filingSubject && this.title === event.filingHeadline &&
      this.description === event.filingDescription && this.day === event.day && this.time === event.time && this.url === event.url &&
      this.ticker === event.ticker && this.entityId === event.entityId;
  }
  // The words and figures are read on first use: a company whose rows are all filings folds them
  // by document, time and statement, and most of its filings are never compared by their words.
  get text() {
    if (this._text === undefined) this._text = this.kind ? matchText(this.event, this.kind) : String(this.event.headline || '');
    return this._text;
  }
  get words() { return (this._tokens ||= lineTokens(this.text)).words; }
  get figures() { return (this._tokens ||= lineTokens(this.text)).figures; }
  get money() { return (this._tokens ||= lineTokens(this.text)).money; }
  /** Runs of three or more digits in the filing's own texts, commas dropped — a cheap first test of
   * whether two filings could be one statement, taken before the statements are chosen. */
  get digits() {
    if (this._digits === undefined) {
      const event = this.event;
      const raw = `${event.headline || ''} ${event.filingSubject || ''} ${event.filingHeadline || ''}`;
      const found = /\d/.test(raw) ? raw.replace(/(\d),(?=\d)/g, '$1').match(/\d{3,}/g) : null;
      this._digits = found ? new Set(found) : NONE;
    }
    return this._digits;
  }
  get claim() {
    if (this._claim === undefined) this._claim = this.kind === 'filing' ? filingStatement(this.event) : String(this.event.headline || '');
    return this._claim;
  }
  get claimKeys() {
    if (this._claimKeys === undefined) {
      const event = this.event;
      this._claimKeys = this.kind === 'filing'
        ? [...new Set([event.filingHeadline ? filingClaim({ ...event, filingSubject: event.filingHeadline, filingDescription: null }) : null,
          filingClaim(event), sourceStatement(event.filingDescription), event.headline]
          .filter((line) => line && !isTypeOnly(line)).map(compactKey).filter((key) => key.length >= 8))]
        : [];
    }
    return this._claimKeys;
  }
  get typeOnly() {
    if (this._typeOnly === undefined) this._typeOnly = this.kind === 'filing' && isTypeOnly(this.claim);
    return this._typeOnly;
  }
  // Read only when two rows are actually compared, which most rows never are.
  get flags() {
    this._flags ||= { negative: NEGATIVE.test(this.text), prospective: PROSPECTIVE.test(this.text), completed: COMPLETED.test(this.text) };
    return this._flags;
  }
}

export function developmentReading(event) {
  const hit = readings.get(event);
  if (hit && hit.current(event)) return hit;
  const value = new Reading(event, storyKindOf(event));
  readings.set(event, value);
  return value;
}

// ---------------------------------------------------------------------------------------
// THE FOLD
// ---------------------------------------------------------------------------------------

/** The words of a company's own name and ticker, which identify no development of that company. */
function ownWordsOf(names) {
  const out = new Set();
  for (const name of names) {
    for (const word of String(name || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3) { out.add(word); out.add(stem(word)); }
    }
  }
  return out;
}

// The company's own words are never evidence of anything, so every comparison skips them.
const countExcept = (a, b, skip) => { let n = 0; for (const item of a) if (!skip.has(item) && b.has(item)) n += 1; return n; };
const overlapsExcept = (a, b, skip) => { for (const item of a) if (!skip.has(item) && b.has(item)) return true; return false; };
const overlaps = (a, b) => { for (const item of a) if (b.has(item)) return true; return false; };
const count = (a, b) => { let n = 0; for (const item of a) if (b.has(item)) n += 1; return n; };

function sameStatement(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (short.length >= 25 && long.includes(short)) return true;
    }
  }
  return false;
}

/**
 * One filing row lodged as a copy of another. Statements are compared as TEXT, never as tokens:
 * "Stream batch first arrival" and "…second arrival" share every token that is not a stop word and
 * are two filings.
 */
function isExchangeCopy(a, b, own) {
  if (a.documentHash && a.documentHash === b.documentHash) return true;
  if (!Number.isFinite(a.at) || !Number.isFinite(b.at) || Math.abs(a.at - b.at) > COPY_MS) return false;
  // Two statements that each state a figure and share none are not one text — "…first batch of
  // 120" and "…of 480" — so the text comparison below is skipped for them, and it is the costly one.
  const distinctFigures = a.digits.size > 0 && b.digits.size > 0 && !overlaps(a.digits, b.digits);
  if (!distinctFigures && sameStatement(a.claimKeys, b.claimKeys)) return true;
  // The two looser rules are about rows lodged within the hour of each other, so both rows must
  // carry the source's own time: two day-only filings are "the same noon" only by our reading.
  if (!a.timed || !b.timed) return false;
  if (a.categoryLike !== b.categoryLike) {
    const [form, statement] = a.categoryLike ? [a, b] : [b, a];
    const core = [...form.words].filter((word) => !ROLE_WORDS.has(word) && !own.has(word));
    if (core.length && core.every((word) => statement.words.has(word))) return true;
  }
  // The other exchange's copy: both exchanges must be KNOWN and different. A row whose exchange
  // the source did not name is not evidence of being the other exchange's twin.
  if (!a.venues.length || !b.venues.length || a.venues.some((venue) => b.venues.includes(venue))) return false;
  // A category-only claim ("Press Release") beside its twin on the other exchange says nothing
  // against being that twin; anything else has to share a word or a figure with it.
  return a.typeOnly || b.typeOnly || overlapsExcept(a.words, b.words, own) || overlaps(a.figures, b.figures);
}

/** Does this report describe the development? `weak` allows the two-word, near-in-time reading. */
function reportsDevelopment(r, dev, weak, own) {
  if (!Number.isFinite(r.at) || Math.abs(r.at - dev.anchorAt) > WINDOW_MS) return false;
  // Matched against what the development is ABOUT — its first report and its filings — never
  // against words a later member brought in, so one broad story cannot bridge two developments.
  if (!overlapsExcept(r.words, dev.anchorWords, own) && !overlaps(r.figures, dev.anchorFigures)) return false;
  const flags = r.flags;
  const anchor = dev.first.reading.flags;
  if (flags.negative !== anchor.negative) return false;
  const sharedMoney = overlaps(r.money, dev.money);
  if (!sharedMoney && ((flags.prospective && anchor.completed) || (flags.completed && anchor.prospective))) return false;
  const moneyConflict = r.money.size > 0 && dev.money.size > 0 && !sharedMoney;
  // Words are counted against what the development is ABOUT, never against words a later member
  // brought in: stories comparing banks share the names of five other banks with each other, and
  // counted against the union an "FD rates" story joined a run of "bank holiday" stories that way.
  const words = countExcept(r.words, dev.anchorWords, own);
  const figures = count(r.figures, dev.figures);
  if (figures >= 1 && words >= 1) return true;
  if (words >= 4) return true;
  if (words >= 3 && !moneyConflict) return true;
  return weak && words >= 2 && !moneyConflict && Math.abs(r.at - dev.anchorAt) <= NEAR_MS;
}

function joins(item, dev, own) {
  // A "possible match" is a search result the attribution rules could not tie to the company, and
  // unrelated results share mastheads and market words with each other. So one never opens a
  // development anybody else can join; it can only join one a filing or a confirmed report opened.
  if (!dev.trusted) return false;
  if (item.kind === 'filing') {
    for (const other of itemsOf(dev)) if (other.kind === 'filing' && isExchangeCopy(item.reading, other.reading, own)) return true;
    // A filing that follows the news of itself joins it; a filing beside another filing is a new
    // statement by the company — a clarification, a correction — and is never folded by its words.
    return !dev.hasFiling && reportsDevelopment(item.reading, dev, false, own);
  }
  return reportsDevelopment(item.reading, dev, item.kind === 'news' && attributionOf(item.event) !== 'uncertain', own);
}

// A development of one row borrows that row's reading as its sets and copies them only when a
// second row joins (`widen`), so the thousands of rows that fold with nothing allocate little.
class OpenDevelopment {
  constructor(item, serial) {
    const r = item.reading;
    this.items = null;
    this.first = item;
    this.hasFiling = item.kind === 'filing';
    this.lastFilingAt = item.kind === 'filing' ? r.at : -Infinity;
    this.trusted = item.kind === 'filing' || (item.kind === 'news' && attributionOf(item.event) !== 'uncertain');
    this.anchorAt = r.at;
    this.borrowed = true;
    this.serial = serial;
    this.stamp = 0;
    this._anchorWords = null; this._anchorFigures = null; this._figures = null; this._money = null;
  }
  // Borrowed from the first row's reading until a second row joins, and so read only if asked.
  get anchorWords() { return this._anchorWords || this.first.reading.words; }
  get anchorFigures() { return this._anchorFigures || this.first.reading.figures; }
  get figures() { return this._figures || this.first.reading.figures; }
  get money() { return this._money || this.first.reading.money; }
}
const openDevelopment = (item, serial) => new OpenDevelopment(item, serial);

const itemsOf = (dev) => dev.items || [dev.first];

function widen(dev) {
  if (!dev.borrowed) return;
  const r = dev.first.reading;
  dev.items = [dev.first];
  dev._figures = new Set(r.figures);
  dev._money = new Set(r.money);
  dev._anchorWords = new Set(r.words);
  dev._anchorFigures = new Set(r.figures);
  dev.borrowed = false;
}

function absorb(dev, item) {
  const r = item.reading;
  widen(dev);
  dev.items.push(item);
  for (const figure of r.figures) dev.figures.add(figure);
  for (const amount of r.money) dev.money.add(amount);
  if (item.kind === 'filing') {
    dev.hasFiling = true;
    dev.lastFilingAt = Math.max(dev.lastFilingAt, r.at);
    // A filing is what the development is about, so it widens the anchor a report is held to.
    for (const word of r.words) dev.anchorWords.add(word);
    for (const figure of r.figures) dev.anchorFigures.add(figure);
  }
}

const PLACEHOLDER_COMPANY = /^(?:—|-|Unresolved company|Unrelated search result|Market-wide)$/;
const KIND_RANK = { filing: 0, news: 1, post: 2 };
const byPreference = (a, b) => Number(b.hasFiling) - Number(a.hasFiling) || b.anchorAt - a.anchorAt || b.serial - a.serial;

const scratch = []; // one candidate list, reused for every row
let stamp = 0;

/**
 * The newest developments one word or figure can offer a row. A company that files a hundred
 * notices in a morning, or draws two hundred stories in a week, puts every one of them on the
 * posting list of its commonest words, and comparing each new row with all of them is quadratic
 * in the busiest companies — measured, a 100,000-filing ranking went from well under the page's
 * budget to past it. A specific word ("Goregaon", "2600") has a short list and still reaches
 * back the whole window; a common one offers only its newest, which is where the development a
 * new row reports almost always is.
 */
export const CANDIDATES_PER_TOKEN = 16;
// How far back one posting list is walked for them, and how many filings of the last hour a
// filing is compared with as a possible copy — a board meeting's outcome, results, press release
// and presentation lodged on both exchanges within minutes is the busy case, and fits.
const SCAN_PER_TOKEN = 64;
const COPY_CANDIDATES = 12;

// Rows arrive in time order, so a posting list's front is always the first to fall out of the
// window and is dropped there for good; a common word never makes a row re-read a year of history.
// A FILING SKIPS DEVELOPMENTS THAT ALREADY HOLD ONE: it can join those only as an exchange copy,
// and every copy candidate is gathered by time and document below.
function collect(entry, r, filing) {
  if (!entry) return;
  const list = entry.devs;
  while (entry.start < list.length && r.at - list[entry.start].anchorAt > WINDOW_MS) entry.start += 1;
  let taken = 0;
  const floor = Math.max(entry.start, list.length - SCAN_PER_TOKEN);
  for (let i = list.length - 1; i >= floor && taken < CANDIDATES_PER_TOKEN; i -= 1) {
    const dev = list[i];
    if (dev.stamp === stamp || r.at - dev.anchorAt > WINDOW_MS || (filing && dev.hasFiling)) continue;
    dev.stamp = stamp;
    scratch.push(dev);
    taken += 1;
  }
}

function indexTokens(map, tokens, dev, skip) {
  for (const token of tokens) {
    if (skip && skip.has(token)) continue;
    const entry = map.get(token);
    if (!entry) map.set(token, { devs: [dev], start: 0 });
    else if (entry.devs[entry.devs.length - 1] !== dev) entry.devs.push(dev);
  }
}

/**
 * One company's rows folded into developments, clusters of more than one pushed onto `out`.
 *
 * A heavily covered company carries hundreds of reports a week, so candidates come from an index of
 * what each open development is about rather than from a scan of all of them: a report can only
 * join a development it shares an anchor word or figure with, and a filing copy only one with a
 * filing in the last hour or the same document. The answer is the scan's answer, found faster.
 */
function clusterCompany(group, extraNames, out) {
  const names = [...new Set([...extraNames, ...group.map((item) => item.event.company)]
    .filter((name) => name && !PLACEHOLDER_COMPANY.test(name)))];
  const own = ownWordsOf([...names, ...group.map((item) => item.event.ticker)]);
  // `group` arrives in time order (see `clusterSteps`).
  const wordIndex = new Map(); // anchor word -> developments about it
  const figureIndex = new Map(); // anchor figure -> developments about it
  // The same, for developments a REPORT opened. A filing can join a development only as one of
  // these (or as an exchange copy, gathered below), so it looks here and never walks past the
  // company's other filings — a hundred notices in one morning share their commonest words.
  const reportWordIndex = new Map();
  const reportFigureIndex = new Map();
  // A company with no report among its rows folds filings only as exchange copies, which are found
  // by document, time and statement — so nothing is indexed by its words and none are read.
  const hasReports = group.some((item) => item.kind !== 'filing');
  const byHash = new Map();
  const filingDevs = []; // developments holding a filing, in the order that filing arrived
  const joined = [];
  let serial = 0;
  for (const item of group) {
    const r = item.reading;
    stamp += 1;
    scratch.length = 0;
    const filing = item.kind === 'filing';
    const words = filing ? reportWordIndex : wordIndex;
    const figures = filing ? reportFigureIndex : figureIndex;
    if (words.size) for (const token of r.words) if (!own.has(token)) collect(words.get(token), r, filing);
    if (figures.size) for (const token of r.figures) collect(figures.get(token), r, filing);
    if (filing) {
      if (r.documentHash) for (const dev of byHash.get(r.documentHash) || []) if (dev.stamp !== stamp) { dev.stamp = stamp; scratch.push(dev); }
      let taken = 0;
      for (let i = filingDevs.length - 1; i >= 0 && taken < COPY_CANDIDATES && r.at - filingDevs[i].lastFilingAt <= COPY_MS; i -= 1) {
        const dev = filingDevs[i];
        if (dev.stamp !== stamp && r.at - dev.anchorAt <= WINDOW_MS) { dev.stamp = stamp; scratch.push(dev); taken += 1; }
      }
    }
    // The most preferred development that takes the row — the same answer as sorting every
    // candidate and trying each in turn, without the sort, and without asking a candidate that
    // could not win anyway.
    let home = null;
    for (const dev of scratch) {
      if (home && byPreference(dev, home) >= 0) continue;
      if (joins(item, dev, own)) home = dev;
    }
    let dev = home;
    if (home) {
      if (home.borrowed) joined.push(home);
      absorb(home, item);
    } else dev = openDevelopment(item, serial++);
    // Only what a development is ABOUT is indexed: its first row, and every filing in it.
    if (hasReports && (!home || item.kind === 'filing')) {
      indexTokens(wordIndex, r.words, dev, own);
      indexTokens(figureIndex, r.figures, dev, null);
    }
    if (!home && !filing) {
      indexTokens(reportWordIndex, r.words, dev, own);
      indexTokens(reportFigureIndex, r.figures, dev, null);
    }
    if (item.kind === 'filing') {
      filingDevs.push(dev);
      if (r.documentHash) {
        const list = byHash.get(r.documentHash);
        if (!list) byHash.set(r.documentHash, [dev]);
        else list.push(dev);
      }
    }
  }
  scratch.length = 0;
  joined.sort((a, b) => a.serial - b.serial);
  for (const dev of joined) out.push({ items: dev.items, names });
}

/**
 * The clusters of more than one row among `events`, company by company. A row in none of them
 * stands alone. `extraNames` names the company where the rows do not (a card's holding name).
 *
 * A GENERATOR that yields between batches of rows and between companies, so a stream of a quarter
 * of a million rows can fold in slices (`foldAlertRowsInSlices`) while a card's few dozen fold at
 * once (`runSteps`) — one implementation, two drivers, the same answer.
 */
function* clusterSteps(events, extraNames) {
  const byCompany = new Map();
  for (let from = 0; from < events.length; from += 4096) {
    const to = Math.min(events.length, from + 4096);
    for (let index = from; index < to; index += 1) {
      const event = events[index];
      const kind = storyKindOf(event);
      if (!kind) continue;
      const status = event.attribution?.status;
      if (status === 'unrelated' || status === 'related') continue;
      const reading = developmentReading(event);
      if (!reading.key || !Number.isFinite(reading.at)) continue;
      const group = byCompany.get(reading.key);
      if (!group) byCompany.set(reading.key, [{ event, kind, index, reading }]);
      else group.push({ event, kind, index, reading });
    }
    yield;
  }
  const clusters = [];
  const names = extraNames.join('\u0001');
  let pending = 0;
  for (const [key, group] of byCompany) {
    if (group.length < 2) continue;
    // Chronological, and a filing before a report that carries the same minute, so the company's
    // statement opens the development its reports then join.
    group.sort(byTime);
    // A COMPANY WHOSE ROWS ARE UNCHANGED FOLDS AS IT DID. A live stream publishes partial reports
    // as its sources settle, and a new filing touches one company: its folds are kept per company
    // and reused while that company's rows are the same objects in the same order, so an update
    // re-folds the companies it changed rather than a year of history.
    const memoKey = `${key}\u0002${names}`;
    const memo = companyFolds.get(memoKey);
    if (memo && memo.events.length === group.length && memo.events.every((event, i) => event === group[i].event)) {
      for (const cluster of memo.clusters) clusters.push(cluster);
      continue;
    }
    const out = [];
    clusterCompany(group, extraNames, out);
    if (companyFolds.size > 50_000) companyFolds.clear();
    companyFolds.set(memoKey, { events: group.map((item) => item.event), clusters: out });
    for (const cluster of out) clusters.push(cluster);
    pending += group.length;
    if (pending >= 512) { pending = 0; yield; }
  }
  return clusters;
}

const byTime = (a, b) => a.reading.at - b.reading.at || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.index - b.index;
const companyFolds = new Map();

const ATTRIBUTION_RANK = { confirmed: 0, related: 1, uncertain: 2, unrelated: 3 };
const tokenCount = (item) => item.reading.words.size + item.reading.figures.size;

/**
 * The member that represents the development (rule 2): the company's own filing before any report
 * of it, a statement before a bare category, the richer statement, BSE before NSE; then the
 * confirmed and the material report, then the earliest. Deterministic, so the lead — and the AI
 * note keyed on it — never flickers between two paints of the same rows.
 */
function leadOf(items) {
  return [...items].sort((a, b) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (a.kind === 'filing' ? Number(a.reading.typeOnly) - Number(b.reading.typeOnly) || tokenCount(b) - tokenCount(a) ||
      Number(!a.reading.venues.includes('BSE')) - Number(!b.reading.venues.includes('BSE')) : 0) ||
    (ATTRIBUTION_RANK[attributionOf(a.event)] ?? 0) - (ATTRIBUTION_RANK[attributionOf(b.event)] ?? 0) ||
    Number(b.event.importance === 'high') - Number(a.event.importance === 'high') ||
    a.reading.at - b.reading.at || a.index - b.index)[0];
}

const STRENGTH = { negative: 2, positive: 1 };
/** The member whose direction the development carries: the lead's, or a directional exchange copy's. */
function directionOf(lead, members) {
  if (lead.direction && lead.direction !== 'neutral') return lead;
  const filed = members.filter((event) => storyKindOf(event) === 'filing' && event.direction && event.direction !== 'neutral');
  return filed.sort((a, b) => (STRENGTH[b.direction] || 0) - (STRENGTH[a.direction] || 0))[0] || lead;
}

/**
 * The development as the surfaces read it. `id` is the lead's own id — the record the item shows
 * and opens — so it changes only when a stronger lead arrives, which is itself news worth showing.
 */
function developmentOf(items, names) {
  const members = [...items].sort((a, b) => a.reading.at - b.reading.at || a.index - b.index);
  const leadItem = leadOf(items);
  const lead = leadItem.event;
  const events = members.map((item) => item.event);
  const filings = members.filter((item) => item.kind === 'filing');
  const newest = members.at(-1).event;
  const material = lead.importance === 'high' ? lead : events.find((event) => event.importance === 'high') || lead;
  const directed = directionOf(lead, events);
  return {
    id: lead.id,
    key: companyKeyOf(lead),
    lead,
    members: events,
    others: events.filter((event) => event !== lead),
    kind: leadItem.kind,
    label: KIND_LABEL[leadItem.kind],
    venues: [...new Set(filings.flatMap((item) => item.reading.venues))].sort(),
    filings: filings.length,
    reports: members.filter((item) => item.kind === 'news').length,
    posts: members.filter((item) => item.kind === 'post').length,
    publishers: [...new Set(members.filter((item) => item.kind === 'news').map((item) => publisherOf(item.event)).filter(Boolean))],
    importance: material.importance || 'low',
    importanceReason: material.importanceReason || null,
    importanceFrom: material === lead ? null : material,
    direction: directed.direction || 'neutral',
    signalReason: directed.signalReason || null,
    directionFrom: directed === lead ? null : directed,
    day: lead.day || null,
    time: lead.time || null,
    latestDay: newest.day || null,
    latestTime: newest.time || null,
    statement: leadItem.kind === 'filing' ? leadItem.reading.claim : null,
    companyNames: names,
  };
}

const singles = new WeakMap();
const NO_OTHERS = Object.freeze([]);
/**
 * A row that folded with nothing is its own development — built once per row, and most of the rows
 * a ranking reads are this. What only a lead needs (the filing's chosen statement, the exchanges,
 * the publisher) is read on first use, so a card of a hundred filings does not choose a hundred
 * statements to print one.
 */
class Singleton {
  constructor(event, kind) {
    this.id = event.id;
    this.key = companyKeyOf(event);
    this.lead = event;
    this.members = [event];
    this.others = NO_OTHERS;
    this.kind = kind;
    this.label = kind ? KIND_LABEL[kind] : event.feedLabel || event.feed || 'Event';
    this.filings = kind === 'filing' ? 1 : 0;
    this.reports = kind === 'news' ? 1 : 0;
    this.posts = kind === 'post' ? 1 : 0;
    this.importance = event.importance || 'low';
    this.importanceReason = event.importanceReason || null;
    this.importanceFrom = null;
    this.direction = event.direction || 'neutral';
    this.signalReason = event.signalReason || null;
    this.directionFrom = null;
    this.day = event.day || null;
    this.time = event.time || null;
    this.latestDay = this.day;
    this.latestTime = this.time;
  }
  get venues() { return this.kind === 'filing' ? venuesOf(this.lead) : []; }
  get publishers() { return this.kind === 'news' ? [publisherOf(this.lead)].filter(Boolean) : []; }
  get statement() { return this.kind === 'filing' ? developmentReading(this.lead).claim : null; }
  get companyNames() { return [this.lead.company].filter((name) => name && !PLACEHOLDER_COMPANY.test(name)); }
}
function singletonOf(event) {
  const hit = singles.get(event);
  if (hit) return hit;
  const value = new Singleton(event, storyKindOf(event));
  singles.set(event, value);
  return value;
}

// A cluster that forms again on the next fold is the same development: the same object comes back,
// so everything keyed on it downstream (a table's row markup, a card's AI note) is reused.
const developments = new WeakMap();
function developmentFor(cluster) {
  const lead = leadOf(cluster.items).event;
  const hit = developments.get(lead);
  if (hit && hit.members.size === cluster.items.length && cluster.items.every((item) => hit.members.has(item.event)) &&
      hit.names === cluster.names.join('\u0001')) return hit.value;
  const value = developmentOf(cluster.items, cluster.names);
  developments.set(lead, { members: new Set(cluster.items.map((item) => item.event)), names: cluster.names.join('\u0001'), value });
  return value;
}

const folds = new WeakMap();

/**
 * Every development among `events`, in the order each one's first member appears in `events` —
 * so a score-ordered card keeps its strongest development first, and a newest-first stream its
 * newest. Memoised on the array; rows are replaced, never edited, so a new array is a new answer.
 *
 * `companyNames` names the company where the rows do not (a card's holding name); each row's own
 * company is always used too. Only company words are ever removed from what is matched.
 */
export function foldDevelopments(events = [], { companyNames = [] } = {}) {
  const extra = companyNames.filter(Boolean);
  const memoKey = extra.join('\u0001');
  const hit = folds.get(events);
  if (hit && hit.memoKey === memoKey) return hit.value;
  const clusterOfEvent = new Map();
  for (const cluster of runSteps(clusterSteps(events, extra))) {
    const dev = developmentFor(cluster);
    for (const item of cluster.items) clusterOfEvent.set(item.event, dev);
  }
  const value = [];
  const seen = new Set();
  for (const event of events) {
    const dev = clusterOfEvent.get(event) || singletonOf(event);
    if (seen.has(dev)) continue;
    seen.add(dev);
    value.push(dev);
  }
  folds.set(events, { memoKey, value });
  return value;
}

// The row a table shows for a development of more than one member: the lead's own record, with the
// development's readings. Kept per development object, so an unchanged development is the same row
// on the next paint and a table's markup cache for it survives.
const rowsByDevelopment = new WeakMap();
function foldedRow(dev) {
  const hit = rowsByDevelopment.get(dev);
  if (hit) return hit;
  const lead = dev.lead;
  const from = dev.importanceFrom;
  const row = {
    ...lead,
    development: dev,
    importance: dev.importance,
    importanceReason: from
      ? `${dev.importanceReason || 'High.'} (Read from a folded ${storyKindOf(from) === 'filing' ? 'exchange copy' : `report by ${publisherOf(from) || 'a publisher'}`}.)`
      : lead.importanceReason,
    direction: dev.direction,
    signalReason: dev.directionFrom ? `${dev.signalReason || ''} (Read from the ${venuesOf(dev.directionFrom).join('/') || 'exchange'} copy of this filing.)`.trim() : lead.signalReason,
  };
  rowsByDevelopment.set(dev, row);
  return row;
}

const rowFolds = new WeakMap();

function* foldRowSteps(events) {
  const clusters = yield* clusterSteps(events, []);
  if (!clusters.length) return events;
  const clusterOfEvent = new Map();
  for (const cluster of clusters) {
    const dev = developmentFor(cluster);
    for (const item of cluster.items) clusterOfEvent.set(item.event, dev);
  }
  yield;
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < events.length; i += 1) {
    if ((i & 4095) === 4095) yield;
    const event = events[i];
    const dev = clusterOfEvent.get(event);
    if (!dev) { rows.push(event); continue; }
    if (seen.has(dev)) continue;
    seen.add(dev);
    rows.push(foldedRow(dev));
  }
  return rows;
}

/**
 * The rows a stream shows: every event that folded with nothing, as itself, and one row per
 * development of more than one member, at the position of its first member. Memoised on the array,
 * and the sliced drive below fills the same memo, so either answers the other's question at once.
 * `developmentOfRow(row)` answers for any row this returned.
 */
export function foldAlertRows(events = []) {
  const hit = remembered(events);
  if (hit) return hit;
  const rows = runSteps(foldRowSteps(events));
  rowFolds.set(events, rows);
  lastFold = { events, rows };
  return rows;
}

/** Whether two arrays hold the same rows, the same objects in the same order. */
export const sameRowSequence = (a, b) => a === b || (a.length === b.length && a.every((row, i) => row === b[i]));

// A NEW ARRAY OF THE SAME ROWS IS THE SAME FOLD. A collection re-publishes its report as each
// source settles, and a view's rows are often the very same objects, in the same order, under a new
// array. The fold is a function of that sequence alone, so the newest completed fold answers it
// rather than a rebuild: measured on a company's complete history, a report re-published four times
// restarted one cold fold four times and held its rows back 6.3 seconds.
let lastFold = null; // { events, rows }: the newest completed fold
function remembered(events) {
  const hit = rowFolds.get(events);
  if (hit) return hit;
  if (!lastFold || !sameRowSequence(lastFold.events, events)) return null;
  rowFolds.set(events, lastFold.rows);
  return lastFold.rows;
}

/** Whether `foldAlertRows(events)` would answer from memory. */
export const foldedAlready = (events) => !!remembered(events);

/**
 * The same fold in ~12ms slices. Resolves to exactly what `foldAlertRows` returns for the same
 * array, or to undefined once `keepGoing()` says nobody is waiting — never to a partial fold.
 */
export async function foldAlertRowsInSlices(events = [], { yieldForInput, keepGoing = () => true, sliceMs } = {}) {
  const hit = remembered(events);
  if (hit) return hit;
  const rows = await runStepsInSlices(foldRowSteps(events), { yieldForInput, keepGoing, sliceMs });
  if (rows === undefined) return undefined;
  rowFolds.set(events, rows);
  lastFold = { events, rows };
  return rows;
}

/** The development a stream row stands for — its own, or a development of one. */
export const developmentOfRow = (row) => row?.development || (row ? singletonOf(row) : null);

// ---------------------------------------------------------------------------------------
// LINE 1 — WHAT HAPPENED, SHORT
// ---------------------------------------------------------------------------------------

const LEGAL_SUFFIX = /\s+(?:ltd\.?|limited|pvt\.?|private|inc\.?|corp\.?|corporation|plc|co\.?)$/i;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IN_NUMBER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/**
 * "Rs. 2600 Crore", "Rs 2,600-crore" and "₹2,600 cr" all print "₹2,600 Cr". Typography, not a
 * change of claim: the same amount in the same unit, grouped the Indian way.
 */
export function rupeeStyle(text) {
  return String(text || '').replace(/(?:₹\s?|\b(?:rs|inr)\.?\s?)(\d[\d,]*(?:\.\d+)?)(?:\s*-?\s*(crores?|cr\b\.?|lakhs?|lacs?))?/gi, (whole, digits, unit) => {
    const amount = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(amount)) return whole;
    const suffix = !unit ? '' : /^cr/i.test(unit) ? ' Cr' : ' lakh';
    return `₹${IN_NUMBER.format(amount)}${suffix}`;
  });
}

// "Biocon's", "Biocon’s" — and "Biocon s", where a feed lost the apostrophe — are the name too,
// and so are "Ltd" and "Limited" after it. The name itself is compared as text, not compiled into
// a pattern per company.
const AFTER_NAME = /^(?:\s+(?:ltd\.?|limited))?(?:\s?['’‘`´]?s(?=\s))?\s*[:,\-–—]?\s+/i;

/** The company's own name opening its own statement, on an item already headed with that name. */
function withoutLeadingCompany(text, names) {
  const value = String(text || '').trim();
  const lower = value.toLowerCase();
  const candidates = [...new Set(names.flatMap((name) => {
    const full = String(name || '').trim();
    return [full, full.replace(LEGAL_SUFFIX, '').trim()].filter((n) => n.length >= 3 && !PLACEHOLDER_COMPANY.test(n));
  }))].sort((a, b) => b.length - a.length);
  for (const name of candidates) {
    if (value.length <= name.length || !lower.startsWith(name.toLowerCase())) continue;
    const tail = value.slice(name.length);
    const match = AFTER_NAME.exec(tail);
    if (!match) continue;
    const rest = tail.slice(match[0].length);
    if (rest.split(/\s+/).length >= 2) return rest;
  }
  return value;
}

const openingCase = (text) => {
  const value = String(text || '');
  const first = value.match(/^([a-z])([^\s]*)/);
  if (!first || /[A-Z]/.test(first[2])) return value;
  return value[0].toUpperCase() + value.slice(1);
};

/**
 * LINE 1 of an item: the development in the fewest words that still say it.
 *
 * It is the lead's own statement — a filing's own title or the exchange's description of it, a
 * publisher's headline — with three typographic changes and no rewording: the company's own name
 * opening the line is dropped (the item is headed with it), a trailing masthead (" - The Economic
 * Times") is dropped, and rupee amounts print the Indian way ("₹2,600 Cr"). The untouched wording
 * stays one hover away on every surface that prints this. A measurement lead keeps the line its
 * surface already writes for it, passed in as `fallback`.
 */
// The company's own boilerplate opening a subject — "Intimation of launch of phase 6…" says
// "launch of phase 6…" — dropped exactly as the exchange's "has informed the Exchange about" is.
const INTIMATION = /^intimation\s+(?:of|regarding|about|for|in respect of)\s+/i;

/**
 * LINE 1 FOR A FILING IS ITS SHORTEST OWN STATEMENT THAT STILL SAYS WHAT HAPPENED. The customer's
 * ask is a very short line ("₹2,600 Cr redevelopment project"), while `filingStatement` chooses the
 * RICHEST of the exchange's texts, which is right for matching and long for reading — NSE's
 * description of a phase launch runs on to name the subsidiary that launched it. So the rich
 * statement gives way to another of the lead's own statements (its title, its subject, the
 * exchange's description — in that order of preference) only where that one is at least a third
 * shorter as printed, names at least four things, keeps at least half of what the rich one names,
 * and carries every rupee amount any of them states. A category line ("Giving guarantees/indemnity")
 * keeps too little of the rich one and never replaces it. Selection, not rewording.
 */
function shortStatement(dev) {
  const lead = dev.lead;
  const rich = dev.statement || filingStatement(lead);
  const names = [lead.company, ...(dev.companyNames || [])];
  const printed = (text) => withoutLeadingCompany(text, names).length;
  const candidates = [...new Set([
    lead.filingHeadline ? filingClaim({ ...lead, filingSubject: lead.filingHeadline, filingDescription: null }) : null,
    filingClaim(lead), sourceStatement(lead.filingDescription),
  ].filter((text) => text && !isTypeOnly(text)).map((text) => text.replace(INTIMATION, '')))];
  const richTokens = lineTokens(rich);
  const richNames = new Set([...richTokens.words, ...richTokens.figures]);
  const amounts = new Set([rich, ...candidates].flatMap((text) => [...moneyOf(text)]));
  const limit = printed(rich) * 0.7;
  for (const text of candidates) {
    if (text === rich || printed(text) > limit) continue;
    const tokens = lineTokens(text);
    const named = [...tokens.words, ...tokens.figures];
    if (named.length < 4 || ![...amounts].every((amount) => tokens.money.has(amount))) continue;
    if (named.filter((token) => richNames.has(token)).length * 2 < richNames.size) continue;
    return text;
  }
  return rich.replace(INTIMATION, '');
}

export function developmentLine(dev, { fallback = null, names = [], keepCompany = false } = {}) {
  if (!dev?.lead) return '';
  if (!dev.kind) return clip(fallback || dev.lead.headline || '');
  const source = dev.kind === 'filing' ? shortStatement(dev) : withoutMasthead(String(dev.lead.headline || ''), publisherOf(dev.lead));
  // A table that prints the company in its own column still shows the statement whole.
  const own = keepCompany ? source : withoutLeadingCompany(source, [...names, ...(dev.companyNames || []), dev.lead.company]);
  return clip(openingCase(rupeeStyle(own)), CLAIM_MAX);
}

/** "BSE · NSE", "Business Standard", or the feed's own label — where the lead came from. */
export function developmentSource(dev) {
  if (!dev?.lead) return '';
  if (dev.kind === 'filing') return dev.venues.length ? dev.venues.join(' · ') : dev.lead.feedLabel || 'Exchange filing';
  if (dev.kind === 'news' || dev.kind === 'post') return publisherOf(dev.lead) || dev.lead.feedLabel || '';
  return dev.lead.feedLabel || dev.lead.feed || '';
}

/** "2 exchange copies · 30 news reports" — what the fold holds, said without opening it. */
export function foldedSummary(dev) {
  if (!dev) return '';
  const parts = [];
  const copies = dev.filings - (dev.kind === 'filing' ? 1 : 0);
  if (copies > 0) parts.push(`${copies} exchange ${copies === 1 ? 'copy' : 'copies'}`);
  const reports = dev.reports - (dev.kind === 'news' ? 1 : 0);
  if (reports > 0) parts.push(`${reports} news ${reports === 1 ? 'report' : 'reports'}`);
  const posts = dev.posts - (dev.kind === 'post' ? 1 : 0);
  if (posts > 0) parts.push(`${posts} ${posts === 1 ? 'post' : 'posts'}`);
  return parts.join(' · ');
}

/** Every folded member, one line each, for a tooltip or an export cell. */
export function foldedList(dev, { limit = 60, withLinks = false } = {}) {
  if (!dev) return '';
  const lines = dev.others.slice(0, limit).map((event) => {
    const kind = storyKindOf(event);
    const who = kind === 'filing' ? venuesOf(event).join('/') || 'Exchange' : publisherOf(event) || event.feedLabel || '';
    const when = event.day ? ` · ${event.day}${event.time ? ` ${event.time}` : ''}` : '';
    return `${who}${when} — ${event.headline || ''}${withLinks && event.url ? ` — ${event.url}` : ''}`;
  });
  if (dev.others.length > limit) lines.push(`…and ${dev.others.length - limit} more`);
  return lines.join('\n');
}

/** Search text for everything the development holds, so a word in any member still finds it. */
export function developmentSearchText(dev) {
  if (!dev?.others?.length) return '';
  return dev.others.map((event) => `${event.headline || ''} ${event.detail || ''} ${publisherOf(event) || ''}`).join(' ');
}
