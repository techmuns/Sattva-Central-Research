// data/alert-drivers.js — WHICH OF THE THREE INVESTOR QUESTIONS A TRACKED TOPIC BEARS ON.
//
// An AI Alerts card already answers "what happened". It did not answer the question a reader
// actually opens it with, which is "does this change anything I believed?" — and on this desk that
// question has exactly three forms:
//
//   • THE EARNINGS ASSUMPTION — what the business earns. Orders, capacity, launches, approvals.
//   • THE VALUATION — what a share is worth and how many of them there are. Dilution, buybacks,
//     distributions, a block changing hands.
//   • THE THESIS — whether it is still the business that was bought. Fraud, litigation, a rating
//     move, a merger, the auditor leaving.
//
// This file is the ONE mapping from the desk's tracked vocabulary onto those three, in the same way
// `news-keywords.js` is the one definition of the vocabulary itself. It is deliberately a separate
// file rather than three more fields in that one: the keyword list is the desk's, and a taxonomy of
// what a topic BEARS ON is this dashboard's reading of it. Two different claims, two files.
//
// ---------------------------------------------------------------------------------------
// FOUR THINGS THIS IS NOT, and they are the whole reason it is allowed on a card at all
//
// 1. IT ADDS NO FACT AND NO NUMBER. Every driver is a topic reading that is ALREADY on the event,
//    written by `newsSignal()` or `announcementSignal()`, and it carries that event with it so the
//    card can link to the same source the evidence row links to. Nothing here reads a payload,
//    fetches anything or computes a figure. If a card shows a driver, the source is one click away.
//
// 2. IT IS STILL A TOPIC READING, NEVER A DIRECTION. `news-keywords.js` rule 1 says a keyword says
//    what a story is ABOUT: "Lawsuit" is a topic and the company can be the plaintiff, "Approval"
//    is a topic and the approval can be somebody else's. Bucketing that topic does not upgrade it.
//    So a driver says a topic COULD CHANGE the earnings assumption — never that earnings will rise,
//    never that the valuation is wrong. The consuming surface must keep that wording; the moment it
//    reads as a verdict this is a sentiment model wearing a taxonomy's clothes.
//
// 3. A MATCH IS A WORD IN A HEADLINE, NOT A VERIFIED EVENT. Same rule as rule 2 of the keyword
//    file, and it survives one layer up: "Order in the news" means a story about this company
//    carried the tracked word Order. It does not mean an order was won, and no driver string may
//    say so.
//
// 4. IT IS NOT A SECOND MATERIALITY GATE. Importance is already decided — by the keyword rule for
//    news, by `announcementSignal` for filings — and this file does not re-decide it, does not
//    score, and contributes nothing to `rankReport`'s arithmetic. A card is surfaced on its score;
//    this only explains a card that was surfaced anyway.
//
// ---------------------------------------------------------------------------------------
// WHY THREE FEEDS AND NOT NINE. A driver needs two things: a topic reading, and certainty that the
// topic is about THIS company. Only the filing feeds and confirmed company news have both.
//
//   • The tape, the fund books and the insider rows carry no topic at all — "2.0x normal volume" is
//     not about orders or about governance, and inventing a bucket for it would be this dashboard
//     asserting why somebody traded. They stay in the metrics strip and the evidence rows, which is
//     where a measurement belongs.
//   • MARKET-WIDE NEWS IS EXCLUDED OUTRIGHT. It carries no company — that is why General Alerts
//     refuses to offer it under a narrowed scope — so filing one under a company's valuation would
//     attribute somebody else's story to them. The same reasoning excludes a related-entity report:
//     it is reviewed context about a DIFFERENT company and the card already labels it as such.

import { KEYWORDS } from './news-keywords.js';
import { isRelatedNewsContext } from './company-news-attribution.js';

