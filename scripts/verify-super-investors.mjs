import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalisePortfolio, classifyHolding, deriveMoves, filedPair, isFiledQuarter, quarterOrder, canonicalQuarter } from '../public/js/data/finology-shared.js';
import { summariseQuarter } from '../public/js/data/investor-quarterly.js';
import { fetchInvestorPortfolio, call, REQ_TIMEOUT_MS, PATIENT_TIMEOUT_MS, PATIENT_DEADLINE_MS } from '../worker/finology.mjs';
import { withTag } from '../worker/http.mjs';

const now = Date.now;
Date.now = () => Date.parse('2026-09-06T00:00:00Z');
const quarters = ['Jun 2026', 'Mar 2026'];
const row = (company = 'Example Ltd.', companySlug = 'EXAMPLE', latest = 2, prior = 1, valueCr = 10) =>
  ({ company, companySlug, quarterlyHoldings: { 'Jun 2026': latest, 'Mar 2026': prior }, valueCr });
const book = (slug, holdings, qs = quarters) => normalisePortfolio({ slug, name: slug, quarters: qs, holdings }, slug);
const action = (holding) => classifyHolding(book('one', [holding]).holdings[0], ...quarters)?.action;
try {
  assert.equal(quarterOrder('2026-13'), null);
  // The source's period headings gained a trailing "%" on 30 September 2026 ("Sep 2026%"). The unit
  // is not part of the period: the same quarters, the same cells, the same comparisons.
  for (const [label, canonical] of [['Sep 2026%', 'Sep 2026'], ['Jun 2026 %', 'Jun 2026'], ['Mar 26 (%)', 'Mar 26'], ['Holding %', 'Holding %'], ['%', '%']]) {
    assert.equal(canonicalQuarter(label), canonical, label);
  }
  assert.equal(quarterOrder('Jun 2026%'), 202606);
  assert.equal(isFiledQuarter('Jun 2026%'), true);
  const decorated = normalisePortfolio({ slug: 'pct', name: 'pct', quarters: ['Mar 2026%', 'Jun 2026%'], holdings: [
    { company: 'Example Ltd.', companySlug: 'EXAMPLE', quarterlyHoldings: { 'Jun 2026%': 2, 'Mar 2026%': '1' }, valueCr: 10 },
    { company: 'Due Ltd.', companySlug: 'DUE', quarterlyHoldings: { 'Jun 2026%': 'Filing Due', 'Mar 2026%': 1.5 }, valueCr: 5 },
  ] }, 'pct');
  assert.deepEqual(decorated.quarters, ['Jun 2026', 'Mar 2026'], 'percent-labelled headings are read as the same periods');
  assert.deepEqual(decorated.filedQuarters, ['Jun 2026', 'Mar 2026']);
  assert.deepEqual(decorated.holdings[0].quarterlyHoldings, { 'Jun 2026': 2, 'Mar 2026': 1 }, 'cells under a decorated heading are kept');
  assert.equal(decorated.holdings[1].quarterlyStatus['Jun 2026'], 'filing_due', "the source's own note under a decorated heading is kept");
  assert.equal(classifyHolding(decorated.holdings[0], ...filedPair(decorated.quarters)).action, 'added');
  assert.deepEqual(normalisePortfolio(JSON.parse(JSON.stringify(decorated)), 'pct'), decorated, 'a normalised decorated book is stable');
  const mixed = normalisePortfolio({ slug: 'mix', quarters: ['Jun 2026', 'Jun 2026%'], holdings: [
    { company: 'Both', quarterlyHoldings: { 'Jun 2026': 3, 'Jun 2026%': 9 } }] }, 'mix');
  assert.deepEqual(mixed.quarters, ['Jun 2026'], 'one period printed both ways is one column');
  assert.equal(mixed.holdings[0].quarterlyHoldings['Jun 2026'], 3, 'the undecorated cell wins where both exist');
  for (const q of ['Sep 2026', 'Dec 2026', 'Jun 2027', 'Aug 2026', 'unknown', '2026-00']) assert.equal(isFiledQuarter(q), false, q);
  assert.equal(isFiledQuarter('Jun 2026'), true);
  assert.equal(isFiledQuarter('Jun 2026', Date.parse('2026-06-30T12:00:00Z')), false);
  assert.equal(isFiledQuarter('Jun 2026', Date.parse('2026-07-01T00:00:00Z')), true);
  assert.deepEqual(filedPair(['Mar 26', 'Jun 2026', 'Sep 2026']), ['Jun 2026', 'Mar 26']);
  assert.deepEqual(filedPair(['Jun 2026', 'Dec 2025']), ['Jun 2026', null]);
  assert.equal(deriveMoves(book('gap', [row()], ['Jun 2026', 'Dec 2025'])).comparable, false);
  assert.equal(action(row('Example', 'X', 1.3, 1)), 'added');
  assert.equal(action(row('Example', 'X', 1, 1.3)), 'trimmed');
  assert.equal(action(row('Example', 'X', 1, 1)), 'held');
  assert.equal(action(row('Example', 'X', 1, '-')), 'new');
  assert.equal(action(row('Example', 'X', '-', 1, 0)), 'exited');
  assert.equal(action(row('Example', 'X', null, 1, null)), 'unknown');
  assert.equal(action(row('Example', 'X', null, 1, 10)), 'unknown');
  for (const invalid of [true, false, -1, 101, 'N/A', 'Filing Due', {}, 'Pending']) {
    assert.equal(action(row('Example', 'X', invalid, 1, 0)), ['Filing Due', 'Pending'].includes(invalid) ? 'awaiting' : 'unknown', String(invalid));
    assert.equal(action(row('Example', 'X', 1, invalid, 10)), ['Filing Due', 'Pending'].includes(invalid) ? 'awaiting' : 'unknown', `prior ${String(invalid)}`);
  }
  const absent = row(); delete absent.quarterlyHoldings['Mar 2026'];
  assert.equal(action(absent), 'unknown');
  const body = { quarters, holdings: [row('Example', 'X', 'Filing Due', 1, 0)] };
  for (const bad of [{ slug: 'wrong-investor', quarters, holdings: [] }, {}, { quarters, holdings: null }, { quarters, holdings: [{}] }, { ok: false, quarters, holdings: [] }]) {
    await assert.rejects(fetchInvestorPortfolio(async () => Response.json(bad), 'local-fixture', 'one', 'https://fixture.invalid'), { code: 'shape' });
  }
  const workerBook = await fetchInvestorPortfolio(async () => Response.json(body), 'local-fixture', 'one', 'https://fixture.invalid');
  const firstCheck = Date.now();
  Date.now = () => firstCheck + 6 * 3600000;
  const recheckedBook = await fetchInvestorPortfolio(async () => Response.json(body), 'local-fixture', 'one', 'https://fixture.invalid');
  assert.notEqual(withTag(workerBook).tag, withTag(recheckedBook).tag, 'successful unchanged source checks update the cache validator');
  assert.equal(normalisePortfolio(recheckedBook, 'one').sourceCheckedAt, recheckedBook.sourceCheckedAt);
  // THE CAPTURE'S PATIENT RETRY gets one long attempt; a reader keeps the thirteen-second deadline.
  {
    let clock = 0;
    const flaky = () => { let n = 0; return async () => { clock += 20000; if (++n === 1) throw new TypeError('fetch failed'); return Response.json(body); }; };
    await assert.rejects(call(flaky(), 'local-fixture', '/super-investors/one', 'https://fixture.invalid', { now: () => clock }), { code: 'unreachable' },
      "a reader's deadline is spent after one slow failure");
    clock = 0;
    assert.ok(await call(flaky(), 'local-fixture', '/super-investors/one', 'https://fixture.invalid', { now: () => clock, timeoutMs: PATIENT_TIMEOUT_MS, deadlineMs: PATIENT_DEADLINE_MS }),
      'the patient budget leaves room to try again');
    const slow = (ms) => (url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(body)), ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    });
    const patientBook = await fetchInvestorPortfolio(slow(REQ_TIMEOUT_MS + 500), 'local-fixture', 'one', 'https://fixture.invalid', { patient: true });
    assert.equal(patientBook.holdings.length, 1, "a book slower than a reader's six seconds is read by the patient retry");
  }
  Date.now = () => firstCheck;
  let cached = workerBook;
  for (let i = 0; i < 4; i++) cached = normalisePortfolio(JSON.parse(JSON.stringify(cached)), 'one');
  assert.equal(cached.holdings[0].quarterlyNotes['Jun 2026'], 'Filing Due');
  assert.equal(deriveMoves(cached).moves[0].action, 'awaiting');
  assert.deepEqual(normalisePortfolio(cached, 'one'), cached, 'normalisation is idempotent');
  const conflict = book('one', [row(), row('Example renamed', 'EXAMPLE', 4)]);
  assert.equal(conflict.holdings.length, 1);
  assert.equal(deriveMoves(conflict).moves[0].action, 'unknown');
  const duplicate = book('one', [row(), row()]);
  assert.equal(duplicate.holdings.length, 1);
  assert.equal(summariseQuarter([duplicate]).consensusBuyCount, 0, 'duplicate rows are not two investors');
  const second = book('two', [row('Renamed Example Limited', 'example', 3, 2)]);
  let q = summariseQuarter([duplicate, second, duplicate]);
  assert.equal(q.consensusBuyCount, 1, 'stable identifier joins different display names');
  assert.equal(q.consensusBuys[0].count, 2, 'duplicate books do not add votes');
  assert.equal(q.consensusBuys[0].sumPp, 2);
  q = summariseQuarter([duplicate, book('new', [row('Example', 'EXAMPLE', 1.2, '-')])]);
  assert.equal(q.consensusBuys[0].sumPp, null, 'mixed disclosure/size changes have no complete delta');
  const old = book('old', [{ company: 'Example', companySlug: 'EXAMPLE', quarterlyHoldings: { 'Jun 2025': 2, 'Mar 2025': 1 }, valueCr: 10 }], ['Jun 2025', 'Mar 2025']);
  q = summariseQuarter([duplicate, old]);
  assert.equal(q.consensusBuyCount, 0, 'different quarter pairs never create shared activity');
  assert.equal(q.comparableBooks, 1);
  assert.equal(q.excludedBooks.length, 1);
  q = summariseQuarter([duplicate, second], { include: () => false, investors: [{ slug: 'one' }, { slug: 'two' }, { slug: 'missing' }] });
  assert.equal(q.total, 0, 'empty scope stays empty');
  assert.equal(q.missingBooks, 1);
  assert.equal(q.consensusBuyCount, 0);
  assert.equal(summariseQuarter([book('held', [row('Example', 'X', 1, 1)])]).contributingBooks, 0, 'unchanged books do not count as changed');
  Date.now = now;
  const fixture = JSON.parse(readFileSync(new URL('../public/data/super-investors.json', import.meta.url)));
  const actual = summariseQuarter(Object.entries(fixture.books).map(([slug, b]) => normalisePortfolio(b, slug)), { investors: fixture.investors, limit: Infinity });
  // This is a changing source capture, not a fixture promising 100% upstream availability.
  // A declared timeout must stay visible as missing data, not block unrelated news publication.
  // Undeclared omissions, duplicate identities and unknown books still fail the contract.
  const expectedSlugs = new Set(fixture.investors.map(i => i.slug));
  assert.equal(expectedSlugs.size, fixture.investors.length);
  for (const slug of Object.keys(fixture.books)) assert(expectedSlugs.has(slug), `unexpected investor book: ${slug}`);
  const missingSlugs = [...expectedSlugs].filter(slug => !Object.hasOwn(fixture.books, slug));
  for (const slug of missingSlugs) assert.equal(typeof fixture.failed?.[slug]?.reason, 'string', `undeclared missing investor book: ${slug}`);
  assert.equal(actual.loadedBooks, Object.keys(fixture.books).length);
  assert.equal(actual.missingBooks, missingSlugs.length);
  assert.equal(actual.loadedBooks + actual.missingBooks, fixture.investors.length);
  assert(actual.pairs.length <= 1);
  const observed = summariseQuarter([
    book('adia', [row('Aavas Financiers Ltd.', 'AAVAS', 2.13, 1.65)]),
    book('mit', [row('Aavas Financiers Ltd.', 'AAVAS', 1.10, null)]),
  ]);
  assert.equal(observed.consensusBuyCount, 0, 'An unconfirmed prior quarter cannot establish a second investor increase');
  assert.equal(observed.counts.unknown, 1);
  assert(actual.consensusBuys.every((c) => new Set(c.investors.map((i) => i.slug)).size === c.count));
  console.log(JSON.stringify({ status: 'passed', books: actual.loadedBooks, missingBooks: actual.missingBooks, comparable: actual.comparableBooks, excluded: actual.excludedBooks.length, sharedCompanies: actual.consensusBuyCount, counts: actual.counts }));
} finally { Date.now = now; }
