// data/ai-alerts.js — THE EXPLAINABLE PRIORITY LAYER OVER GENERAL ALERTS.
//
// This module adds no source and makes no factual claim that is not already carried by a General
// Alerts event. Its job is narrower: group recent company events, suppress repeated single-feed
// noise, and rank what deserves a human's attention first.
//
// THE SCORE IS NOT AN LLM OPINION. The upstream data is already structured — direction,
// importance, source, date and company — so a deterministic model is faster, testable and cannot
// hallucinate a filing. Every point is returned in `scoreBreakdown` for deterministic verification;
// the card keeps the arithmetic hidden and shows the evidence and next action instead.
//
// PORTFOLIO HONESTY: `coverage.js` is the real 142-company book used by the Research scope. The
// public coverage snapshot contains identities, not position sizes. Only a validated snapshot
// from the authenticated Family parent can order cards by holding size. Size changes ordering
// within the selected filter; the materiality threshold and alert priority remain evidence-based.

import { storyGrouping } from './alert-stories.js';
import { STORY_FEEDS, storyRecord, storyKey, isMaterialStoryUpdate, compareStoryRecency } from './alert-stories-shared.js';
import * as generalAlerts from './daily-alerts.js';
import { newsCanSupportAI, isRelatedNewsContext } from './company-news-attribution.js';
import * as kpiImpact from './kpi-impact.js';
import { defaultCompanyNewsEntityId, portfolioNewsEntities } from './company-news-identity.js';
import * as coverage from './coverage.js';
import * as screenerInsights from './screener-insights.js';
import { enrichCardFromAllAlerts, indexAlertContext } from './intelligence-graph.js';
import { canonicalArticleUrl } from './filings-shared.js';
import { getHostContext } from '../core/host-context.js';
import { AI_ALERT_WINDOW_DAYS as WINDOW_DAYS } from '../core/alert-window.js';
import { runSteps, runStepsInSlices } from '../core/slices.js';
export { AI_ALERT_WINDOW_DAYS as WINDOW_DAYS } from '../core/alert-window.js';

export const MIN_SCORE = 64;
export const MUST_SEE_SCORE = 82;
export const onChange = fn => { const a = generalAlerts.onChange(fn), b = storyGrouping.onChange(fn); return () => { a(); b(); }; };
export const storyStatus = report => storyGrouping.status(report?.allCards?.flatMap(card => card.sourceEvents || card.events) || []);
// Keep ranking inputs in memory only; private position sizes must never enter a saved report.
const rankingOptions = new WeakMap();
const rankingEvidence = new WeakMap();