/** The three questions, in the order a card states them. `label` is the sentence form. */
export const QUESTIONS = [
  { id: 'earnings', label: 'the earnings assumption', short: 'Earnings assumption' },
  { id: 'valuation', label: 'the valuation', short: 'Valuation' },
  { id: 'thesis', label: 'the thesis', short: 'Thesis' },
];

const QUESTION_BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

/**
 * Every tracked keyword id against the question it bears on.
 *
 * TWO ENTRIES ARE WORTH THE COMMENT because the obvious bucket is the wrong one:
 *
 *   • `stake-sale` sits in the vocabulary's `deals` family and belongs to VALUATION here. A block
 *     changing hands does not alter what the business earns; it alters who owns it and what the
 *     float is. Bucketing it by its family would have put it beside mergers under the thesis.
 *   • `merger` and `acquisition` are THESIS, not earnings. They plainly move future earnings too,
 *     but the prior question is whether the thing being valued is still the same thing, and that
 *     is the one a reader has to answer first.
 *
 * `brokerage-research` is DELIBERATELY ABSENT and must stay absent. It is somebody's published view
 * OF the company rather than an event AT the company, so bucketing it would let an analyst note
 * read on this card as a change in the facts. `isBrokerageResearch` exists for the same reason.
 */
const QUESTION_BY_TOPIC = new Map(Object.entries({
  'capacity-expansion': 'earnings',
  capex: 'earnings',
  order: 'earnings',
  orderbook: 'earnings',
  'receipt-of-order': 'earnings',
  'product-launch': 'earnings',
  commissioning: 'earnings',
  'joint-venture': 'earnings',
  partnership: 'earnings',
  approval: 'earnings',
  trial: 'earnings',
  patent: 'earnings',
  earnings: 'earnings',

  'stake-sale': 'valuation',
  qip: 'valuation',
  'qualified-institutional-placement': 'valuation',
  'preferential-issue': 'valuation',
  'rights-issue': 'valuation',
  buyback: 'valuation',

  merger: 'thesis',
  acquisition: 'thesis',
  'corporate-governance': 'thesis',
  fraud: 'thesis',
  lawsuit: 'thesis',
  resignation: 'thesis',
  investigation: 'thesis',
  fire: 'thesis',
  accident: 'thesis',
  default: 'thesis',
  downgrade: 'thesis',
}));

/**
 * `announcementSignal`'s own directional rule names, against the same three questions.
 *
 * These arrive on the event as `filingRule` — a FIELD the classifier writes, never a phrase parsed
 * back out of `signalReason`. Reading our own prose to recover a value we had in hand is the error
 * the AI Alerts card rules name directly ("every figure is read from a field the collector wrote,
 * never regexed back out of a sentence"), and a reworded sentence would silently empty this map.
 *
 * A rating move is THESIS rather than earnings: it is an outside assessment of whether the company
 * can carry its obligations, which is a question about the business rather than about a quarter.
 */
const QUESTION_BY_RULE = new Map(Object.entries({
  'order or contract award': 'earnings',
  'regulatory approval or patent grant': 'earnings',
  'commercial production start': 'earnings',
  'contract cancellation or suspension': 'earnings',

  'shareholder distribution': 'valuation',

  'rating upgrade': 'thesis',
  'rating downgrade': 'thesis',
  'default or insolvency': 'thesis',
  'fraud or enforcement action': 'thesis',
  'auditor resignation': 'thesis',
}));

/**
 * Where a driver was read, in the words a reader would use.
 *
 * A feed with no entry supplies no drivers AT ALL — that is the gate, and it is a map rather than a
 * list of exclusions so a feed added later is silent by default instead of inheriting a phrase that
 * happens to be wrong for it. NSE and BSE filings share "a filing" because the distinction between
 * the two exchanges is not what this sentence is about; the evidence row beneath still names which.
 */
const SOURCE_PHRASE = {
  announcements: 'a filing',
  'nse-filings': 'a filing',
  news: 'the news',
};

