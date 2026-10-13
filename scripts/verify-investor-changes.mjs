import assert from 'node:assert/strict';
import { PERIODS, indiaDay, periodRange, inPeriod, matchedDeals, investorHoldings, identityIndex, preserveBulkDeals } from '../public/js/data/investor-changes.js';
import { withVerifiedEntities } from '../public/js/data/holdings-integrity.js';
import { readFileSync } from 'node:fs';


assert.deepEqual(PERIODS.map((p) => p.id), ['today', '3d', '7d', 'month', 'quarter', '6m', 'year', 'itd']);
// Indian calendar boundaries: before UTC midnight, across a year and across leap day.
for (const [stamp, today, threeFrom, sevenFrom] of [
  ['2026-09-08T18:29:59Z', '2026-09-08', '2026-09-06', '2026-09-02'],
  ['2026-09-08T18:30:00Z', '2026-09-09', '2026-09-07', '2026-09-03'],
  ['2025-12-31T20:00:00Z', '2026-01-01', '2025-12-30', '2025-12-26'],
  ['2024-02-29T20:00:00Z', '2024-03-01', '2024-02-28', '2024-02-24'],
]) {
  const now = Date.parse(stamp);
  assert.equal(indiaDay(now), today);
  for (const [id, from, days] of [['today', today, 1], ['3d', threeFrom, 3], ['7d', sevenFrom, 7], ['month', `${today.slice(0, 7)}-01`, Number(today.slice(8))]]) {
    assert.deepEqual(periodRange(id, today), { from, to: today });
    const rows = ['2020-01-01', from, today, '2030-01-01', null].map((date) => ({ date }));
    assert.deepEqual(rows.filter((row) => inPeriod(row, periodRange(id, today))), [rows[1], rows[2]]);
  }
}
assert.deepEqual(periodRange('month', '2026-09-09'), { from: '2026-09-01', to: '2026-09-09' });
assert.deepEqual(periodRange('quarter', '2026-01-02'), { from: '2026-01-01', to: '2026-01-02' });
assert.equal(periodRange('6m', '2026-08-31').from, '2026-02-28');
assert.equal(periodRange('year', '2024-02-29').from, '2023-02-28');
assert.equal(periodRange('itd', '2026-09-09').from, null);
assert.equal(inPeriod({ date: '2026-09-10' }, periodRange('itd', '2026-09-09')), false);
assert.equal(inPeriod({ date: null }, periodRange('itd')), false);

const people = [{ id: 'one', name: 'Example Asset Management Private Limited' }];
const deal = { ticker: 'EXAMPLE', date: '2026-09-01', url: 'https://www.screener.in/trades/bulk/', cells: {
  'Trade Category': 'Bulk deal', Insider: 'EXAMPLE ASSET MANAGEMENT PVT. LTD.', Transaction: 'Buy', 'Trade Shares': '10,000', Price: '50' } };
const variant = (cells) => ({ ...deal, cells: { ...deal.cells, ...cells } });
assert.equal(matchedDeals([deal], people).length, 1);
assert.equal(matchedDeals([variant({ Insider: 'Example Asset Management Pvt Ltd & Others' })], people).length, 0);
assert.equal(matchedDeals([variant({ 'Trade Category': 'Insider trade' }), variant({ 'Trade Category': 'SAST' })], people).length, 0);
assert.equal(matchedDeals([variant({ Transaction: 'Pledge' })], people).length, 0);
assert.equal(matchedDeals([deal], [...people, { id: 'two', name: people[0].name }]).length, 0);
assert.equal(identityIndex([{ id: 'one', name: 'Example', aliases: ['example'] }]).get('example').id, 'one');
const grouped = matchedDeals([deal, variant({ 'Trade Category': 'Block deal' })], people);
assert.equal(grouped.length, 2, 'bulk and block are different report types');
assert.equal(matchedDeals([deal, deal], people)[0].evidence.length, 2);
assert.equal(grouped[0].source, 'Bulk deal');
assert.equal(matchedDeals([deal, variant({ Transaction: 'Sell' })], people).length, 2);
assert.equal(matchedDeals([deal, variant({ 'Trade Shares': '20,000' })], people).length, 2);