const FEED_WEIGHT = {
  earnings: 12,
  announcements: 10,
  'nse-filings': 10,
  insider: 9,
  investors: 8,
  concalls: 8,
  technicals: 6,
  chatter: 4,
  // COMPANY NEWS IS DELIBERATELY THE LIGHTEST FEED THAT COUNTS AT ALL. It was zero, because before
  // the tracked keywords every story on it was neutral and low-importance and there was nothing to
  // separate a fraud investigation from a namesake's film release. The keyword rule supplies that
  // separation, so news can carry weight — and it is kept small on purpose. Do the arithmetic: a
  // keyword-matched story on a book company, published today, scores 30 (high importance) + 6 +
  // 16 (today) + 12 (in the book) = 64, which is exactly MIN_SCORE. Recency controls ordering;
  // material portfolio disclosures remain visible for the whole 14-day review window.
  news: 6,
  'market-news': 6,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
// A ranking asks these of every event, and a Universe ranking asks them of ~43,000 events on every
// partial publication. The distinct inputs are a few hundred day strings and the headlines, so
// each answer is kept per string in a bounded map; the day maps are cleared when they outgrow it.
const dayCache = (compute) => {
  const cache = new Map();
  return (day) => {
    let value = cache.get(day);
    if (value === undefined) {
      value = compute(day);
      if (cache.size >= 4096) cache.clear();
      cache.set(day, value);
    }
    return value;
  };
};
const validDay = dayCache((day) => /^\d{4}-\d{2}-\d{2}$/.test(day || '') &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
const dayStart = dayCache((day) => Date.parse(`${day}T00:00:00Z`));

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function ageInDays(eventDay, throughDay) {
  const event = dayStart(eventDay);
  const through = dayStart(throughDay);
  if (!Number.isFinite(event) || !Number.isFinite(through)) return WINDOW_DAYS;
  return Math.max(0, Math.round((through - event) / 86_400_000));
}

function recencyPoints(age) {
  if (age === 0) return 16;
  if (age === 1) return 10;
  if (age <= 3) return 6;
  return 2;
}

const normalizedHeadline = dayCache((value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .slice(0, 140));

const feedFamily = (event) => event.feed === 'nse-filings' ? 'announcements' : event.feed === 'market-news' ? 'news' : event.feed;

/** Syndicated links and duplicate exchange disclosures are not independent corroboration. */
function dedupe(events) {
  const seen = new Set();
  events = storyGrouping.project(events);
  // Prefer the useful copy when one exchange supplied a generic label and the other a full
  // subject. Stable ordering also stops equivalent source arrival order changing read state.
  return [...events].sort((a, b) => Number(b.importance === 'high') - Number(a.importance === 'high') ||
    String(a.feed).localeCompare(String(b.feed)) || String(a.id).localeCompare(String(b.id))).filter((event) => {
    if (STORY_FEEDS.has(event.feed)) return true;
    const family = feedFamily(event);
    const key = `${family}:${event.day}:${normalizedHeadline(event.headline) || event.id}`;
    const link = event.url && ['announcements', 'news'].includes(family) ? `${family}:url:${canonicalArticleUrl(event.url)}` : null;
    if (seen.has(key) || (link && seen.has(link))) return false;
    seen.add(key); if (link) seen.add(link);
    return true;
  });
}

// Stable content identities for read/dismiss state. A new material item must resurface a company
// even when an older, higher-scoring item remains on top. Routine observations do not wake it.
export function materialEvidence(events = []) {
  const material = events.filter((event) => event.importance === 'high' || isMaterialStoryUpdate(event));
  const identity = event => {
    const record = storyRecord(event);
    return record ? JSON.stringify(['story-source', storyKey(record)])
      : JSON.stringify([feedFamily(event), event.id || null, event.day, event.headline, event.direction, event.importance]);
  };
  return [...new Set((material.length ? material : events).map(event => event.developmentId
    ? JSON.stringify(['story-development', event.developmentId, event.direction, event.importance,
      (event.storyReports || [event]).map(identity).sort()]) : identity(event.storyReports?.[0] || event)))].sort();
}

function eventScore(event, day, feedState) {
  const age = ageInDays(event.day, day);
  const parts = [
    { label: event.importance === 'high' ? 'High-importance event' : 'Low-importance event', points: event.importance === 'high' ? 30 : 4 },
    { label: `${event.feedLabel || event.feed} source weight`, points: FEED_WEIGHT[event.feed] || 0 },
    { label: age === 0 ? 'Occurred today' : age === 1 ? 'Occurred yesterday' : `Occurred ${age} days ago`, points: recencyPoints(age) },
  ];
  if (event.direction === 'negative') parts.push({ label: 'Negative risk signal', points: 10 });
  else if (event.direction === 'positive') parts.push({ label: 'Positive directional signal', points: 6 });

  const unavailable = !feedState || feedState.status !== 'ok' || feedState.reachesToday === false;
  if (unavailable) parts.push({ label: 'Source is stale, incomplete or unread', points: -10 });
  return { points: parts.reduce((sum, part) => sum + part.points, 0), parts, unavailable };
}

// ---------------------------------------------------------------------------------------
// CONFLUENCE — THE NAMED CROSS-FEED PATTERNS
//
// This is the layer that answers "there's a volume breakout AND this superstar investor has bought
// it". Everything else in this file ranks a company by its strongest single event and then adds a
// flat bonus for having several feeds; that bonus is real but it is anonymous — it says *three
// feeds* and never says *which three, or what their combination means*. A reader cannot act on an
// arity.
//
// So a small, fixed set of patterns is checked by name. Each one states which feeds have to agree,
// carries its own points, and writes a sentence out of the ACTUAL matched events rather than a
// template with the company's name dropped in. `confluenceOf()` is pure and exported for exactly
// the reason `moveSeverity` is: a pattern that needs a marquee investor and a volume spike on the
// same company inside 14 days will not appear in most days' captures, so waiting for one to
// occur is not a test.
//
// FOUR RULES THIS LAYER OBEYS, AND THEY ARE THE SAME ONES THE REST OF THE FILE DOES:
//
// 1. IT ADDS NO FACT. Every clause in every sentence is quoted from an event that is already on the
//    card and already links to its own source. If a pattern cannot describe itself out of the
//    evidence it matched, it does not fire.
// 2. CO-OCCURRENCE IS NOT CAUSATION, AND THE WORDING MUST NOT SMUGGLE IT IN. Two things happening
//    to one company inside the review window is what has been measured, and that is all the sentence may say.
//    A volume spike on the day a fund's book was published does not mean the fund did the buying —
//    a filed shareholding is a QUARTERLY disclosure and the trade behind it may be months old, so
//    the accumulation pattern says "and a tracked investor's latest book shows", never "bought
//    today". Getting that wrong would be the `deriveMoves` error — inventing a trade date — one
//    layer up.
// 3. AN ABSENCE IS A FINDING, BUT ONLY WHERE IT CAN BE MEASURED. `unexplained-move` fires when a
//    big move has no news, filing or result beside it, which is genuinely the most useful thing
//    this layer says — and it is allowed to say it ONLY because the feeds it would have to have
//    seen are all present and current for this company. Where any of them is stale or unread the
//    pattern is withheld, because "nothing explains it" and "we did not look" are the two answers
//    this whole dashboard exists to keep apart.
// 4. THE POINTS ARE CAPPED. Correlation is meant to reorder the list, not to manufacture urgency:
//    `CONFLUENCE_MAX` bounds the whole layer's contribution however many patterns fire.

/** The most a card can gain from every confluence pattern put together. */
export const CONFLUENCE_MAX = 18;

const has = (events, fn) => events.find(fn) || null;
const feedOf = (events, id) => events.filter((e) => e.feed === id);

const participation = (e) => e.feed === 'technicals' && (e.kind === 'volume' || e.kind === 'breakout');
const priceMove = (e) => e.feed === 'technicals' && e.kind === 'move';
const anyTechnical = (e) => e.feed === 'technicals';

// THE BUYING AND SELLING LEGS ASK FOR A *MATERIAL* MOVE, AND THE THRESHOLD IS ALREADY PUBLISHED.
//
// Every feed here states its own materiality on the tab and in the source registry — an investor
// change is high at INVESTOR_HIGH_PP (1 percentage point) or on an appearance or disappearance, an
// insider trade at INSIDER_HIGH_PCT or INSIDER_HIGH_VALUE — and `importance` is the answer that
// carries. Reading direction alone made every one of those thresholds a dead letter here: measured
// on the shipped capture, four of the eight surfaced cards led with "Life Insurance Corporation
// reduced by 0.62–0.81pp", a holder that appears in nearly every book moving less than the feed's
// own bar for mattering. Nothing was wrong with the reading and the correlation was still noise.
//
// So the predicate defers to the stated threshold rather than inventing a second one beside it —
// two predicates over one question is what this codebase keeps having to un-write.
const investorAdd = (e) => e.feed === 'investors' && e.direction === 'positive' && e.importance === 'high';
const investorCut = (e) => e.feed === 'investors' && e.direction === 'negative' && e.importance === 'high';
const insiderBuy = (e) => e.feed === 'insider' && e.direction === 'positive' && e.importance === 'high';
const insiderSell = (e) => e.feed === 'insider' && e.direction === 'negative' && e.importance === 'high';
const trackedNews = (e) => feedFamily(e) === 'news' && (e.keywords || []).length > 0;
const materialFiling = (e) => feedFamily(e) === 'announcements' && e.importance === 'high';
const resultEvent = (e) => e.feed === 'earnings' || e.feed === 'concalls';

/**
 * The tracked keywords on a card's news AND announcement rows, deduplicated, for a sentence that
 * names them. Both feeds classify against the same thirty-word vocabulary, so a filing's topic is
 * as nameable as a story's — and on the announcements feed it is the company's own statement of it.
 */
const newsTopics = (events) =>
  [...new Set(events.flatMap((e) => (feedFamily(e) === 'news' || feedFamily(e) === 'announcements' ? e.keywords || [] : [])))];

/**
 * The patterns, in the order they are reported. `detect` returns the sentence it matched on, or
 * null — the sentence is built from the events themselves, so a pattern that fires can always be
 * traced back to rows the reader can open.
 *
 * `label` DESCRIBES the pattern and `short` TAGS it, and they are two names for a reason. The card
 * leads with the pattern as a plain sentence, so a chip repeating "Volume with selling behind it"
 * under "Heavy trading, and a big holder has been selling" is the same duplication this card was
 * redesigned to remove — one word ("Selling") is a category the eye can index instead.
 */
const CONFLUENCE = [
  {
    id: 'accumulation',
    label: 'Volume with a buyer behind it',
    short: 'Buying',
    points: 10,
    detect: (events) => {
      const tape = has(events, participation) || has(events, (e) => priceMove(e) && e.direction === 'positive');
      const buyer = has(events, investorAdd) || has(events, insiderBuy);
      if (!tape || !buyer) return null;
      const who = buyer.feed === 'investors' ? "a tracked investor's latest book" : 'an insider disclosure';
      return `${tape.headline}, and ${who} shows buying — ${buyer.headline}.`;
    },
  },
  {
    id: 'distribution',
    label: 'Volume with selling behind it',
    short: 'Selling',
    points: 10,
    detect: (events) => {
      const tape = has(events, participation) || has(events, (e) => priceMove(e) && e.direction === 'negative');
      const seller = has(events, investorCut) || has(events, insiderSell);
      if (!tape || !seller) return null;
      const who = seller.feed === 'investors' ? "a tracked investor's latest book" : 'an insider disclosure';
      return `${tape.headline}, and ${who} shows selling — ${seller.headline}.`;
    },
  },
  {
    id: 'insider-and-investor',
    label: 'Insider and institution agree',
    short: 'Insider + fund',
    points: 8,
    detect: (events) => {
      const insider = has(events, insiderBuy) || has(events, insiderSell);
      const institution = has(events, investorAdd) || has(events, investorCut);
      if (!insider || !institution) return null;
      const sameWay =
        (insider.direction === 'positive' && institution.direction === 'positive') ||
        (insider.direction === 'negative' && institution.direction === 'negative');
      if (!sameWay) return null;
      return `An insider and a tracked investor moved the same way: ${insider.headline}, and ${institution.headline}.`;
    },
  },
  {
    id: 'news-behind-the-move',
    label: 'The move has a story behind it',
    short: 'News behind it',
    points: 8,
    detect: (events) => {
      const tape = has(events, anyTechnical);
      const story = has(events, trackedNews) || has(events, materialFiling);
      if (!tape || !story) return null;
      const topics = newsTopics(events);
      const why = topics.length ? ` (${topics.join(', ')})` : '';
      return `${tape.headline}, alongside ${feedFamily(story) === 'news' ? 'a tracked story' : 'a material filing'}${why}: ${story.headline}.`;
    },
  },
  {
    id: 'results-reaction',
    label: 'A result and a reaction',
    short: 'Result + move',
    points: 8,
    detect: (events) => {
      const result = has(events, resultEvent);
      const tape = has(events, anyTechnical);
      if (!result || !tape) return null;
      return `${result.headline}, and the tape responded — ${tape.headline}.`;
    },
  },
  {
    id: 'risk-cluster',
    label: 'Risk showing up in more than one place',
    short: 'Risk cluster',
    points: 10,
    detect: (events) => {
      const bad = events.filter((e) => e.direction === 'negative' && e.importance === 'high');
      const feeds = [...new Set(bad.map(feedFamily))];
      if (feeds.length < 2) return null;
      return `High-importance negative readings on ${feeds.length} independent feeds: ${bad
        .slice(0, 2)
        .map((e) => e.headline)
        .join('; ')}.`;
    },
  },
  {
    id: 'unexplained-move',
    label: 'A move nothing else explains',
    short: 'No explanation',
    points: 6,
    // See rule 3 in the header: this is the one pattern that reports an ABSENCE, so it may only
    // speak when the feeds whose silence it is reporting were actually read and reach the day.
    detect: (events, { silentFeedsReadable }) => {
      if (!silentFeedsReadable) return null;
      const tape = has(events, (e) => anyTechnical(e) && e.importance === 'high');
      if (!tape) return null;
      const explains = events.some((e) => trackedNews(e) || materialFiling(e) || resultEvent(e));
      if (explains) return null;
      return `${tape.headline}, with no tracked story, material filing or result beside it in the last ${WINDOW_DAYS} days.`;
    },
  },
];

/**
 * Every named pattern this company's recent events satisfy, strongest first.
 *
 * Pure and exported: a marquee investor and a volume spike landing on one company inside the review window is
 * exactly the case a fixture has to supply, because most days' captures do not contain one.
 */
export function confluenceOf(events, { feedById = new Map() } = {}) {
  // The absence pattern needs to know that the feeds it would be reporting silence from were
  // actually read. A feed absent from the report at all counts as unreadable, not as quiet.
  const silentFeedsReadable = ['news', 'announcements', 'earnings'].every((id) => {
    const feed = feedById.get(id);
    return !!feed && feed.status === 'ok' && feed.reachesToday !== false;
  });
  const ctx = { silentFeedsReadable };
  const found = [];
  for (const pattern of CONFLUENCE) {
    const detail = pattern.detect(events, ctx);
    if (detail) found.push({ id: pattern.id, label: pattern.label, short: pattern.short, points: pattern.points, detail });
  }
  return found.sort((a, b) => b.points - a.points);
}

// ---------------------------------------------------------------------------------------
// THE READING LAYER — WHAT HAPPENED, IN THE FEWEST WORDS THAT STILL SAY IT
//
// Everything above decides WHAT to surface. This decides how fast a human can take it in, and it
// is a separate concern with its own failure mode: a card can be perfectly honest and still take
// twenty seconds to read, at which point a page whose whole promise is "here is what needs you
// this morning" has failed at the only thing it does.
//
// THE MEASURED PROBLEM, TWICE OVER.
//
// First it was repetition: the card printed a pattern's full sentence as its insight AND again
// inside a "Signals lining up" block, in the feeds' own technical wording. That block went.
//
// Then the sentence itself was the problem, and it was worse, because it was a card that looked
// finished. It led with the PATTERN and appended the two figures behind it, so what a reader got
// was the SHAPE of the evidence and never the event: "Heavy trading, and a big holder has been
// buying — 2.0x its normal volume, Vanguard Fund up 1.01pp", over a company whose own filing that
// morning was a 10-year supply contract. Three separate faults, all in one sentence:
//
//   * The pattern name was already a chip directly beneath it ("Buying", "News behind it"), so
//     the sentence spent its whole length restating a label the eye had already indexed — the
//     same duplication the block above was deleted for, arrived at from the other side.
//   * The figures came from `technicals` and `investors` ONLY, because those were the two feeds a
//     phrase had been written for. A filing, a result and a story could never appear in it at all.
//     Measured on the shipped capture: the card for a company whose strongest event was
//     "Biocon Secures 10-Year Supply Contract for Pertuzumab in Brazil" said "An insider and a big
//     holder moved the same way", and the contract appeared nowhere in the sentence.
//   * With no pattern it fell back to our own tally — "Sources disagree — 8 good, 6 bad" — or to
//     filler: "That is the strongest recent risk here." Neither is a thing that happened.
//
// So the sentence is now ONE CLAIM: what the strongest event on the card actually says, in the
// source's own words where the words are theirs. The chip below it carries the correlation, the
// rows below that carry the breadth, and nothing is said twice. FOUR RULES, every one of them a
// rule this file already ran on:
//
// 1. NO NEW FACT, AND NO NEW NUMBER. Every figure is read from a field a collector wrote —
//    `volumeX`, `movePct`, `deltaPp`, `tradeValue`, `tradePct`, `tradeShares`, `netProfit.pct` —
//    never parsed back out of a sentence. Where the field is absent the phrase is absent; nothing
//    is defaulted and nothing is derived twice.
// 2. IT ONLY REWRITES WHAT WE WROTE. A publisher's headline, a filing's subject and the
//    exchange's own description of a filing are somebody else's words and travel verbatim. Our own
//    composed lines — "Volume 2.0x its 20-day average at the <date> close", "ACTIV PINE LLP —
//    Sell", "YOY quarterly result filed" — are ours to shorten and to complete.
// 3. SELECTING IS NOT EDITING, AND CLIPPING SAYS SO. Where NSE's description quotes the company's
//    own title for a filing, that quotation IS the claim — chosen, not reworded. A statement too
//    long for one line is cut on a word boundary with an ellipsis and the untouched text stays in
//    the row's own tooltip. Neither is a paraphrase, which is the one thing not on offer here.
// 4. PLAIN IS NOT VAGUE. Shortening the register must never cost the reader a specific: the
//    investor's name, the size of the trade and the basis of a growth figure all stay.

/**
 * The short label the evidence rows tag a feed with — long enough to be a word, short enough to
 * skim. IT NAMES THE SOURCE FAMILY, NOT THE FEED ID: the same grouping `feedFamily` uses.
 *
 * `market-news` has always shared NEWS with `news` for exactly this reason, and `nse-filings`
 * belongs with `announcements` the same way: an exchange filing reaching us through NSE and its
 * twin through BSE are one source, which is why they are one family for corroboration. Left to
 * fall through to its own label it printed NSE FILINGS beside FILING, so a card whose header
 * counted two independent sources showed three different words for them — two numbers disagreeing
 * on one screen, with the reader left to guess which is right. The venue is not lost: the row's
 * title carries the feed's own label and its time, and the row opens that feed's own tab.
 */
export const FEED_TAG = {
  earnings: 'RESULT',
  concalls: 'CALL',
  'screener-insights': 'INSIGHT',
  announcements: 'FILING',
  'nse-filings': 'FILING',
  insider: 'INSIDER',
  investors: 'FUND',
  technicals: 'TAPE',
  chatter: 'CHATTER',
  news: 'NEWS',
  'market-news': 'NEWS',
};

/** The longest claim a card's sentence or a row carries before it is clipped on a word boundary. */
export const CLAIM_MAX = 150;
const CRORE = 10_000_000;

/** A claim too long for the line, cut where a word ends. The untouched text stays in the tooltip. */
function clip(text, max = CLAIM_MAX) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/**
 * A filing subject that names the filing TYPE rather than the event.
 *
 * This is the whole reason a card could announce "Press Release" over a ten-year supply contract.
 * Measured on the retained NSE window: 1,995 of 15,506 rows carry one of these as their subject —
 * 1,025 "General Updates", 707 "Updates", 251 "Press Release" — and 1,911 of those 1,995 carry a
 * description that says what the filing actually is. BSE's side of it is the pointer subjects:
 * "PFA", "Please refer the enclosed file.", "As per attachment".
 *
 * It is deliberately an EXACT-MATCH list of type words, not a length or a keyword heuristic.
 * "Investor Presentation", "Record Date" and "Resignation of Director/KMP/SMP" are short and are
 * real answers; the test is whether the subject names an event, and a pattern loose enough to
 * catch a bad subject by its shape would discard those too.
 */
const TYPE_ONLY_SUBJECT = new RegExp(
  '^(?:'
  + 'updates?|general\\s+updates?|company\\s+updates?|press\\s+releases?|announcements?|'
  + 'corporate\\s+announcements?|disclosures?|disclosure\\s+attached|intimations?|intimation\\s+of\\s+disclosure|'
  + 'others?|news|filing|nse\\s+filing|pfa|na|n\\.?a\\.?|nil|none|attached|enclosed|media\\s+releases?|'
  // THE POINTER PHRASES ARE BOUNDED TO POINTER WORDS, not left open with `.*`. Written greedily
  // they swallowed a subject that says something: "Please find enclosed herewith the disclosure
  // pertaining to incorporation of two Wholly-Owned Subsidiaries" is the whole event, and the card
  // replaced it with BSE's one-word sub-category, "Acquisition". A pointer subject is a pointer
  // and nothing else, so every word after "please find" has to be one of these to qualify.
  + '(?:please|kindly)\\s+(?:refer|find|see)'
  + '(?:\\s+(?:to|the|our|enclosed|attached|attachment|enclosure|annexure|file|document|herewith|below|copy))*|'
  + 'as\\s+per\\s+(?:the\\s+)?attachments?|refer\\s+(?:the\\s+)?attach\\w*|-{1,2}|\\.'
  + ')[\\s.]*$',
  'i'
);

/**
 * EVERY SEGMENT HAS TO BE A TYPE WORD, because the exchanges publish these as alternatives.
 * "Press Release / Media Release" is BSE's sub-category for a press release and says no more than
 * either half of it does, and an exact-match list of single words let it through — one card led
 * with it while the filing beneath said what the release was. A subject with one real segment
 * ("Record Date / Book Closure") still names an event and is kept.
 */
const isTypeOnly = (text) => {
  const value = String(text || '').trim();
  if (!value) return true;
  return value.split(/\s*[/|]\s*/).filter(Boolean).every((part) => TYPE_ONLY_SUBJECT.test(part));
};

/**
 * A clause the prefix strip exposed, opened as a sentence.
 *
 * "…has informed the exchange about the approval of Board of Directors for withdrawal of
 * application of reclassification" is one sentence whose subject is the company, so removing that
 * subject leaves the rest starting "the" — a line that reads as a rendering bug. Capitalising a
 * letter is typography and not a change of claim.
 *
 * IT LEAVES A WORD THAT CAPITALISES ITSELF ALONE. The test is that the first word has no capital
 * of its own, so "the approval…" opens and "iPhone launch" or "eSIM rollout" are untouched — a
 * brand recapitalised would be this dashboard editing somebody's name, which the clip and the
 * prefix strip both exist to avoid.
 */
const openingCase = (text) => {
  const value = String(text || '');
  const first = value.match(/^([a-z])([^\s]*)/);
  if (!first || /[A-Z]/.test(first[2])) return value;
  return value[0].toUpperCase() + value.slice(1);
};

const unquote = (text) => {
  const value = String(text || '').trim().replace(/[.\s]+$/, '').trim();
  const wrapped = value.match(/^["'‘“]([\s\S]+)["'’”]$/);
  return (wrapped ? wrapped[1] : value).trim();
};

/**
 * What a filing says, in the source's own words.
 *
 * Two mechanical removals and one selection, and none of them is a paraphrase:
 *
 *  * `|SUBJECT: …` is the feed's own duplicate of the subject, appended to every NSE description.
 *  * `<Company> has informed the Exchange about/regarding` is an exchange-generated lead-in —
 *    9,622 of 15,506 retained rows carry it — and what follows it is the filing's own text.
 *  * Where they quote the company's own title for the filing ("…titled \"X\""), that quotation is
 *    the claim. Choosing which of their sentences to print is not writing one.
 */
export function sourceStatement(text) {
  const raw = String(text || '').replace(/\s*\|\s*SUBJECT\s*:[\s\S]*$/i, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const titled = raw.match(/\btitled\s*["'‘“]([^"'’”]{12,})["'’”]/i);
  if (titled) return titled[1].trim();
  const body = raw
    .replace(/^.{0,90}?\bhas\s+informed\s+the\s+Exchanges?\b[\s,]*(?:about|regarding|that)?\s*/i, '')
    // BSE's own lead-in on a disclosure it received, the mirror of the one above.
    .replace(/^the\s+Exchanges?\s+(?:has|have)\s+received\s*/i, '')
    .trim();
  return openingCase(unquote(body || raw));
}

/**
 * A filing's claim: its own subject where that names an event, the source's own description where
 * the subject only names a type, and the exchange's own sub-category as the floor.
 *
 * The order is what makes it honest. A subject that says something is never replaced — it is the
 * shortest true answer and it is theirs. A description is used only where it says something the
 * subject does not, because NSE repeats the subject as the description on some rows and sends
 * `''.` on others, and "General Updates: General Updates" is not an improvement on either.
 */
export function filingClaim(event) {
  const subject = String(event?.filingSubject || event?.headline || '').trim();
  // THE SAME MECHANICAL LEAD-IN TURNS UP IN SUBJECTS, and there it costs the reader the answer.
  // BSE carries no description, so the whole statement arrives as the subject: "Star Health and
  // Allied Insurance Company Limited has informed the exchange about the approval of Board of
  // Directors for withdrawal of application of…" spent 71 of 150 characters on a company name the
  // card prints as its own heading, and clipped away the withdrawal. Removing a prefix the
  // exchange generated is the same removal `sourceStatement` justifies, not a rewording of what
  // follows it — and where the subject carries none, it comes back unchanged.
  if (!isTypeOnly(subject)) return clip(sourceStatement(subject) || subject);
  const stated = sourceStatement(event?.filingDescription);
  if (stated.length >= 12 && stated.toLowerCase() !== subject.toLowerCase()) return clip(stated);
  // BSE's own sub-category is their answer to "what kind of filing is this?" — "Award of Order /
  // Receipt of Order", "Resignation of Director", "Credit Rating" — so it is a real claim where
  // the subject was not. NSE publishes none, which is why this is a floor and not the first look.
  return clip(event?.filingSubCategory || subject || 'Filing');
}

/**
 * The measurable size of an insider or block-deal disclosure, from the fields the collector wrote.
 *
 * Value first because it is the figure the desk's own threshold is stated in (₹10 crore), then the
 * percentage of the company (1%), then the share count, which is a real number that says nothing
 * about size on its own. A disclosure that carried none of the three gets no phrase — never a zero.
 */
function insiderSize(event) {
  if (Number.isFinite(event.tradeValue) && Math.abs(event.tradeValue) >= CRORE) {
    return `₹${(Math.abs(event.tradeValue) / CRORE).toFixed(1)} crore`;
  }
  if (Number.isFinite(event.tradePct)) return `${Math.abs(event.tradePct).toFixed(2)}% of the company`;
  if (Number.isFinite(event.tradeShares)) return `${Math.abs(event.tradeShares).toLocaleString('en-IN')} shares`;
  if (Number.isFinite(event.tradeValue)) return `₹${Math.abs(event.tradeValue).toLocaleString('en-IN')}`;
  return null;
}

/**
 * The filed figures behind a result, worded for a sentence rather than a table cell.
 *
 * `metricText` in `daily-alerts.js` is the table's rendering of the SAME fields and the same
 * `kind` — one classifier, so the two cannot disagree about a number or about whether a period
 * crossed zero. What differs is only the words a sign change takes: "Net Profit to profit" reads
 * as a column heading and a stray word, and this is the whole of a card's sentence.
 *
 * A comparison the source did not carry contributes nothing, exactly as `metricText` refuses to
 * turn one into a percentage — see *A percentage across a sign change is not a growth rate*.
 */
function resultFigures(event) {
  // THE EVENT'S OWN `metrics` FIELD FIRST. The AI pool drops `sourceRecord`, so reading the figures
  // only off the record stated them on a card ranked from the full history and silently dropped
  // them from the same card ranked from the pool — a difference the pool's card-for-card check
  // would report the first week a company in the window filed a result. The record remains the
  // reading for an event saved before the field existed; both carry the source's own label, change
  // and kind, so the two cannot disagree.
  const row = event.metrics || event.sourceRecord || {};
  const out = [];
  for (const metric of [row.netProfit, row.revenue]) {
    if (!metric) continue;
    const label = String(metric.label || '').toLowerCase() || 'figure';
    // `Number(null)` IS 0 AND 0 IS FINITE, so a comparison the source did not carry arrived as
    // "net profit −0.0%" — a measurement invented out of an absence, which is the one thing every
    // rule in this file is written to prevent. `metricText` is safe because `numeric()` rejects a
    // null first; this asks the same question before converting.
    const raw = metric.pct == null || metric.pct === '' ? null : Number(metric.pct);
    const pct = Number.isFinite(raw) ? raw : null;
    const size = pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`;
    if (metric.kind === 'turnaround') out.push(`${label} swung to profit`);
    else if (metric.kind === 'slipped-to-loss') out.push(`${label} swung to a loss`);
    else if (metric.kind === 'loss-narrowed') out.push(`${label} loss narrowed${size}`);
    else if (metric.kind === 'loss-widened') out.push(`${label} loss widened${size}`);
    else if (metric.kind === 'loss-flat') out.push(`${label} loss flat`);
    else if (metric.kind === 'flat') out.push(`${label} flat`);
    // A FLAT FIGURE TAKES NO SIGN. Moneycontrol reports an unchanged net profit as `normal` with a
    // pct of 0 — measured on a shipped row — and "−0.0%" reads as a fall that did not happen.
    else if (metric.kind === 'normal' && pct != null) out.push(`${label} ${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(1)}%`);
  }
  return out;
}

/**
 * The evidence rows a card shows (the view says how many): ONE PER SOURCE, IN ROUNDS.
 *
 * Taking the top rows by score alone put three rows of one feed on the card — "Cohesion MK Best
 * Ideas: no longer disclosed", "Life Insurance Corporation: no longer disclosed", "Vanguard Fund:
 * no longer disclosed" — under a strip announcing four sources. Every row was true and the card
 * still showed a quarter of what it had, three times over, while the reader's next question ("what
 * do the OTHER sources say?") was the one thing three identical lines cannot answer.
 *
 * So slots are handed out in ROUNDS: the strongest event from every source, then the second from
 * every source, and so on. Two sources share four rows two and two rather than three and one, and
 * a card with one source stops at `maxPerSource` instead of filling every slot from it.
 *
 * **IT COUNTS SOURCES THE WAY THE REST OF THE CARD DOES — `feedFamily`, not `event.feed`.** Keyed
 * on the feed id it spent a slot on `announcements` and another on `nse-filings`, which are one
 * source for corroboration (`feedCount`), one word on the row (`FEED_TAG`) and one family in the
 * dedupe. Measured on Sky Gold's 18 September board meeting: one approval, filed to both exchanges
 * under four different subjects, took all four rows of a card whose own header read "1 source" —
 * the same event four times, which is the failure this function exists to prevent, arrived at
 * through the one grouping that had not been brought in line.
 *
 * The cap is a display rule and nothing is lost to it: the footer counts every row it left out and
 * opens General Alerts, which is the tab that holds the complete record. It is not a dedupe either
 * — four filings of one event are four records upstream, and teaching the collector that they are
 * one is a change to what every reader of that feed sees, not to this card.
 */
export const MAX_PER_SOURCE = 3;

export function topEvidence(card, limit = 3, { maxPerSource = MAX_PER_SOURCE } = {}) {
  // Grouped by FAMILY, in the order each family's strongest event appears — so the rounds below
  // hand out slots by independent source, in score order within each one.
  const bySource = new Map();
  const latest = new Map();
  for (const event of card?.events || []) if (event.storyId) {
    const held = latest.get(event.storyId);
    if (!held || compareStoryRecency(event, held) > 0) latest.set(event.storyId, event);
  }
  const emitted = new Set();
  for (const source of card?.events || []) {
    const event = source.storyId ? latest.get(source.storyId) : source;
    if (emitted.has(event)) continue;
    emitted.add(event);
    const family = feedFamily(event);
    const found = bySource.get(family);
    if (found) found.push(event);
    else bySource.set(family, [event]);
  }
  const out = [];
  for (let round = 0; round < maxPerSource && out.length < limit; round += 1) {
    for (const list of bySource.values()) {
      if (out.length >= limit) break;
      if (list.length > round) out.push(list[round]);
    }
  }
  return out;
}

/**
 * One event's own claim, in ordinary English where this dashboard composed the sentence itself.
 *
 * "Volume 2.0x its 20-day average at the 2026-09-02 close" and "Goldman Sachs: no longer disclosed"
 * are both our own wordings of a number, written for a chronological table where the column
 * headings supply the context. On a card they are the whole line, and a reader should not have to
 * decode one.
 *
 * IT ONLY REWRITES WHAT WE WROTE. A publisher's headline is somebody else's words and is returned
 * untouched — putting our phrasing on a company's own statement is the error the filings rules
 * exist to prevent. A filing goes through `filingClaim`, which never rewords the exchange either:
 * it chooses between the subject, the exchange's own description and the exchange's own
 * sub-category, and the reason it has to choose is that a third of a card's leading filings named
 * a filing type and no event.
 *
 * COMPLETING OUR OWN LINE IS NOT REWRITING SOMEBODY ELSE'S. Three of these branches now add the
 * figure the row was graded on and used to leave in the tooltip: a disclosure's size, a result's
 * filed growth. That is the specific a reader opens the card for, and every one of them is read
 * from a collector's field.
 */
export function plainHeadline(event) {
  if (!event) return '';
  if (event.feed === 'technicals') {
    if (event.kind === 'volume' && Number.isFinite(event.volumeX)) return `Traded ${event.volumeX.toFixed(1)}x its normal volume`;
    if (event.kind === 'breakout') return 'Closed above its recent trading range';
    if (event.kind === 'move' && Number.isFinite(event.movePct)) {
      return `${event.movePct < 0 ? 'Fell' : 'Rose'} ${Math.abs(event.movePct).toFixed(1)}% at the close`;
    }
  }
  if (event.feed === 'investors' && event.investor) {
    if (event.action === 'new') return `${event.investor} is a new holder`;
    if (event.action === 'exited') return `${event.investor} is off the register`;
    if (Number.isFinite(event.deltaPp)) {
      return `${event.investor} ${event.action === 'added' ? 'raised' : 'cut'} its stake by ${Math.abs(event.deltaPp).toFixed(2)}pp`;
    }
  }
  if (event.feed === 'insider') {
    const size = insiderSize(event);
    const base = event.headline || 'Insider disclosure';
    // The upstream's own word for the kind of trade, appended only where it reads as one — a
    // "Block deal" is a negotiated transfer rather than open-market accumulation, which changes
    // what the figure means. "SAST" and "Insider" are filing regimes, not trade kinds, and are
    // left to the row's own detail rather than made to read as an adjective.
    const kind = /deal\b/i.test(String(event.tradeCategory || '')) ? ` ${String(event.tradeCategory).toLowerCase()}` : '';
    return size ? clip(`${base} · ${size}${kind}`) : clip(base);
  }
  if (event.feed === 'earnings') {
    const figures = resultFigures(event);
    const basis = event.resultBasis ? ` (${event.resultBasis})` : '';
    if (figures.length) return clip(`Result filed${basis} · ${figures.join(', ')}`);
  }
  if (feedFamily(event) === 'announcements') return filingClaim(event);
  return clip(event.headline || '');
}

/**
 * The event a card leads with: the strongest one that names something that happened.
 *
 * `card.events` is in score order and `topEvent` is its first, so this is the ranking's own answer
 * almost always — what it adds is a skip past an event whose claim is still only a filing TYPE
 * after every fallback in `filingClaim` (NSE repeats the subject as the description on some rows
 * and publishes no sub-category, so "General Updates" can survive all three). The skipped event
 * KEEPS ITS ROW: this chooses which of the card's facts leads the sentence and removes nothing.
 * Nothing is reordered either — a lower-scoring event leading the sentence does not promote it.
 */
export function leadEvent(card) {
  const events = card?.events || [];
  const newest = [...events].filter(e => e.importance === 'high' || isMaterialStoryUpdate(e)).sort((a, b) => compareStoryRecency(b, a))[0];
  if (newest?.storyId && newest.storyChange !== 'new' && !isTypeOnly(plainHeadline(newest))) return newest;
  return events.find((event) => !isTypeOnly(plainHeadline(event)))
    || events.find((event) => plainHeadline(event).trim())
    || card?.topEvent
    || null;
}

const asSentence = (text) => {
  const value = String(text || '').trim();
  if (!value) return '';
  return /[.!?…]$/.test(value) ? value : `${value}.`;
};

/**
 * The card's whole finding: ONE CLAIM, and a warning where the sources disagree.
 *
 * It is the strongest event's own statement and nothing else. The correlation is a chip directly
 * beneath this sentence, the other sources are the rows beneath that, and the count of them is in
 * the list's own header — so a pattern name, a feed tally or a "that is the strongest recent risk
 * here" in the sentence is a second copy of something already on the card, which is the failure
 * this whole layer exists to remove.
 *
 * THE DISAGREEMENT STAYS, AND IS A SENTENCE RATHER THAN A SCORE. "Sources disagree — 8 good, 6
 * bad" published our own arithmetic over somebody else's readings and left the reader to work out
 * what to do with it; the badge already reads `Reconcile`, so what belongs here is the action.
 */
export function plainInsight(card) {
  if (isRelatedNewsContext(card.topEvent)) return `Related-entity report: ${plainHeadline(card.topEvent)}. ${card.topEvent.attribution.reason}`;
  const claim = asSentence(plainHeadline(leadEvent(card)));
  const conflict = card.mixed ? ' Sources disagree — check both directions below.' : '';
  // A card with no statable event cannot be summarised, and inventing a summary for one is the
  // one thing that would be worse than saying so. In practice every surfaced card has at least
  // one event with a headline; this is the branch that keeps that a fact rather than a hope.
  if (!claim) return `The evidence below is what this card holds; no source stated a headline for it.${conflict}`;
  return `${claim}${conflict}`;
}


/**
 * The badge in the card's corner — what to DO, not what we scored it.
 *
 * A disagreement between sources outranks the priority band, because "these two readings conflict"
 * changes the reader's next action and "important" does not. The band itself stays on the card as
 * `data-priority` and in the filter chips above it.
 */
export function cardBadge(card) {
  if (isRelatedNewsContext(card.topEvent)) return { id: 'related', label: 'Review relationship', tone: 'caution' };
  if (card.priority === 'watch') return { id: 'watch', label: 'Company update', tone: 'neutral' };
  if (card.mixed) return { id: 'reconcile', label: 'Reconcile', tone: 'caution' };
  if (card.priority === 'must-see') return { id: 'must-see', label: 'Must see', tone: 'negative' };
  return { id: 'important', label: 'Important', tone: 'neutral' };
}

function directionSummary(events) {
  const count = { positive: 0, negative: 0, neutral: 0 };
  for (const event of events) count[event.direction] = (count[event.direction] || 0) + 1;
  return count;
}

// Both the first checked snapshot and the completed rank use the same identity
// aliases, including tickerless securities and grouped warrant ISINs.
let lastPositionIndex = null;
function positionSnapshotIndex({ holdings, sizes }) {
  const signature = JSON.stringify({ holdings, sizes });
  if (lastPositionIndex?.signature === signature) return lastPositionIndex.index;
  const index = new Map();
  for (const entity of portfolioNewsEntities(holdings)) {
    const rows = holdings.filter(holding => entity.portfolioIsins.includes(String(holding.isin || '').toUpperCase()) ||
      defaultCompanyNewsEntityId(holding) === entity.entityId);
    const weight = sizes.complete && rows.every(row => Number.isFinite(row.weightPct))
      ? rows.reduce((sum, row) => sum + row.weightPct, 0) : null;
    const keys = new Set([entity.ticker, entity.entityId, ...rows.flatMap(row => [row.ticker?.toUpperCase(), defaultCompanyNewsEntityId(row)])].filter(Boolean));
    for (const key of keys) index.set(key, weight === null ? null : (index.get(key) || 0) + weight);
  }
  lastPositionIndex = { signature, index };
  return index;
}

/**
 * Pure ranking function. It is exported because the scoring thresholds and noise suppression are
 * product rules; testing only whatever today's capture happens to contain would leave branches
 * unexercised most days.
 */
const rankCache = [];
const sameRows = (left, right) => left.length === right.length && left.every((row, i) => row === right[i]);
export function clearRankingCache() { rankCache.length = 0; lastPositionIndex = null; }

// ONE IMPLEMENTATION, TWO DRIVERS. `rankReport` is the synchronous reference the contract tests
// assert; `rankReportAsync` walks the same generator and yields to input between cards, so a
// Universe ranking (~1s of CPU here, once per partial publication) no longer lands as one task.
// The generator yields once per card in each pass; a driver decides whether a yield costs
// anything. Nothing about the result depends on the driver: same events, same order, same cards.
function* rankSteps(report, { holdings = coverage.holdings(), positionSizes = null, insightCompanies = screenerInsights.all(), sectorKpis = kpiImpact.snapshot() } = {}) {
  const day = report?.day || generalAlerts.today();
  const events = report?.events || [];
  const { token, email, orgId } = getHostContext().session;
  // Source records are immutable publications. Compare every reference, not counts/timestamps;
  // a same-ID correction publishes a new record. Copy arrays so in-place additions/removals
  // cannot defeat the comparison. Small membership and health values are compared by content.
  const input = { storyRevision: storyGrouping.revision(), day, scope: report?.scope || 'universe', events,
    health: JSON.stringify((report?.feeds || []).map(feed => [feed.id, feed.status, feed.reachesToday])),
    book: JSON.stringify(holdings), positions: JSON.stringify(positionSizes),
    insights: insightCompanies, kpis: sectorKpis, session: JSON.stringify([token, email, orgId]) };
  const cached = rankCache.find(entry => entry.input.storyRevision === input.storyRevision && entry.input.day === day && entry.input.scope === input.scope &&
    entry.input.health === input.health && entry.input.book === input.book && entry.input.positions === input.positions &&
    entry.input.session === input.session && entry.input.kpis === sectorKpis && sameRows(entry.input.events, events) &&
    sameRows(entry.input.insights, insightCompanies));
  if (cached) {
    const result = { ...cached.result, pending: report?.pending || 0, feeds: report?.feeds || [],
      meta: { ...cached.result.meta, cacheSavedAt: report?.cacheSavedAt || null } };
    rankingOptions.set(result, { holdings, positionSizes, insightCompanies });
    rankingEvidence.set(result, rankingEvidence.get(cached.result));
    return result;
  }
  const firstDay = shiftDay(day, -(WINDOW_DAYS - 1));
  // Private weights never come from the persisted names-only coverage list.
  const weights = report?.scope === 'portfolio' && positionSizes?.sizes.complete
    ? positionSnapshotIndex({ ...positionSizes, holdings: positionSizes.holdings || holdings }) : new Map();
  const feedById = new Map((report?.feeds || []).map((feed) => [feed.id, feed]));
  const holdingByTicker = new Map(
    (holdings || [])
      .filter((holding) => holding.ticker)
      .map((holding) => [String(holding.ticker).toUpperCase(), holding])
  );
  const holdingByEntity = new Map(portfolioNewsEntities(holdings).map(entity => [entity.entityId,
    holdings.find(h => entity.portfolioIsins.includes(String(h.isin || '').toUpperCase())) || entity]));

  const supportedReport = { ...report, events: (report?.events || []).filter(newsCanSupportAI) };
  const windowEvidence = (report?.events || []).filter(event => (event.ticker || event.entityId) &&
    validDay(event.day) && event.day >= firstDay && event.day <= day);
  const recent = windowEvidence.filter(event => newsCanSupportAI(event) && event.aiEligible !== false || isRelatedNewsContext(event));
  const grouped = new Map();
  for (const event of recent) {
    const ticker = event.ticker ? String(event.ticker).toUpperCase() : event.entityId;
    const list = grouped.get(ticker);
    if (list) list.push(event);
    else grouped.set(ticker, [event]);
  }

  let cards = [];
  for (const [key, rawEvents] of grouped) {
    const ticker = rawEvents.find(e => e.ticker)?.ticker || null;
    const entityId = rawEvents.find(e => e.entityId)?.entityId || null;
    const events = dedupe(rawEvents).filter(event => event.day >= firstDay && event.day <= day);
    if (!events.length) { yield; continue; }
    const scoredEvents = events
      .map((event) => ({ event, score: eventScore(event, day, feedById.get(event.feed)) }))
      .sort((a, b) => b.score.points - a.score.points || String(b.event.day).localeCompare(String(a.event.day)) || String(b.event.time || '').localeCompare(String(a.event.time || '')));
    const top = scoredEvents[0];
    const directEvents = events.filter(newsCanSupportAI);
    const directions = directionSummary(directEvents);
    const feeds = [...new Set(events.map(feedFamily))];
    const feedLabels = [...new Set(events.map((event) => event.feedLabel || event.feed))];
    const highCount = events.filter((event) => event.importance === 'high').length;
    const hasMaterialNegative = events.some((event) => event.importance === 'high' && event.direction === 'negative');
    const holding = holdingByTicker.get(ticker) || holdingByEntity.get(entityId) || null;
    const materialPortfolioEvent = !!holding && events.some((event) => event.importance === 'high' &&
      !!event.url && (materialFiling(event) || (feedFamily(event) === 'news' && event.namesCompany === true) || isRelatedNewsContext(event)));
    const mixed = directions.positive > 0 && directions.negative > 0;
    const scoreBreakdown = [...(top?.score.parts || [])];

    // THE NAMED PATTERNS, before the anonymous feed-count bonus below — they are the specific
    // reading of the same fact and are what the card actually shows the reader.
    const confluence = confluenceOf(directEvents, { feedById });
    const confluencePoints = Math.min(
      CONFLUENCE_MAX,
      confluence.reduce((sum, pattern) => sum + pattern.points, 0)
    );
    for (const pattern of confluence) scoreBreakdown.push({ label: `Confluence — ${pattern.label}`, points: pattern.points });
    const overCap = confluencePoints - confluence.reduce((sum, pattern) => sum + pattern.points, 0);
    if (overCap !== 0) scoreBreakdown.push({ label: `Confluence contribution capped at ${CONFLUENCE_MAX}`, points: overCap });

    if (holding) scoreBreakdown.push({ label: 'Company is in the real Portfolio list', points: 12 });
    // Corroboration changes ordering but cannot make a routine event urgent on its own. The first
    // draft gave another feed twelve points and promoted nearly every well-covered company; six
    // keeps the independent confirmation valuable without rewarding mere data availability.
    const independentFeeds = new Set(directEvents.map(feedFamily)).size;
    const directHighCount = directEvents.filter(e => e.importance === 'high').length;
    if (independentFeeds > 1) scoreBreakdown.push({ label: `${independentFeeds} independent feeds`, points: Math.min(12, (independentFeeds - 1) * 6) });
    if (directHighCount > 1) scoreBreakdown.push({ label: `${directHighCount} high-importance events`, points: Math.min(6, (directHighCount - 1) * 3) });
    if (mixed) scoreBreakdown.push({ label: 'Conflicting directional evidence needs review', points: 6 });
    else if (directions.negative > 0) scoreBreakdown.push({ label: 'Consistent negative evidence', points: 4 });
    else if (directions.positive > 1) scoreBreakdown.push({ label: 'Repeated positive evidence', points: 3 });

    cards.push({
      key,
      entityId,
      ticker,
      company: top?.event.company || holding?.name || key,
      sector: holding?.sector || null,
      holding: !!holding,
      holdingWeightPct: weights.get(key) ?? weights.get(entityId) ?? null,
      // Cards show the strongest evidence first. General Alerts remains the chronological record.
      events: scoredEvents.map((entry) => entry.event),
      sourceEvents: rawEvents,
      topEvent: top?.event || events[0],
      directions,
      mixed,
      highCount,
      materialPortfolioEvent,
      materialStoryUpdate: events.some(isMaterialStoryUpdate),
      evidenceKey: JSON.stringify(materialEvidence(events)),
      hasMaterialNegative,
      feedCount: feeds.length,
      feeds,
      feedLabels,
      confluence,
      stale: scoredEvents.every((entry) => entry.score.unavailable),
      scoreBreakdown,
      score: scoreBreakdown.reduce((sum, part) => sum + part.points, 0),
    });
    yield;
  }

  // A simultaneous negative cluster inside one real portfolio sector matters more than the same
  // isolated company event. The boost is intentionally small: it changes ordering, not truth.
  const negativeBySector = new Map();
  for (const card of cards) {
    if (!card.holding || !card.sector || !card.hasMaterialNegative) continue;
    negativeBySector.set(card.sector, (negativeBySector.get(card.sector) || 0) + 1);
  }
  const contextIndex = indexAlertContext(supportedReport, insightCompanies);
  const enriched = [];
  for (const card of cards) {
    const peers = card.sector ? negativeBySector.get(card.sector) || 0 : 0;
    if (card.hasMaterialNegative && peers > 1) {
      card.scoreBreakdown.push({ label: `${peers} portfolio companies in ${card.sector} have negative signals`, points: 3 });
      card.sectorCluster = peers;
      card.score += 3;
    } else {
      card.sectorCluster = 0;
    }
    const unclamped = card.score;
    card.score = clamp(unclamped, 0, 100);
    if (card.score !== unclamped) {
      // Keep the printed arithmetic equal to the printed score even if future feed/rule additions
      // would push a company above the deliberately bounded 100-point scale.
      card.scoreBreakdown.push({ label: '100-point priority scale cap', points: card.score - unclamped });
    }
    card.priority = card.score >= MUST_SEE_SCORE ? 'must-see' : card.score >= MIN_SCORE || card.materialPortfolioEvent || card.materialStoryUpdate ? 'important' : 'watch';
    card.insight = plainInsight(card);
    // WHICH OF THE COMPANY'S OWN SECTOR KPIs the evidence names — read off the same events, through
    // the desk's sector → KPI ontology. Like the topic chips on the rows it adds no score and no
    // alert; a company whose sector is not resolved, or whose evidence names no KPI, carries null.
    // See js/data/kpi-impact.js.
    card.kpis = kpiImpact.kpiImpactOf(card, sectorKpis);
    card.badge = cardBadge(card);
    enriched.push(enrichCardFromAllAlerts(card, supportedReport, { contextIndex }));
    yield;
  }
  cards = enriched;

  cards.sort(
    (a, b) => (weights.size ? (b.holdingWeightPct ?? -1) - (a.holdingWeightPct ?? -1) : 0) || b.score - a.score || b.highCount - a.highCount || String(b.topEvent?.day || '').localeCompare(String(a.topEvent?.day || '')) || a.company.localeCompare(b.company)
  );
  // A new checked development must stand on its own after the original evidence ages out.
  // Keep the measured score and the source's importance tag; neither is a new-facts gate.
  const surfaced = cards.filter((card) => card.score >= MIN_SCORE || card.materialPortfolioEvent || card.materialStoryUpdate);
  const marketWide = (report?.events || []).filter(
    (event) => !event.ticker && !event.entityId && event.day && event.day >= firstDay && event.day <= day
  ).length;

  const result = {
    day,
    scope: report?.scope || 'universe',
    pending: report?.pending || 0,
    feeds: report?.feeds || [],
    cards: surfaced,
    allCards: cards,
    meta: {
      positionSizes: report?.scope === 'portfolio' ? positionSizes?.sizes || null : null,
      sortedByHolding: weights.size > 0,
      firstDay,
      rawEvents: recent.length,
      topFunnelEvents: (report?.events || []).length,
      dedupedEvents: cards.reduce((sum, card) => sum + card.events.length, 0),
      contextualEvents: cards.reduce((sum, card) => sum + (card.contextEvents?.length || 0) + (card.upcomingEvents?.length || 0), 0),
      insightsAvailable: insightCompanies.length,
      activeCompanies: cards.length,
      surfacedCompanies: surfaced.length,
      suppressedCompanies: cards.length - surfaced.length,
      mustSee: surfaced.filter((card) => card.priority === 'must-see').length,
      correlated: surfaced.filter((card) => card.confluence?.length).length,
      important: surfaced.filter((card) => card.priority === 'important').length,
      marketWideExcluded: marketWide,
      staleFeeds: (report?.feeds || []).filter((feed) => feed.status !== 'ok' || feed.reachesToday === false).length,
      cacheSavedAt: report?.cacheSavedAt || null,
    },
  };
  rankingOptions.set(result, { holdings, positionSizes, insightCompanies });
  rankingEvidence.set(result, windowEvidence);
  // Bound private, in-memory derivations; alternate partial/final envelopes must not evict
  // each other's identical evidence on every notification.
  rankCache.unshift({ input: { ...input, events: [...events], insights: [...insightCompanies] }, result });
  if (rankCache.length > 4) rankCache.pop();
  return result;
}

export function rankReport(report, options = {}) {
  return runSteps(rankSteps(report, options));
}

/**
 * The same ranking, in ~12ms slices with a yield to input between them. Resolves to exactly what
 * `rankReport` returns for the same inputs, or to null once `isCurrent()` reports that nobody is
 * waiting for it any more — a ranking abandoned mid-way is never published or cached as a result.
 */
export async function rankReportAsync(report, options = {}, { yieldForInput, isCurrent = () => true, sliceMs } = {}) {
  const result = await runStepsInSlices(rankSteps(report, options), { yieldForInput, sliceMs, keepGoing: isCurrent });
  return result === undefined ? null : result;
}

/** Publish new material arrivals while preserving evidence not yet revalidated. */
export function mergePartialReport(previous, next) {
  const plan = mergePlan(previous, next);
  if (!plan) return next;
  return finishMerge(previous, next, plan.rank ? rankReport(plan.rank.report, plan.rank.options) : next);
}

/** The same merge, ranking in slices where it has to rank at all; null once nobody is waiting. */
export async function mergePartialReportAsync(previous, next, slicing = {}) {
  const plan = mergePlan(previous, next);
  if (!plan) return next;
  const merged = plan.rank ? await rankReportAsync(plan.rank.report, plan.rank.options, slicing) : next;
  return merged ? finishMerge(previous, next, merged) : null;
}

const cardKey = card => card.key || card.ticker || card.entityId;
function mergePlan(previous, next) {
  if (!previous || previous.scope !== next.scope || previous.day !== next.day) return null;
  const eventKey = event => `${event.feed}:${event.id || JSON.stringify([event.ticker, event.entityId, event.day, event.url, event.headline])}`;
  const nextEvidence = new Set((rankingEvidence.get(next) || []).map(eventKey));
  for (const card of next.allCards) for (const event of [...(card.sourceEvents || card.events), ...(card.contextEvents || []), ...(card.upcomingEvents || [])]) nextEvidence.add(eventKey(event));
  // Union EVIDENCE, not whole cards. Keeping the old card until every prior source answers
  // hides a new material story about that same company behind an unrelated slow feed.
  const evidence = new Map();
  let needsMerge = false;
  for (const report of [previous, next]) for (const card of report.allCards) {
    for (const event of [...(card.sourceEvents || card.events), ...(card.contextEvents || []), ...(card.upcomingEvents || [])]) {
      const id = eventKey(event);
      if (report === previous && !nextEvidence.has(id)) needsMerge = true;
      evidence.set(id, event); // New source corrections win under their stable identity.
    }
  }
  // Even a correction that removes AI eligibility must supersede its old event. Such a row
  // may have no next card at all; retain these current-window inputs in memory, never on disk.
  for (const event of rankingEvidence.get(next) || []) {
    const id = eventKey(event);
    evidence.set(id, event);
  }
  // A complete/cumulative publication already includes every retained identity and correction.
  // Only rank again when we actually added older evidence from an unfinished source.
  return { rank: needsMerge ? { report: { day: next.day, scope: next.scope, feeds: next.feeds,
    pending: next.pending, events: [...evidence.values()] }, options: rankingOptions.get(next) || rankingOptions.get(previous) } : null };
}

function finishMerge(previous, next, merged) {
  const key = cardKey;
  const existingVisible = new Set(previous.cards.map(key));
  const arrivingVisible = new Set(next.cards.map(key));
  const allCards = merged.allCards;
  const newlyVisible = new Set(merged.cards.map(key));
  const cards = allCards.filter(card => existingVisible.has(key(card)) || arrivingVisible.has(key(card)) || newlyVisible.has(key(card)));
  if (sameRows(cards, merged.cards)) return merged;
  const result = { ...merged, allCards, cards, meta: { ...merged.meta,
    activeCompanies: allCards.length, surfacedCompanies: cards.length, suppressedCompanies: allCards.length - cards.length,
    mustSee: cards.filter(card => card.priority === 'must-see').length,
    important: cards.filter(card => card.priority === 'important').length,
  } };
  rankingOptions.set(result, rankingOptions.get(merged));
  rankingEvidence.set(result, rankingEvidence.get(merged));
  return result;
}

/** Apply a newly checked private snapshot without another feed read or ranking pass. */
export function withPositionSnapshot(report, snapshot) {
  if (!report || report.scope !== 'portfolio' || !snapshot) return report;
  const byKey = positionSnapshotIndex(snapshot);
  const identity = card => [card.key, card.ticker, card.entityId].find(key => byKey.has(key));
  const decorate = card => {
    const holdingWeightPct = byKey.get(identity(card)) ?? null;
    return card.holding && card.holdingWeightPct === holdingWeightPct ? card : { ...card, holding: true, holdingWeightPct };
  };
  const retained = card => identity(card) !== undefined;
  const projected = report.allCards.filter(retained).map(decorate);
  const allCards = sameRows(projected, report.allCards) ? report.allCards : projected;
  const byIdentity = new Map(allCards.map(card => [card.key || card.ticker || card.entityId, card]));
  const selected = report.cards.filter(retained).map(card => byIdentity.get(card.key || card.ticker || card.entityId));
  const cards = sameRows(selected, report.cards) ? report.cards : selected;
  if (cards === report.cards && allCards === report.allCards && report.meta.positionSizes === snapshot.sizes) return report;
  const result = { ...report, cards, allCards, meta: { ...report.meta,
    positionSizes: snapshot.sizes, sortedByHolding: false,
    activeCompanies: allCards.length, surfacedCompanies: cards.length,
    mustSee: cards.filter(card => card.priority === 'must-see').length,
    important: cards.filter(card => card.priority === 'important').length,
  } };
  rankingOptions.set(result, { ...rankingOptions.get(report), holdings: snapshot.holdings, positionSizes: snapshot });
  rankingEvidence.set(result, (rankingEvidence.get(report) || []).filter(event =>
    [event.ticker, event.entityId].some(key => byKey.has(key))));
  return result;
}

/** A privacy-safe ready view while the live source modules revalidate. */
export async function cached({ scope = 'portfolio', holdings = null, positionSizes = null, isCurrent = () => true } = {}) {
  const book = holdings || coverage.holdings();
  // The sector → KPI file is small and static; it is read beside the cached window, never after it.
  const readings = Promise.all([kpiImpact.load(), storyGrouping.load()]);
  const report = await generalAlerts.readCachedAlertWindow({ scope, holdings: book });
  if (!report || !isCurrent()) return null;
  await readings;
  if (!isCurrent()) return null;
  return rankReportAsync(report, { holdings: book, positionSizes, insightCompanies: screenerInsights.all() }, { isCurrent });
}

/** Collect General Alerts once and rank each partial/final report without adding any request. */
export async function collect({ scope = 'portfolio', holdings = null, positionSizes = null, refresh = false, load = true, onPartial = null, isCurrent = () => true } = {}) {
  const book = holdings || coverage.holdings();
  const insightRead = load ? screenerInsights.load({ refresh }).catch(() => null) : Promise.resolve(null);
  // Started with the collection and awaited before the first completed ranking, so a card that
  // arrives with its evidence also arrives with its KPI line. A failed read resolves to null and the
  // cards simply carry none — and `kpiImpact.status()` says the file could not be read.
  const kpiRead = kpiImpact.load();
  const options = (insightCompanies = screenerInsights.all()) => ({ holdings: book, positionSizes, insightCompanies });
  // PARTIALS ARE RANKED IN SLICES, AND THE LATEST ONE WINS. Feeds settle over several seconds
  // and the general collector publishes progress as they do; ranking every publication of the
  // whole Universe synchronously was five one-second tasks on one open (profiled). A publication
  // that arrives while an earlier one is still being ranked replaces it in the queue — the reader
  // is owed the newest evidence, not every intermediate — and nothing is published after the
  // final report below, so a slow partial can never overwrite the completed ranking.
  let queued = null, publishing = null, closed = false;
  const live = () => !closed && isCurrent();
  const publish = async () => {
    while (queued && live()) {
      const partial = queued;
      queued = null;
      const ranked = await rankReportAsync(partial, options(), { isCurrent: live });
      if (!ranked || !live()) return;
      try { onPartial(ranked); } catch (err) { console.error('[ai-alerts] onPartial threw', err); }
    }
  };
  const report = await generalAlerts.collect({
    scope,
    holdings: book,
    includeHistory: true,
    refresh,
    load,
    isCurrent,
    // The ranking reads a bounded subset of the retained history (js/data/alert-pool-format.js
    // states which), and that subset is what the precomputed pool publishes for it.
    pool: 'ai',
    onPartial: onPartial ? (partial) => {
      if (!live()) return;
      queued = partial;
      if (!publishing) publishing = publish().finally(() => { publishing = null; });
    } : null,
  });
  closed = true;
  queued = null;
  if (typeof window !== 'undefined' && isCurrent()) {
    const first = shiftDay(report.day || generalAlerts.today(), -(WINDOW_DAYS - 1));
    void storyGrouping.review(report.events.filter(event => event.day >= first && event.day <= report.day &&
      (newsCanSupportAI(event) || isRelatedNewsContext(event))), { isCurrent });
  }
  if (publishing) await publishing;
  await kpiRead;
  if (!isCurrent()) return null; // Shared collection/storage finishes; obsolete view work stops.
  if (!onPartial) {
    await insightRead;
    if (!isCurrent()) return null;
    return rankReportAsync(report, options(), { isCurrent });
  }
  // A fast burst can finish before General Alerts' coalesced progress timer.
  // Publish its completed evidence now: optional operating context must not
  // hold the first cards behind a slow API or the private position-size check.
  const insights = screenerInsights.all();
  const ready = await rankReportAsync(report, options(insights), { isCurrent });
  if (!ready) return null;
  try { onPartial?.(ready); } catch (err) { console.error('[ai-alerts] onPartial threw', err); }
  await insightRead;
  if (!isCurrent()) return null;
  const updatedInsights = screenerInsights.all();
  return updatedInsights.length === insights.length && updatedInsights.every((company, i) => company === insights[i])
    ? ready : rankReportAsync(report, options(updatedInsights), { isCurrent });
}
