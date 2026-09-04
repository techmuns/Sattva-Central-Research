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

import * as generalAlerts from './daily-alerts.js';
import * as coverage from './coverage.js';

export const WINDOW_DAYS = 7;
export const MIN_SCORE = 64;
export const MUST_SEE_SCORE = 82;

const FEED_WEIGHT = {
  earnings: 12,
  announcements: 10,
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
  // 16 (today) + 12 (in the book) = 64, which is exactly MIN_SCORE. So a single story surfaces a
  // company on the day it breaks and drops below the line as it ages, and anything older needs a
  // second feed to agree with it. That is the intended shape: news opens the door, it does not
  // decide what is urgent.
  news: 6,
  'market-news': 0,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function ageInDays(eventDay, throughDay) {
  const event = Date.parse(`${eventDay}T00:00:00Z`);
  const through = Date.parse(`${throughDay}T00:00:00Z`);
  if (!Number.isFinite(event) || !Number.isFinite(through)) return WINDOW_DAYS;
  return Math.max(0, Math.round((through - event) / 86_400_000));
}

function recencyPoints(age) {
  if (age === 0) return 16;
  if (age === 1) return 10;
  if (age <= 3) return 6;
  return 2;
}

function normalizedHeadline(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** Keep one copy of a story per feed without erasing genuine cross-feed corroboration. */
function dedupe(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.feed}:${normalizedHeadline(event.headline) || event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
// same company inside seven days will not appear in most days' captures, so waiting for one to
// occur is not a test.
//
// FOUR RULES THIS LAYER OBEYS, AND THEY ARE THE SAME ONES THE REST OF THE FILE DOES:
//
// 1. IT ADDS NO FACT. Every clause in every sentence is quoted from an event that is already on the
//    card and already links to its own source. If a pattern cannot describe itself out of the
//    evidence it matched, it does not fire.
// 2. CO-OCCURRENCE IS NOT CAUSATION, AND THE WORDING MUST NOT SMUGGLE IT IN. Two things happening
//    to one company inside a week is what has been measured, and that is all the sentence may say.
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
const trackedNews = (e) => e.feed === 'news' && (e.keywords || []).length > 0;
const materialFiling = (e) => e.feed === 'announcements' && e.importance === 'high';
const resultEvent = (e) => e.feed === 'earnings' || e.feed === 'concalls';

/**
 * The tracked keywords on a card's news AND announcement rows, deduplicated, for a sentence that
 * names them. Both feeds classify against the same thirty-word vocabulary, so a filing's topic is
 * as nameable as a story's — and on the announcements feed it is the company's own statement of it.
 */
const newsTopics = (events) =>
  [...new Set(events.flatMap((e) => (e.feed === 'news' || e.feed === 'announcements' ? e.keywords || [] : [])))];

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
      return `${tape.headline}, alongside ${story.feed === 'news' ? 'a tracked story' : 'a material filing'}${why}: ${story.headline}.`;
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
      const feeds = [...new Set(bad.map((e) => e.feed))];
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
 * Pure and exported: a marquee investor and a volume spike landing on one company inside a week is
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
// THE READING LAYER — PLAIN WORDS, AND THE FEW NUMBERS THAT CARRY THE FINDING
//
// Everything above decides WHAT to surface. This decides how fast a human can take it in, and it
// is a separate concern with its own failure mode: a card can be perfectly honest and still take
// twenty seconds to read, at which point a page whose whole promise is "here is what needs you
// this morning" has failed at the only thing it does.
//
// The measured problem was repetition and register. The card printed a pattern's full sentence as
// its insight AND again inside a "Signals lining up" block, in the feeds' own technical wording —
// "Volume 4.4x its 20-day average at the 2026-09-02 close, and a tracked investor's latest book
// shows selling — President Of India: reduced by 2.00pp." That is one fact, said twice, in a
// vocabulary a reader has to decode.
//
// So: one short sentence in ordinary English, then the two or three numbers behind it as figures
// rather than prose, then the evidence rows. THREE RULES, and they are the file's existing rules:
//
// 1. NO NEW FACT, AND NO NEW NUMBER. Every phrase below is a rewording of an event already on the
//    card, and every figure is read from a field the collector wrote (`volumeX`, `movePct`,
//    `deltaPp`) rather than parsed back out of a sentence. Where the field is absent the cell is
//    absent; nothing is defaulted and nothing is derived twice.
// 2. CO-OCCURRENCE STAYS CO-OCCURRENCE. "Heavy trading, and a big holder has been selling" is two
//    measurements inside one week joined by "and". It is deliberately not "sold into the tape",
//    which reads as one causing the other and would be exactly the invented-trade-date error the
//    confluence header warns about — a filed shareholding is a quarterly disclosure and the trade
//    behind it may be months old.
// 3. PLAIN IS NOT VAGUE. "A big holder" replaces "a tracked investor's latest book", which is
//    shorter and says the same thing; it does not replace the investor's NAME, which stays in the
//    figures and in the evidence row beneath. Simplifying the register must never cost the reader
//    a specific.

/** One short, ordinary-English phrase per named cross-feed pattern. */
const PLAIN_PATTERN = {
  accumulation: 'Heavy trading, and a big holder has been buying',
  distribution: 'Heavy trading, and a big holder has been selling',
  'insider-and-investor': 'An insider and a big holder moved the same way',
  // BOTH OF THESE LEGS TAKE *ANY* TECHNICAL READING — a price move, a volume spike or a base
  // breakout — so neither sentence may say "the price moved". It read that way over a card
  // whose only tape event was 2.0x volume on a barely-changed close, which is a specific
  // claim the evidence underneath it did not make.
  'news-behind-the-move': 'Unusual trading, and there is news beside it',
  'results-reaction': 'Results are out, and the trading was unusual',
  'risk-cluster': 'Bad news showing up in more than one place',
  'unexplained-move': 'A big move with nothing to explain it',
};

/** The short label the evidence rows tag a feed with. Long enough to be a word, short enough to skim. */
export const FEED_TAG = {
  earnings: 'RESULT',
  concalls: 'CALL',
  announcements: 'FILING',
  insider: 'INSIDER',
  investors: 'FUND',
  technicals: 'TAPE',
  chatter: 'CHATTER',
  news: 'NEWS',
  'market-news': 'NEWS',
};

/**
 * The shortest true phrase for one event, or null where the event carries no figure worth a phrase.
 *
 * Pure and exported: these branches depend on which numbers a collector happened to write, and a
 * day's capture contains only some of them.
 */
export function shortFact(event) {
  if (!event) return null;
  if (event.feed === 'technicals') {
    if (event.kind === 'breakout') return 'closed above its recent range';
    if (Number.isFinite(event.volumeX) && event.kind === 'volume') return `${event.volumeX.toFixed(1)}x its normal volume`;
    if (Number.isFinite(event.movePct) && event.kind === 'move') {
      return `${event.movePct < 0 ? 'down' : 'up'} ${Math.abs(event.movePct).toFixed(1)}% at the close`;
    }
    return null;
  }
  if (event.feed === 'investors') {
    const who = event.investor ? String(event.investor) : null;
    if (!who) return null;
    // `new` and `exited` deliberately carry NO size — see the collector: a first or last disclosure
    // states a stake, never a change, and printing one as a delta would invent a trade.
    if (event.action === 'new') return `${who} is a new holder`;
    if (event.action === 'exited') return `${who} is off the register`;
    if (Number.isFinite(event.deltaPp)) {
      return `${who} ${event.action === 'added' ? 'up' : 'down'} ${Math.abs(event.deltaPp).toFixed(2)}pp`;
    }
    return null;
  }
  return null;
}

// THE FIGURES ARRIVE IN THE ORDER THE SENTENCE NAMES THEM. Every plain sentence above puts the
// tape first — "Heavy trading, and a big holder has been selling" — but the events are in SCORE
// order, so a fund book outranking a volume row produced "…has been selling — Cohesion MK Best
// Ideas is off the register, 2.0x its normal volume": both facts true, read backwards against the
// clause they belong to, which costs the reader a second pass over a card built to save one.
const READ_ORDER = { technicals: 0, investors: 1, insider: 2 };
const readRank = (event) => (event.feed in READ_ORDER ? READ_ORDER[event.feed] : 9);

/**
 * One event's own claim, in ordinary English where this dashboard composed the sentence itself.
 *
 * "Volume 2.0x its 20-day average at the 2026-09-02 close" and "Goldman Sachs: no longer disclosed"
 * are both our own wordings of a number, written for a chronological table where the column
 * headings supply the context. On a card they are the whole line, and a reader should not have to
 * decode one.
 *
 * IT ONLY REWRITES WHAT WE WROTE. A filing's subject, a con-call title and a publisher's headline
 * are somebody else's words and are returned untouched — putting our phrasing on a company's own
 * statement is the error the filings rules exist to prevent, and it would be a strictly worse trade
 * than a slightly longer line.
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
  return event.headline || '';
}

/** The distinct short facts on a card, in reading order, without repeating a feed. */
function factPhrases(card) {
  const out = [];
  const seenFeeds = new Set();
  for (const event of [...(card.events || [])].sort((a, b) => readRank(a) - readRank(b))) {
    if (seenFeeds.has(event.feed)) continue;
    const phrase = shortFact(event);
    if (!phrase) continue;
    seenFeeds.add(event.feed);
    out.push(phrase);
    if (out.length === 2) break;
  }
  return out;
}

/**
 * The three evidence rows a card shows: THE STRONGEST EVENT FROM EACH DIFFERENT FEED FIRST.
 *
 * Taking the top three by score alone put three rows of one feed on the card — "Cohesion MK Best
 * Ideas: no longer disclosed", "Life Insurance Corporation: no longer disclosed", "Vanguard Fund:
 * no longer disclosed" — under a strip announcing four sources. Every row was true and the card
 * still showed a quarter of what it had, three times over, while the reader's next question ("what
 * do the OTHER sources say?") was the one thing three identical lines cannot answer.
 *
 * So one row per feed comes first, in score order, and only then are the remaining events used to
 * fill. The rest are never lost: the footer counts them and opens General Alerts, which is the tab
 * that holds the complete record.
 */
export function topEvidence(card, limit = 3) {
  const events = card?.events || [];
  const firstOfFeed = [];
  const rest = [];
  const seen = new Set();
  for (const event of events) {
    if (seen.has(event.feed)) rest.push(event);
    else {
      seen.add(event.feed);
      firstOfFeed.push(event);
    }
  }
  return [...firstOfFeed, ...rest].slice(0, limit);
}

/**
 * The card's whole finding, in one or two ordinary sentences.
 *
 * Where a cross-feed pattern fired it leads, in plain words, with the concrete figures behind it
 * appended — that is the finding. Where none fired the card says what it does have, and a
 * disagreement between sources is always stated because it changes what the reader should do next.
 */
export function plainInsight(card) {
  const lead = card.confluence?.[0];
  const conflict = card.mixed ? ' Sources disagree here, so check both before acting.' : '';
  if (lead) {
    const facts = factPhrases(card);
    const tail = facts.length ? ` — ${facts.join(', ')}` : '';
    return `${PLAIN_PATTERN[lead.id] || lead.label}${tail}.${conflict}`;
  }
  const latest = plainHeadline(card.topEvent);
  if (card.mixed) {
    return `Sources disagree — ${card.directions.positive} good, ${card.directions.negative} bad. Strongest: ${latest}.`;
  }
  if (card.directions.negative > 0 && card.feedCount > 1) {
    return `Bad signs on ${card.feedCount} sources. Strongest: ${latest}.`;
  }
  if (card.directions.positive > 0 && card.feedCount > 1) {
    return `Good signs on ${card.feedCount} sources. Strongest: ${latest}.`;
  }
  if (card.directions.negative > 0) return `${latest}. That is the strongest recent risk here.`;
  if (card.directions.positive > 0) return `${latest}. That is the strongest recent good news here.`;
  return `${latest}. It is here for how material, recent and relevant it is.`;
}

/**
 * EXACTLY FOUR FIGURES, so the strip is one shape on every card and the eye can learn it.
 *
 * The first two are the facts this company actually has — a volume ratio, a day move, a change in
 * a disclosed book — and where it has fewer than two, the shape of the evidence fills in instead.
 * The last two never change: how many independent sources, and how many events they hold.
 *
 * TONE IS A CLAIM, SO VOLUME HAS NONE. A volume ratio is participation and the tape does not say
 * whether it was buying or selling — the technicals collector says so in those words — so the
 * volume cell is slate however large the number is. Colouring 4.4x red would be this dashboard
 * asserting a direction its own feed refuses to assert, which is a worse error than a dull cell.
 */
export function cardMetrics(card) {
  const cells = [];
  const seenFeeds = new Set();
  for (const event of [...(card.events || [])].sort((a, b) => readRank(a) - readRank(b))) {
    if (cells.length === 2) break;
    if (seenFeeds.has(event.feed)) continue;
    if (event.feed === 'technicals') {
      if (event.kind === 'volume' && Number.isFinite(event.volumeX)) {
        seenFeeds.add(event.feed);
        cells.push({ id: 'volume', label: 'Volume', value: `${event.volumeX.toFixed(1)}x`, tone: 'neutral', title: 'Volume against this company’s own 20-day average. Volume is participation, not direction.' });
        continue;
      }
      if (event.kind === 'move' && Number.isFinite(event.movePct)) {
        seenFeeds.add(event.feed);
        cells.push({ id: 'move', label: 'Move', value: `${event.movePct < 0 ? '−' : '+'}${Math.abs(event.movePct).toFixed(1)}%`, tone: event.movePct < 0 ? 'negative' : 'positive', title: 'The move between the last two completed closes.' });
        continue;
      }
      if (event.kind === 'breakout') {
        seenFeeds.add(event.feed);
        cells.push({ id: 'breakout', label: 'Tape', value: 'Breakout', tone: 'positive', title: 'Closed above its consolidation base.' });
        continue;
      }
      continue;
    }
    if (event.feed === 'investors') {
      const value = event.action === 'new' ? 'New' : event.action === 'exited' ? 'Out' : Number.isFinite(event.deltaPp) ? `${event.direction === 'negative' ? '−' : '+'}${Math.abs(event.deltaPp).toFixed(2)}pp` : null;
      if (!value) continue;
      seenFeeds.add(event.feed);
      cells.push({ id: 'holder', label: 'Holder', value, tone: event.direction === 'negative' ? 'negative' : 'positive', title: 'The change in a tracked investor’s latest filed book. A filing is quarterly; the trade behind it may be older.' });
    }
  }

  // THE FILLERS ARE TAKEN IN ORDER, direction first, because how the evidence READS is worth more
  // to somebody scanning than how much of it there is. A cell is one label and one value: "2 bad ·
  // 1 good" is two facts crammed into a figure and it truncated to "2 bad ·…" at 390px, so the
  // dominant side names the cell and the count is the figure. The full split stays in the tooltip.
  const bad = card.directions?.negative || 0;
  const good = card.directions?.positive || 0;
  const split = `${bad} negative and ${good} positive readings on this card. Neutral events are counted neither way.`;
  const fillers = [
    bad > good
      ? { id: 'direction', label: 'Bad signs', value: String(bad), tone: 'negative', title: split }
      : good > bad
        ? { id: 'direction', label: 'Good signs', value: String(good), tone: 'positive', title: split }
        : { id: 'direction', label: 'Direction', value: bad ? 'Split' : 'None', tone: 'neutral', title: bad ? split : 'Nothing on this card reads positive or negative.' },
    {
      id: 'high',
      label: 'Big news',
      value: String(card.highCount || 0),
      tone: 'neutral',
      title: 'Events that crossed their own source feed’s published threshold for mattering.',
    },
  ];
  let filler = 0;
  while (cells.length < 2 && filler < fillers.length) cells.push(fillers[filler++]);

  cells.push({ id: 'feeds', label: 'Sources', value: String(card.feedCount || 0), tone: 'neutral', title: 'How many independent feeds carry something on this company.' });
  cells.push({ id: 'events', label: 'Events', value: String((card.events || []).length), tone: 'neutral', title: `Events in the last ${WINDOW_DAYS} days.` });
  return cells.slice(0, 4);
}

/**
 * The badge in the card's corner — what to DO, not what we scored it.
 *
 * A disagreement between sources outranks the priority band, because "these two readings conflict"
 * changes the reader's next action and "important" does not. The band itself stays on the card as
 * `data-priority` and in the filter chips above it.
 */
export function cardBadge(card) {
  if (card.mixed) return { id: 'reconcile', label: 'Reconcile', tone: 'caution' };
  if (card.priority === 'must-see') return { id: 'must-see', label: 'Must see', tone: 'negative' };
  return { id: 'important', label: 'Important', tone: 'neutral' };
}

function directionSummary(events) {
  const count = { positive: 0, negative: 0, neutral: 0 };
  for (const event of events) count[event.direction] = (count[event.direction] || 0) + 1;
  return count;
}

/**
 * Pure ranking function. It is exported because the scoring thresholds and noise suppression are
 * product rules; testing only whatever today's capture happens to contain would leave branches
 * unexercised most days.
 */
export function rankReport(report, { holdings = coverage.holdings(), positionSizes = null } = {}) {
  const day = report?.day || generalAlerts.today();
  const firstDay = shiftDay(day, -(WINDOW_DAYS - 1));
  const weights = new Map();
  if (report?.scope === 'portfolio' && positionSizes?.sizes.complete) {
    for (const h of holdings) {
      if (h.ticker && Number.isFinite(h.weightPct)) {
        const ticker = h.ticker.toUpperCase();
        weights.set(ticker, (weights.get(ticker) || 0) + h.weightPct);
      }
    }
  }
  const feedById = new Map((report?.feeds || []).map((feed) => [feed.id, feed]));
  const holdingByTicker = new Map(
    (holdings || [])
      .filter((holding) => holding.ticker)
      .map((holding) => [String(holding.ticker).toUpperCase(), holding])
  );

  const recent = (report?.events || []).filter(
    (event) => event.aiEligible !== false && event.ticker && event.day && event.day >= firstDay && event.day <= day
  );
  const grouped = new Map();
  for (const event of recent) {
    const ticker = String(event.ticker).toUpperCase();
    const list = grouped.get(ticker);
    if (list) list.push(event);
    else grouped.set(ticker, [event]);
  }

  let cards = [...grouped].map(([ticker, rawEvents]) => {
    const events = dedupe(rawEvents);
    const scoredEvents = events
      .map((event) => ({ event, score: eventScore(event, day, feedById.get(event.feed)) }))
      .sort((a, b) => b.score.points - a.score.points || String(b.event.day).localeCompare(String(a.event.day)) || String(b.event.time || '').localeCompare(String(a.event.time || '')));
    const top = scoredEvents[0];
    const directions = directionSummary(events);
    const feeds = [...new Set(events.map((event) => event.feed))];
    const feedLabels = [...new Set(events.map((event) => event.feedLabel || event.feed))];
    const highCount = events.filter((event) => event.importance === 'high').length;
    const hasMaterialNegative = events.some((event) => event.importance === 'high' && event.direction === 'negative');
    const holding = holdingByTicker.get(ticker) || null;
    const mixed = directions.positive > 0 && directions.negative > 0;
    const scoreBreakdown = [...(top?.score.parts || [])];

    // THE NAMED PATTERNS, before the anonymous feed-count bonus below — they are the specific
    // reading of the same fact and are what the card actually shows the reader.
    const confluence = confluenceOf(events, { feedById });
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
    if (feeds.length > 1) scoreBreakdown.push({ label: `${feeds.length} independent feeds`, points: Math.min(12, (feeds.length - 1) * 6) });
    if (highCount > 1) scoreBreakdown.push({ label: `${highCount} high-importance events`, points: Math.min(6, (highCount - 1) * 3) });
    if (mixed) scoreBreakdown.push({ label: 'Conflicting directional evidence needs review', points: 6 });
    else if (directions.negative > 0) scoreBreakdown.push({ label: 'Consistent negative evidence', points: 4 });
    else if (directions.positive > 1) scoreBreakdown.push({ label: 'Repeated positive evidence', points: 3 });

    return {
      ticker,
      company: top?.event.company || holding?.name || ticker,
      sector: holding?.sector || null,
      holding: !!holding,
      holdingWeightPct: weights.get(ticker) ?? null,
      // Cards show the strongest evidence first. General Alerts remains the chronological record.
      events: scoredEvents.map((entry) => entry.event),
      topEvent: top?.event || events[0],
      directions,
      mixed,
      highCount,
      hasMaterialNegative,
      feedCount: feeds.length,
      feeds,
      feedLabels,
      confluence,
      stale: scoredEvents.every((entry) => entry.score.unavailable),
      scoreBreakdown,
      score: scoreBreakdown.reduce((sum, part) => sum + part.points, 0),
    };
  });

  // A simultaneous negative cluster inside one real portfolio sector matters more than the same
  // isolated company event. The boost is intentionally small: it changes ordering, not truth.
  const negativeBySector = new Map();
  for (const card of cards) {
    if (!card.holding || !card.sector || !card.hasMaterialNegative) continue;
    negativeBySector.set(card.sector, (negativeBySector.get(card.sector) || 0) + 1);
  }
  cards = cards.map((card) => {
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
    card.priority = card.score >= MUST_SEE_SCORE ? 'must-see' : card.score >= MIN_SCORE ? 'important' : 'watch';
    card.insight = plainInsight(card);
    card.metrics = cardMetrics(card);
    card.badge = cardBadge(card);
    return card;
  });

  cards.sort(
    (a, b) => (weights.size ? (b.holdingWeightPct ?? -1) - (a.holdingWeightPct ?? -1) : 0) || b.score - a.score || b.highCount - a.highCount || String(b.topEvent?.day || '').localeCompare(String(a.topEvent?.day || '')) || a.company.localeCompare(b.company)
  );
  const surfaced = cards.filter((card) => card.score >= MIN_SCORE);
  const marketWide = (report?.events || []).filter(
    (event) => !event.ticker && event.day && event.day >= firstDay && event.day <= day
  ).length;

  return {
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
      dedupedEvents: cards.reduce((sum, card) => sum + card.events.length, 0),
      activeCompanies: cards.length,
      surfacedCompanies: surfaced.length,
      suppressedCompanies: cards.length - surfaced.length,
      mustSee: surfaced.filter((card) => card.priority === 'must-see').length,
      correlated: surfaced.filter((card) => card.confluence?.length).length,
      important: surfaced.filter((card) => card.priority === 'important').length,
      marketWideExcluded: marketWide,
      staleFeeds: (report?.feeds || []).filter((feed) => feed.status !== 'ok' || feed.reachesToday === false).length,
    },
  };
}

/** Collect General Alerts once and rank each partial/final report without adding any request. */
export async function collect({ scope = 'portfolio', holdings = null, positionSizes = null, refresh = false, load = true, onPartial = null } = {}) {
  const book = holdings || coverage.holdings();
  const report = await generalAlerts.collect({
    scope,
    holdings: book,
    includeHistory: true,
    refresh,
    load,
    onPartial: onPartial ? (partial) => onPartial(rankReport(partial, { holdings: book, positionSizes })) : null,
  });
  return rankReport(report, { holdings: book, positionSizes });
}