const LABEL_TO_TOPIC = new Map(KEYWORDS.map((k) => [k.label.toLowerCase(), k.id]));

/** The tracked topic ids on one event, whether the collector wrote ids, labels or both. */
function topicIdsOf(event) {
  const ids = new Set();
  for (const id of event.keywordIds || []) if (typeof id === 'string') ids.add(id);
  // `newsSignal`'s reported-topic branch writes labels and no ids, so the labels are resolved back
  // through the vocabulary rather than being dropped. An unrecognised label is not invented into a
  // topic — it simply supplies no driver.
  for (const label of event.keywords || []) {
    const id = LABEL_TO_TOPIC.get(String(label).toLowerCase());
    if (id) ids.add(id);
  }
  return ids;
}

const topicLabelOf = (id) => KEYWORDS.find((k) => k.id === id)?.label || null;

/**
 * The drivers one event contributes, or an empty array where it contributes none.
 *
 * Exported for the same reason `moveSeverity` and `shortFact` are: these branches depend on which
 * fields a collector happened to write, and a given day's capture contains only some of them.
 */
export function driversFromEvent(event) {
  if (!event || isRelatedNewsContext(event)) return [];
  const where = SOURCE_PHRASE[event.feed];
  if (!where) return [];

  const out = [];
  const seen = new Set();
  const add = (label, question, why) => {
    if (!label || !QUESTION_BY_ID.has(question)) return;
    const key = `${question}:${label.toLowerCase()}:${where}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, question, label, where, text: `${label} in ${where}`, why, event });
  };

  // The filing's own directional rule leads, because it read the exchange's description of THIS
  // filing rather than matching a word anywhere in it.
  const rule = typeof event.filingRule === 'string' ? event.filingRule : null;
  if (rule && QUESTION_BY_RULE.has(rule)) {
    add(rule, QUESTION_BY_RULE.get(rule), `A stated announcement rule matched this filing's own text: ${rule}. Matching the rule is not confirmation the event has occurred.`);
  }
  for (const id of topicIdsOf(event)) {
    const question = QUESTION_BY_TOPIC.get(id);
    if (!question) continue;
    add(topicLabelOf(id), question, `Matched the tracked keyword ${topicLabelOf(id)}. A keyword says what a source is about; it does not verify the event or its direction.`);
  }
  return out;
}

export const DRIVERS_PER_QUESTION = 3;

/**
 * A card's drivers, grouped by question, strongest evidence first.
 *
 * `card.events` is already in score order, so walking it in order gives each bucket the drivers
 * from the evidence that earned the card its place — no second ranking, and nothing that could
 * disagree with the rows printed underneath.
 *
 * The same topic read in two different places is TWO drivers ("Order in a filing" and "Order in the
 * news"), because a filing and a story are separate records with separate links, and collapsing
 * them would hide one of the two sources from a reader who wants it. The same topic twice in the
 * same place is one.
 *
 * Buckets are capped so the sentence stays one sentence, and an overflow is COUNTED rather than
 * silently dropped: a truncation nobody can see is the card claiming a company has fewer things
 * bearing on it than it does.
 */
export function driversOf(card, { limit = DRIVERS_PER_QUESTION } = {}) {
  const byQuestion = new Map(QUESTIONS.map((q) => [q.id, []]));
  const seen = new Set();
  let total = 0;
  for (const event of card?.events || []) {
    for (const driver of driversFromEvent(event)) {
      if (seen.has(driver.key)) continue;
      seen.add(driver.key);
      byQuestion.get(driver.question).push(driver);
      total += 1;
    }
  }

  const buckets = [];
  const silent = [];
  for (const question of QUESTIONS) {
    const found = byQuestion.get(question.id);
    if (!found.length) { silent.push(question); continue; }
    buckets.push({
      id: question.id,
      label: question.label,
      short: question.short,
      drivers: found.slice(0, limit),
      overflow: Math.max(0, found.length - limit),
    });
  }
  return { buckets, silent, total };
}
