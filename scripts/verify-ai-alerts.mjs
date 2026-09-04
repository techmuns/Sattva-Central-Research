#!/usr/bin/env node
import assert from 'node:assert/strict';
import { currentDay, relativeAge, formatDay, latestSignal, matchesSearch } from '../public/js/ui/ai-alert-utils.js';

assert.equal(currentDay(Date.parse('2026-09-04T18:29:59Z')), '2026-09-04');
assert.equal(currentDay(Date.parse('2026-09-04T18:30:00Z')), '2026-09-05');
assert.equal(currentDay(Date.parse('2026-12-31T18:30:00Z')), '2027-01-01');
for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
  process.env.TZ = zone;
  assert.equal(relativeAge('2026-09-04', '2026-09-04'), 'today');
  assert.equal(relativeAge('2026-09-04', '2026-09-05'), '1d');
  assert.equal(relativeAge('2026-08-31', '2026-09-04'), '4d');
  assert.equal(relativeAge('2026-12-31', '2027-01-01'), '1d');
  assert.equal(relativeAge('2024-02-28', '2024-03-01'), '2d');
  assert.equal(relativeAge('2026-09-05', '2026-09-04'), 'in 1d');
  assert.equal(formatDay('2026-09-04'), '04 Sept 2026');
}
for (const day of [null, undefined, '', '2026-02-29', '2026-09-31', 'garbage']) {
  assert.equal(relativeAge(day, '2026-09-04'), '—');
  assert.equal(formatDay(day), 'Date unavailable');
}
assert.equal(relativeAge('2026-09-04', 'bad date'), '—');
assert.equal(latestSignal([]), null);
assert.equal(latestSignal([{ day: '2026-02-29' }]), null);
const events = [
  { day: '2026-09-03', time: '16:30', headline: 'Strongest but older signal' },
  { day: '2026-09-04', time: '09:15', headline: 'Routine filing' },
  { day: '2026-09-04', time: '14:42', headline: 'Hidden fourth event: lithium supply agreement', feedLabel: 'Corporate Announcements' },
];
assert.deepEqual(latestSignal(events), { day: '2026-09-04', time: '14:42', datetime: '2026-09-04T14:42:00+05:30' });
assert.deepEqual(latestSignal([...events, { day: '2026-09-04', time: null }]), { day: '2026-09-04', time: null, datetime: '2026-09-04' });
assert.equal(latestSignal([...events, { day: '2026-09-05', time: '26:00' }]).time, null);
const card = { company: 'Mahindra & Mahindra', ticker: 'M&M', sector: 'Automobiles', insight: 'Heavy trading with selling', confluence: [{ short: 'News behind it' }], events };
for (const q of ['', '  ', 'MAHINDRA', 'm&m', 'lithium SUPPLY', 'mahindra agreement', 'corporate announcements', 'selling', 'news behind', '2026-09-04', 'automobiles']) {
  assert(matchesSearch(card, q), `matches ${q}`);
}
assert(!matchesSearch(card, 'unrelated bank'));
assert(!matchesSearch(card, 'mahindra missing-keyword'));
console.log('PASS: AI alert search, source date precision, IST rollover, invalid dates and calendar ages across timezones.');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { rankReport } = await import('../public/js/data/ai-alerts.js');
const sizeHoldings = [
  { ticker: 'LARGE', name: 'Large holding', weightPct: 20 },
  { ticker: 'SMALL', name: 'Small holding', weightPct: 5 },
  { ticker: null, name: 'Fund with no research symbol', weightPct: 75 },
];
const feeds = ['earnings', 'announcements', 'insider'].map(id => ({ id, status: 'ok', reachesToday: true }));
const report = { day: '2026-09-04', scope: 'portfolio', feeds, events: ['LARGE', 'SMALL'].flatMap(ticker => feeds.map(({ id }) => ({
  id: `${ticker}-${id}`, ticker, company: ticker, feed: id, day: '2026-09-04', headline: `${ticker} ${id} signal`,
  importance: 'high', direction: ticker === 'SMALL' ? 'negative' : 'positive',
}))) };
const sizes = { sizes: { complete: true, basis: 'listed-market-value' }, holdings: sizeHoldings };
const bySize = rankReport(report, { holdings: sizeHoldings, positionSizes: sizes });
assert.equal(bySize.cards[0].ticker, 'LARGE');
assert.equal(bySize.cards[0].holdingWeightPct, 20, 'unmatched funds stay in the percentage denominator');
assert(bySize.cards[0].score < bySize.cards[1].score, 'size ordering leaves evidence priority intact');
const byPriority = rankReport(report, { holdings: sizeHoldings });
assert.equal(byPriority.cards[0].ticker, 'SMALL', 'public identities cannot activate size ordering');
assert(byPriority.cards.every(c => c.holdingWeightPct === null));
assert.equal(rankReport({ ...report, scope: 'universe' }, { holdings: sizeHoldings, positionSizes: sizes }).cards[0].ticker, 'SMALL');
assert.equal(rankReport(report, { holdings: sizeHoldings, positionSizes: { sizes: { complete: false } } }).cards[0].ticker, 'SMALL');
console.log('PASS: authenticated size ordering, evidence priority preservation, unmatched denominator and missing-size fallback.');
