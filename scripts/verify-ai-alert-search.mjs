#!/usr/bin/env node
// AI Alerts search: the company first, then words found together in one line, never scattered.
// Built on the desk's report of 29 October 2026 — "icici bank" returned seven companies, because an
// "ICICI Securities" broker line and a "bank" line elsewhere on a card each supplied one word.
import assert from 'node:assert/strict';
import { rankSearch, searchScore, suggestCompanies, highlightHtml, normalizeText } from '../public/js/ui/ai-alert-search.js';
import { matchesSearch } from '../public/js/ui/ai-alert-utils.js';

const ev = (headline, extra = {}) => ({ headline, detail: '', feed: 'announcements', feedLabel: 'Announcements', day: '2026-10-28', ...extra });
const broker = (broker, points) => ev(`${broker} report`, { feed: 'broker-reports', feedLabel: 'Broker reports', brokerReport: { broker, points } });
const card = (company, ticker, events, extra = {}) => ({ key: ticker, ticker, company, events, sourceEvents: events, insight: events[0]?.headline || '', ...extra });

const cards = [
  card('PVR INOX', 'PVRINOX', [ev('Result filed (YOY) · net profit +148.0%'), broker('ICICI Securities', 'Recovery in footfalls'), ev('Bank guarantee for screens')]),
  card('ICICI Bank', 'ICICIBANK', [ev('Result filed (YOY) · net profit +21.0%, revenue +16.0%'), broker('Antique', 'Steady NIM')], { sector: 'Banks' }),
  card('Karur Vysya Bank Ltd.', 'KARURVYSYA', [broker('ICICI Securities', 'Asset quality strong'), broker('Nuvama', 'Loan growth')], { sector: 'Banks' }),
  card('Punjab Natl.Bank', 'PNB', [ev('Result filed (YOY) · net profit +14.0%')], { sector: 'Banks' }),
  card('J & K Bank', 'J&KBANK', [ev('Result filed (YOY) · net profit +10.0%')], { sector: 'Banks' }),
  card('Star Health Insu', 'STARHEALTH', [ev('Result filed (YOY) · net profit +381.0%')]),
  card('Mahindra & Mahindra', 'M&M', [ev('Hidden fourth event: lithium supply agreement'), broker('ICICI Securities', 'Q2 results beat on margins')], { sector: 'Automobiles' }),
  card('Tech Mahindra Ltd.', 'TECHM', [ev('Life Insurance Corporation cut its stake by 1.25pp', { feed: 'investors', feedLabel: 'Investor holding' })]),
];
const keys = (result) => result.cards.map((c) => c.key);

// The reported case: the company it names, and nothing else unless asked.
const icici = rankSearch(cards, 'icici bank');
assert.deepEqual(keys(icici), ['ICICIBANK'], '"icici bank" shows ICICI Bank alone');
assert.equal(icici.named, true);
assert(icici.mentions.some((c) => c.key === 'KARURVYSYA'), 'a bank whose broker line names ICICI is a mention, not a result');
assert(!icici.mentions.some((c) => c.key === 'PVRINOX'), 'words from two different lines are no match at all');
assert.deepEqual(keys(rankSearch(cards, 'icici bank', { includeMentions: true }))[0], 'ICICIBANK', 'mentions, when shown, follow the named company');

// The ways a reader names a company.
for (const [q, want] of [['ICICIBANK', 'ICICIBANK'], ['icic', 'ICICIBANK'], ['ICICI Bank Ltd', 'ICICIBANK'], ['punjab national', 'PNB'],
  ['pnb', 'PNB'], ['j&k', 'J&KBANK'], ['J & K bank', 'J&KBANK'], ['star health insurance', 'STARHEALTH'], ['m&m', 'M&M'], ['tech mahindra', 'TECHM']]) {
  assert.equal(keys(rankSearch(cards, q))[0], want, `"${q}" leads with ${want}`);
  assert.equal(rankSearch(cards, q).named, true, `"${q}" reads as a company`);
}
assert.deepEqual(keys(rankSearch(cards, 'bank')).sort(), ['ICICIBANK', 'J&KBANK', 'KARURVYSYA', 'PNB'], '"bank" shows the banks, not every line with the word');
assert.deepEqual(keys(rankSearch(cards, 'mahindra')).slice(0, 2).sort(), ['M&M', 'TECHM'], 'a shared word names both companies');