// Relationship attribution is explicit, exact and time-limited. A group name alone never
// matches a subsidiary; all reviewed source identity survives into evidence and exports.
const evidence = JSON.parse(readFileSync(new URL('../public/data/holding-evidence.json', import.meta.url)));
const reviewedAt = evidence.relations[0].verifiedAt;
const goldman = [{ id: 'goldman-sachs', name: 'Goldman Sachs' }];
for (const relation of evidence.relations) {
  assert(relation.sourceUrl.startsWith('https://'));
  assert.equal(relation.investorSlugs[0], 'goldman-sachs');
  for (const name of [relation.legalName, ...(relation.aliases || [])]) {
    const row = variant({ Insider: name });
    assert.equal(matchedDeals([row], goldman).length, 0);
    const matches = matchedDeals([row], withVerifiedEntities(goldman, evidence, 'investor', reviewedAt));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].attribution, 'Associated entity');
    assert.equal(matches[0].reportedName, name);
    assert.equal(matches[0].relationshipUrl, relation.sourceUrl);
    assert.equal(matches[0].identityCheckedAt, relation.verifiedAt);
    assert.equal(matchedDeals([variant({ Insider: name + ' & Others' })], withVerifiedEntities(goldman, evidence, 'investor', reviewedAt)).length, 0);
    const expired = new Date(Date.parse(reviewedAt) + 91 * 86400000).toISOString();
    assert.equal(matchedDeals([row], withVerifiedEntities(goldman, evidence, 'investor', expired)).length, 0, 'expired reviews cannot attribute trades');
  }
}

const books = [{ slug: 'example', quarters: ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025'], holdings: [
  { company: 'Example', companySlug: 'EXAMPLE', quarterlyHoldings: { 'Sep 2026': 8, 'Jun 2026': 3, 'Mar 2026': 2, 'Dec 2025': null } },
  { company: 'Gone', companySlug: 'GONE', quarterlyStatus: { 'Jun 2026': 'not_disclosed' }, quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 1 } },
] }];
const observed = investorHoldings(books, [{ slug: 'example', name: 'Investor' }], '2026-09-09');
assert(observed.every((r) => r.date !== '2026-09-30'));
// EVERY COMPARISON ROW CARRIES BOTH DATES IT WAS MEASURED ON — the quarter ends of the two patterns
// — and says they are pattern dates, never a trade date, because a pattern carries none.
const example = observed.find((r) => r.company === 'Example' && r.date === '2026-06-30');
assert.deepEqual([example.from, example.date, example.dateKind, example.priorLabel, example.latestLabel], ['2026-03-31', '2026-06-30', 'pattern', 'Mar 2026', 'Jun 2026']);
assert.equal(example.sourceCheckedAt, null, 'a book with no recorded read time reports none rather than today');
assert.equal(example.tradeDate, undefined, 'a shareholding pattern never yields a trade date');
assert.equal(investorHoldings([{ ...books[0], fetchedAt: '2026-09-09T11:52:16.304Z' }], [], '2026-09-09')[0].sourceCheckedAt, '2026-09-09T11:52:16.304Z');
assert.equal(observed.find((r) => r.company === 'Example' && r.date === '2026-06-30').deltaPp, 1);
assert.equal(observed.find((r) => r.company === 'Gone').action, 'exited', 'an explicit source non-disclosure establishes a disclosure disappearance, without implying a sale');
assert.equal(observed.find((r) => r.company === 'Gone').deltaPp, null);
assert.equal(observed.filter((r) => inPeriod(r, periodRange('month', '2026-09-09'))).length, 0);


console.log('PASS public investor changes: period boundaries, identity joins, ambiguous names, duplicate evidence, failure retention, closed-quarter comparisons and separate dates');
