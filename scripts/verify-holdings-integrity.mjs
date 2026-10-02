import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalisePortfolio, deriveMoves, summarise, comparisonPeriods, quarterOrder } from '../public/js/data/finology-shared.js';
import { assessCoverage, withVerifiedEntities } from '../public/js/data/holdings-integrity.js';
import { matchedDeals } from '../public/js/data/investor-changes.js';
import { validateBook, assembleSnapshot, retainHistory } from './lib/investor-snapshot.mjs';

const today = '2026-09-09', fetchedAt = `${today}T00:00:00Z`;
const raw = { ok: true, slug: 'example', fetchedAt, quarters: ['Mar 2026', 'Aug 2026', 'Jun 2026'], holdings: [
  { company: 'Increasing', companySlug: 'increasing', quarterlyHoldings: { 'Aug 2026': 'Filing Due', 'Jun 2026': 4, 'Mar 2026': 3 }, valueCr: 0 },
  { company: 'Missing', quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 2 } },
  { company: 'Explicit absence', quarterlyHoldings: { 'Jun 2026': '-', 'Mar 2026': 2 } },
  { company: 'Awaited', quarterlyHoldings: { 'Jun 2026': 'Filing Awaited', 'Mar 2026': 2 } },
  { company: 'Off-cycle', quarterlyHoldings: { 'Aug 2026': 1 }, valueCr: 100 },
] };
const book = normalisePortfolio(raw, raw.slug);
assert.equal('fetchedAt' in normalisePortfolio({ ...raw, fetchedAt: null }, raw.slug), false, 'raw normalization must not overwrite the Worker response capture time with null');
assert.equal(book.holdings[0].quarterlyStatus['Aug 2026'], 'filing_due');
assert.equal(normalisePortfolio(book, book.slug).holdings[0].quarterlyStatus['Aug 2026'], 'filing_due', 'normalization must preserve source status through caches');
const changes = deriveMoves(book, today);
assert.equal(changes.latest, 'Jun 2026'); assert.equal(changes.prior, 'Mar 2026');
assert.equal(changes.moves.find((m) => m.company === 'Increasing').deltaPp, 1);
assert.equal(changes.moves.find((m) => m.company === 'Missing').action, 'unknown');
assert.equal(changes.moves.find((m) => m.company === 'Explicit absence').action, 'exited');
assert.equal(changes.moves.find((m) => m.company === 'Awaited').action, 'awaiting');
assert.equal(changes.moves.find((m) => m.company === 'Off-cycle'), undefined);
assert.equal(summarise(book, today).disclosedCount, 1);
assert.equal(summarise(book, today).valueCr, null, 'positive holding plus zero source valuation is unavailable');
assert.equal(summarise(book, today).offCycleCount, 1);
assert.equal(comparisonPeriods({ quarters: ['Sep 2026', 'Jun 2026', 'Dec 2025'] }, today).comparable, false, 'open and non-adjacent quarters cannot be compared');
assert.equal(quarterOrder('2026-13'), null);
assert.throws(() => validateBook({ ...raw, stale: true }, raw.slug));
assert.throws(() => validateBook({ ...raw, holdings: [] }, raw.slug, raw));
assert.throws(() => validateBook({ ...raw, slug: 'someone-else' }, raw.slug));
assert.throws(() => validateBook({ ...raw, fetchedAt: '2026-01-01' }, raw.slug, raw));
// A book the source publishes nothing for is read as that answer — unless something says otherwise.
const emptyRetained = { ...raw, quarters: [], holdings: [], totalStocks: null };
const emptyAgain = { ...emptyRetained, fetchedAt: '2026-09-10T00:00:00Z' };
assert.equal(validateBook(emptyAgain, raw.slug, emptyRetained), emptyAgain, 'a book empty on every read may be read empty again');
assert.equal(validateBook(emptyAgain, raw.slug), emptyAgain, 'a book never captured may be read as publishing nothing');
assert.throws(() => validateBook(emptyAgain, raw.slug, raw), /portfolio shape/, 'a populated book read empty is still refused');
assert.throws(() => validateBook({ ...emptyAgain, totalStocks: 3 }, raw.slug, emptyRetained), 'a source that counts stocks overrides an empty table');
assert.throws(() => validateBook({ ...emptyAgain, holdings: raw.holdings }, raw.slug, emptyRetained), 'holdings without periods are still refused');
assert.throws(() => validateBook({ ...emptyAgain, fetchedAt: '2026-09-08T00:00:00Z' }, raw.slug, emptyRetained), 'an older empty answer is still older');
assert.deepEqual(assembleSnapshot({ list: { investors: [{ slug: raw.slug, name: 'Example' }] }, books: { [raw.slug]: emptyAgain }, failed: {},
  previous: { books: { [raw.slug]: emptyRetained } }, capturedAt: '2026-09-10T00:00:00Z' }).books[raw.slug].holdings, [], 'an empty book stays empty in the snapshot');