// Company + topic: the named company, its topic found in one line of its own evidence.
const results = rankSearch(cards, 'icici results');
assert.deepEqual(keys(results), ['ICICIBANK'], '"icici results" is ICICI Bank\'s result');
assert(results.mentions.some((c) => c.key === 'M&M'), 'an ICICI Securities results note on another company is a mention');
assert.equal(searchScore(cards[6], 'mahindra agreement') > 0, true, 'company + a word from its evidence');
assert.equal(searchScore(cards[6], 'mahindra missing-keyword'), 0);

// Topic: words together in ONE line.
assert.deepEqual(keys(rankSearch(cards, 'lithium supply')), ['M&M'], 'a phrase in a headline');
assert.equal(rankSearch(cards, 'lithium supply').named, false);
assert.equal(searchScore(cards[0], 'icici guarantee'), 0, 'two words from two different lines do not match');
assert.equal(keys(rankSearch(cards, 'result')).length, 6, 'a topic shows every company whose evidence carries it, a broker\'s results note included');
assert.equal(searchScore(cards[0], 'j k'), 0, 'single letters are not a topic');
assert.equal(searchScore(cards[1], 'ank'), 0, 'a word matches at the start of a word, not inside it');
assert(searchScore(cards[1], 'banks') > 0, 'sector');
assert(searchScore(cards[7], 'investor holding') > 0, 'feed label');
assert(searchScore(cards[0], '2026-10-28') > 0, 'the event day as written');
assert(searchScore(cards[0], '28 Oct 2026') > 0, 'and as displayed');

// The single definition behind the older predicate.
assert.equal(matchesSearch(cards[1], ''), true);
assert.equal(matchesSearch(cards[0], 'icici bank'), false);
assert.equal(matchesSearch(cards[1], 'icici bank'), true);

// Typeahead and marks.
assert.deepEqual(suggestCompanies(cards, 'icic').map((s) => s.key), ['ICICIBANK']);
assert.deepEqual(suggestCompanies(cards, 'ba').map((s) => s.key).sort(), ['ICICIBANK', 'J&KBANK', 'KARURVYSYA', 'PNB']);
assert.deepEqual(suggestCompanies(cards, 'zzz'), []);
assert.equal(highlightHtml('<ICICI> Bank', 'icici'), '&lt;<mark class="ai-search-mark">ICICI</mark>&gt; Bank', 'marked and escaped');
assert.equal(highlightHtml('Tech Mahindra', 'ahindra'), 'Tech Mahindra', 'only at the start of a word');
assert.equal(normalizeText('Punjab Natl.Bank'), 'punjab natl bank');

// A keystroke over a Universe-sized list stays cheap: each card is prepared once.
const many = Array.from({ length: 3000 }, (_, i) => card(`Company ${i} Industries`, `CO${i}`, Array.from({ length: 12 }, (_, j) => ev(`Filing ${j} about order ${i}`))));
rankSearch(many, 'warm');
const started = performance.now();
for (const q of ['c', 'co', 'com', 'company 1', 'order 99', 'industries']) rankSearch(many, q);
const ms = performance.now() - started;
assert(ms < 600, `six keystrokes over 3,000 cards take ${Math.round(ms)}ms`);
console.log(`PASS AI Alerts search: company first (name, ticker, abbreviations, prefix), company + topic, one-line topics, mentions apart, typeahead, safe marks; six keystrokes over 3,000 cards in ${Math.round(ms)}ms.`);