const list = { investors: [{ slug: 'example', name: 'Example investor' }, { slug: 'unavailable', name: 'Unavailable investor' }] };
const previous = { books: { example: raw } }, failed = { example: { message: 'outage' }, unavailable: { message: 'outage' } };
const retained = assembleSnapshot({ list, books: {}, failed, previous, capturedAt: '2026-09-10T00:00:00Z' });
assert.equal(retained.books.example.fetchedAt, fetchedAt);
assert.equal(retained.failedCount, 2); assert.equal(retained.refreshed, 0); assert.equal(retained.covered, 1);
assert.deepEqual(retained.retained, ['example']);
assert.equal(retained.lastAttempt, undefined, 'no attempt recorded is no attempt claimed');
const attempted = assembleSnapshot({ list, books: {}, failed, previous, capturedAt: '2026-09-10T00:00:00Z',
  attempt: { at: '2026-09-10T00:00:00Z', listError: 'upstream — /super-investors returned HTTP 502', refreshed: 0, failed: 2 } });
assert.equal(attempted.lastAttempt.listError, 'upstream — /super-investors returned HTTP 502');
assert.equal(attempted.books.example.fetchedAt, fetchedAt, 'a failed attempt moves no book read time');
assert.equal(assembleSnapshot({ list, books: {}, failed, previous: attempted, capturedAt: '2026-09-11T00:00:00Z' }).lastAttempt.at, '2026-09-10T00:00:00Z', 'the last recorded attempt survives a run that records none');
const historical = retainHistory({ ...raw, quarters: ['Sep 2026', 'Jun 2026'], holdings: [raw.holdings[0]] }, raw);
assert(historical.quarters.includes('Mar 2026'));
assert.equal(historical.holdings[0].quarterlyHoldings['Mar 2026'], 3);
// From 30 September 2026 the source prints "Jun 2026%". It is the same period: the capture accepts
// the book and folds it into the retained history without a second column for any quarter.
const percent = (label) => `${label}%`;
const decoratedRaw = { ...raw, fetchedAt: '2026-09-10T00:00:00Z', quarters: ['Sep 2026', 'Jun 2026'].map(percent), holdings: [
  { ...raw.holdings[0], quarterlyHoldings: { 'Sep 2026%': 'Filing Due', 'Jun 2026%': 5 } }] };
assert.equal(validateBook(decoratedRaw, raw.slug, raw), decoratedRaw, 'percent-labelled periods are valid periods');
const decoratedHistory = retainHistory(decoratedRaw, raw);
assert.deepEqual(decoratedHistory.quarters, ['Sep 2026', 'Aug 2026', 'Jun 2026', 'Mar 2026']);
assert.equal(decoratedHistory.holdings[0].quarterlyHoldings['Jun 2026'], 5, 'the newer read replaces the same period');
assert.equal(decoratedHistory.holdings[0].quarterlyHoldings['Mar 2026'], 3, 'older periods are retained under their canonical labels');
assert.equal(decoratedHistory.holdings[0].quarterlyStatus['Sep 2026'], 'filing_due');

const report = assessCoverage({ snapshot: { ...retained, capturedAt: '2026-10-01' }, now: '2026-10-01T00:00:00Z',
  managers: { syncedAt: '2026-10-01', managers: [{ id: 'pms', name: 'PMS', kind: 'pms', asOf: '2026-07-31', statements: [{}] },
    { id: 'aif', name: 'Fund', kind: 'aif', asOf: '2026-10-01' }] } });
assert.equal(report.total, 2, 'Only public investor books belong to this coverage review');
assert(report.rows[0].issues.includes('Source check overdue'), 'a fresh file cannot rejuvenate an old source check');
assert(!report.rows.some((r) => r.issues.some((s) => /statement.*needed|portfolio feed needed/i.test(s))), 'customer document requests are outside this feature');
assert.equal(report.complete, false);

const evidence = { relations: [{ entityId: 'fixture-fund', legalName: 'Singularity Equity Fund I', investorSlugs: ['madhusudan-kela'], sourceUrl: 'https://example.test/official-team', verifiedAt: today }] };
const people = withVerifiedEntities([{ id: 'madhusudan-kela', name: 'Madhusudan Kela' }], evidence, 'investor', today);
const deal = { ticker: 'TIL', date: today, cells: { 'Trade Category': 'Bulk deal', Insider: 'Singularity Equity Fund I', Transaction: 'Buy', 'Trade Shares': '100' } };
const match = matchedDeals([deal], people)[0];
assert.equal(match.reportedName, 'Singularity Equity Fund I');
assert.equal(match.personId, 'madhusudan-kela');
assert.equal(matchedDeals([{ ...deal, cells: { ...deal.cells, Insider: 'Singularity Equity Fund II' } }], people).length, 0);
assert.equal(matchedDeals([deal], [...people, { id: 'ambiguous', name: 'Singularity Equity Fund I' }]).length, 0);
const snapshot = JSON.parse(readFileSync(new URL('../public/data/super-investors.json', import.meta.url)));
for (const b of Object.values(snapshot.books)) {
  const comparison = deriveMoves(normalisePortfolio(b, b.slug), today);
  if (comparison.comparable) assert([3, 6, 9, 12].includes(quarterOrder(comparison.latest) % 100));
  assert(comparison.moves.every((m) => m.action !== 'exited' || m.nowStatus === 'not_disclosed'));
}
// Exercise the browser cache entry points: recently cached bytes may have an older source date.
const store = await import('../public/js/core/store.js');
const cacheFeed = await import('../public/js/data/super-investors.js');
const serverList = { ok: true, investors: [list.investors[0]] };
store.writeEntry(store.KEYS.investorList, { value: serverList });
store.writeEntry(store.KEYS.investorBook('example'), { value: { ...raw, fetchedAt: '2026-09-01T00:00:00Z' }, savedAt: Date.now() });
let serverSnapshot = { ...serverList, capturedAt: fetchedAt, books: { example: raw } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (path) => String(path) === 'data/super-investors.json' ? Response.json(serverSnapshot)
  : String(path) === 'api/super-investors' ? Response.json(serverList) : Response.json({ ok: false }, { status: 503 });
try {
  await cacheFeed.load();
  assert.equal(cacheFeed.book('example').fetchedAt, fetchedAt, 'a newer snapshot supersedes an older source read on the device');
  serverSnapshot = { ...serverList, capturedAt: '2026-09-10T00:00:00Z', books: {}, failed: { example: { reason: 'test-outage' } } };
  await cacheFeed.refreshSnapshot();
  assert(cacheFeed.book('example'), 'partial snapshot must not erase a cached portfolio');
  assert.equal(cacheFeed.book('example').fetchedAt, fetchedAt);
  // A retained book whose latest check failed is a FRESHNESS condition, not a gap: `failureFor`
  // answers "there is nothing to show" and would report a book being drawn as unreadable, so the
  // failure stays visible through `uncheckedFor` and the coverage audit reads both.
  assert.equal(cacheFeed.uncheckedFor('example').reason, 'test-outage');
  assert.equal(cacheFeed.failureFor('example'), null, 'a book on screen is never reported as a gap');
  serverSnapshot = { ...serverSnapshot, capturedAt: '2026-09-11T00:00:00Z', investors: [{ slug: 'new-entry', name: 'New Entry' }], books: {} };
  await cacheFeed.refreshSnapshot();
  assert(cacheFeed.list().some((i) => i.slug === 'example'), 'a directory omission retains the known investor and history');
  assert(cacheFeed.book('example').quarters.includes('Mar 2026'));
  await cacheFeed.loadBook('example', { force: true });
  assert(cacheFeed.book('example'), 'a live outage must not erase a cached portfolio');
  assert(cacheFeed.uncheckedFor('example'), 'a failed revalidation of a retained book remains visible');
  const rolled = { ...raw, fetchedAt: '2026-10-01T00:00:00Z', quarters: ['Sep 2026', 'Jun 2026'], holdings: [{ ...raw.holdings[0], quarterlyHoldings: { 'Sep 2026': 5, 'Jun 2026': 4 } }] };
  globalThis.fetch = async () => Response.json(rolled);
  await cacheFeed.loadBook('example', { force: true });
  assert(cacheFeed.book('example').quarters.includes('Mar 2026'), 'live revalidation preserves older captured columns');
  assert.equal(cacheFeed.book('example').holdings[0].quarterlyHoldings['Mar 2026'], 3);
  const saved = await store.readEntry(store.KEYS.investorBook('example'));
  assert(saved.value.quarters.includes('Mar 2026'), 'retained live history survives device reload');

} finally { globalThis.fetch = realFetch; }
console.log('PASS holdings integrity: partial months, source states, unknown gaps, zero valuations, completed adjacent quarters, retained failures/history, source age and strict legal-entity attribution');
