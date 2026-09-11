#!/usr/bin/env node
// The shared watchlist, tested where it is decided: the pure contract and the durable store.
//
// Run with `node scripts/verify-shared-watchlist.mjs`. Needs no server and no egress — the store
// runs against node:sqlite exactly as the concall summary store does, so the conflict, capacity
// and attribution branches are exercised directly rather than waited for.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  SYMBOL_RE, WATCHLIST_COMPANY_LIMIT, WATCHLIST_PEOPLE_LIMIT, WATCHLIST_TOMBSTONE_LIMIT,
  attributionLabel, companyName, isNewerWatchlist, personKey, personName, watchlistIntent, watchlistIntents,
} from '../public/js/data/watchlist-shared.js';
import { SharedWatchlistStore } from '../worker/watchlist-store.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function storage() {
  const db = new DatabaseSync(':memory:');
  return {
    // Eager, exactly as the Workers runtime is: a lazy shim would never run a CREATE TABLE,
    // because nothing calls toArray() on one.
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

let clock = Date.parse('2026-09-11T09:00:00.000Z');
const makeStore = () => new SharedWatchlistStore(storage(), { now: () => (clock += 1000) });

console.log('\n— the contract —');

test('a name is kept as typed and one person is one identity', () => {
  assert.equal(personName('  Ravi   Kumar '), 'Ravi Kumar');
  assert.equal(personKey('Ravi  KUMAR'), personKey('ravi kumar'));
  assert.notEqual(personKey('Ravi Kumar'), personKey('Priya Nair'));
});

test('a blank contributor is null, never an empty person', () => {
  for (const blank of ['', '   ', null, undefined]) assert.equal(personName(blank), null);
  assert.equal(personKey('   '), null);
});

test('an edit with no contributor is refused', () => {
  assert.throws(() => watchlistIntent({ op: 'add', ticker: 'STLTECH' }), /contributor/);
  assert.throws(() => watchlistIntent({ op: 'add', ticker: 'STLTECH', by: '  ' }), /contributor/);
});

test('a row key is not a company', () => {
  assert.ok(SYMBOL_RE.test('20MICRONS') && SYMBOL_RE.test('500325'));
  assert.throws(() => watchlistIntent({ op: 'add', ticker: 'RELIANCE|2026-08-12|3', by: 'Ravi' }), /company/);
  assert.throws(() => watchlistIntent({ op: 'add', ticker: 'A B', by: 'Ravi' }), /company/);
});

test('two edits to one company in one batch are refused rather than ordered by arrival', () => {
  assert.throws(() => watchlistIntents([
    { op: 'add', ticker: 'STLTECH', by: 'Ravi' },
    { op: 'remove', ticker: 'STLTECH', by: 'Priya' },
  ]), /Duplicate/);
});

test('a company name is never invented from the ticker', () => {
  assert.equal(companyName(''), null);
  assert.equal(companyName(null), null);
});

test('an unnumbered snapshot cannot be ordered and is taken as given', () => {
  assert.equal(isNewerWatchlist({ revision: 4 }, { revision: 3 }), true);
  assert.equal(isNewerWatchlist({ revision: 2 }, { revision: 3 }), false);
  assert.equal(isNewerWatchlist({}, { revision: 3 }), true);
});

console.log('\n— the shared store —');

test('an add is attributed and readable by everyone', () => {
  const store = makeStore();
  const { outcomes, snapshot } = store.watchlistApply([{ op: 'add', ticker: 'stltech', name: 'Sterlite Technologies Ltd.', by: 'Ravi Kumar' }]);
  assert.equal(outcomes[0].outcome, 'added');
  assert.equal(snapshot.companies.length, 1);
  assert.deepEqual(
    { ticker: snapshot.companies[0].ticker, name: snapshot.companies[0].name, addedBy: snapshot.companies[0].addedBy },
    { ticker: 'STLTECH', name: 'Sterlite Technologies Ltd.', addedBy: 'Ravi Kumar' },
  );
  assert.ok(snapshot.companies[0].addedAt, 'the server stamps when it accepted the edit');
});

test('the roster grows and offers the most recently used name first', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'AAA', by: 'Ravi Kumar' }]);
  store.watchlistApply([{ op: 'add', ticker: 'BBB', by: 'Priya Nair' }]);
  const { people } = store.watchlistSnapshot();
  assert.deepEqual(people.map((p) => p.name), ['Priya Nair', 'Ravi Kumar']);
});

test('one person typed three ways is one dropdown entry, spelt the way they last typed it', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'AAA', by: 'ravi kumar' }]);
  store.watchlistApply([{ op: 'add', ticker: 'BBB', by: 'Ravi  KUMAR' }]);
  const { people } = store.watchlistSnapshot();
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Ravi KUMAR');
  assert.equal(people[0].uses, 2);
});

test('re-starring does not reassign the credit, and a late name still lands', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'STLTECH', by: 'Ravi Kumar' }]);
  const again = store.watchlistApply([{ op: 'add', ticker: 'STLTECH', name: 'Sterlite Technologies Ltd.', by: 'Priya Nair' }]);
  assert.equal(again.outcomes[0].outcome, 'unchanged');
  assert.equal(again.snapshot.companies[0].addedBy, 'Ravi Kumar', 'whoever added it added it');
  assert.equal(again.snapshot.companies[0].name, 'Sterlite Technologies Ltd.');
  assert.ok(again.snapshot.people.some((p) => p.name === 'Priya Nair'), 'a name typed is a name remembered, even when the add was a no-op');
});

test('one device removing does not lose what another device added', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'AAA', by: 'Ravi Kumar' }]);
  // Priya's phone loaded the list when it held AAA alone, then stars BBB while Ravi removes AAA.
  store.watchlistApply([{ op: 'remove', ticker: 'AAA', by: 'Ravi Kumar' }]);
  const { snapshot } = store.watchlistApply([{ op: 'add', ticker: 'BBB', name: 'Beta Ltd', by: 'Priya Nair' }]);
  assert.deepEqual(snapshot.companies.map((c) => c.ticker), ['BBB'], 'the stale device adds a row rather than restoring the list it held');
});

test('a removal is a record, so revision moves and the company leaves the list', () => {
  const store = makeStore();
  const first = store.watchlistApply([{ op: 'add', ticker: 'AAA', by: 'Ravi Kumar' }]);
  const second = store.watchlistApply([{ op: 'remove', ticker: 'AAA', by: 'Priya Nair' }]);
  assert.equal(second.snapshot.companies.length, 0);
  assert.ok(second.snapshot.revision > first.snapshot.revision);
});

test('an unchanged batch does not move the revision, so an unchanged poll is a 304', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'AAA', by: 'Ravi Kumar' }]);
  const before = store.watchlistSnapshot().revision;
  store.watchlistApply([{ op: 'remove', ticker: 'NOTHERE', by: 'Ravi Kumar' }]);
  assert.equal(store.watchlistSnapshot().revision, before);
});

test('a company refused for capacity is reported as full, never as added', () => {
  const store = makeStore();
  for (let i = 0; i < WATCHLIST_COMPANY_LIMIT; i++) store.watchlistApply([{ op: 'add', ticker: `T${i}`, by: 'Ravi Kumar' }]);
  const { outcomes, snapshot } = store.watchlistApply([{ op: 'add', ticker: 'OVERFLOW', by: 'Ravi Kumar' }]);
  assert.equal(outcomes[0].outcome, 'full');
  assert.equal(snapshot.count, WATCHLIST_COMPANY_LIMIT);
  assert.ok(!snapshot.companies.some((c) => c.ticker === 'OVERFLOW'));
});

test('capacity frees up when something is removed', () => {
  const store = makeStore();
  for (let i = 0; i < WATCHLIST_COMPANY_LIMIT; i++) store.watchlistApply([{ op: 'add', ticker: `T${i}`, by: 'Ravi Kumar' }]);
  store.watchlistApply([{ op: 'remove', ticker: 'T0', by: 'Ravi Kumar' }]);
  const { outcomes } = store.watchlistApply([{ op: 'add', ticker: 'OVERFLOW', by: 'Ravi Kumar' }]);
  assert.equal(outcomes[0].outcome, 'added');
});

test('pruning the roster loses a suggestion and never an attribution', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'KEEP', name: 'Keep Ltd', by: 'First Person' }]);
  for (let i = 0; i < WATCHLIST_PEOPLE_LIMIT + 5; i++) store.watchlistApply([{ op: 'add', ticker: `P${i}`, by: `Person ${i}` }]);
  const snapshot = store.watchlistSnapshot();
  assert.ok(snapshot.people.length <= WATCHLIST_PEOPLE_LIMIT);
  assert.ok(!snapshot.people.some((p) => p.name === 'First Person'), 'the least recently used suggestion is dropped');
  assert.equal(snapshot.companies.find((c) => c.ticker === 'KEEP').addedBy, 'First Person', 'the row still says who added it');
});

test('tombstones are bounded and bounding them does not disturb the live list', () => {
  const store = makeStore();
  for (let i = 0; i < WATCHLIST_TOMBSTONE_LIMIT + 10; i++) {
    store.watchlistApply([{ op: 'add', ticker: `X${i}`, by: 'Ravi Kumar' }]);
    store.watchlistApply([{ op: 'remove', ticker: `X${i}`, by: 'Ravi Kumar' }]);
  }
  store.watchlistApply([{ op: 'add', ticker: 'LIVE', by: 'Ravi Kumar' }]);
  assert.deepEqual(store.watchlistSnapshot().companies.map((c) => c.ticker), ['LIVE']);
});

test('the newest addition reads first — a watchlist is a working set, not a ledger', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'FIRST', by: 'Ravi Kumar' }]);
  store.watchlistApply([{ op: 'add', ticker: 'SECOND', by: 'Ravi Kumar' }]);
  assert.deepEqual(store.watchlistSnapshot().companies.map((c) => c.ticker), ['SECOND', 'FIRST']);
});

test('a device carries its old list in without anybody being credited for it', () => {
  const store = makeStore();
  const { outcomes, snapshot } = store.watchlistApply([{ op: 'seed', ticker: 'OLD', name: 'Old Holding Ltd' }]);
  assert.equal(outcomes[0].outcome, 'added');
  assert.equal(snapshot.companies[0].addedBy, null, 'nothing recorded who, so nothing claims to');
  assert.equal(snapshot.people.length, 0, 'a seed never invents a person for the dropdown');
  assert.equal(attributionLabel(snapshot.companies[0]), 'Added before names were recorded');
});

test('a stale device CANNOT resurrect a company somebody removed', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'DROPPED', by: 'Ravi Kumar' }]);
  store.watchlistApply([{ op: 'remove', ticker: 'DROPPED', by: 'Priya Nair' }]);
  // A browser last opened before the removal still holds DROPPED locally and seeds it on load.
  const { outcomes, snapshot } = store.watchlistApply([{ op: 'seed', ticker: 'DROPPED', name: 'Dropped Ltd' }]);
  assert.equal(outcomes[0].outcome, 'unchanged');
  assert.equal(snapshot.count, 0, 'the removal stands');
});

test('a seed never overwrites a real attribution', () => {
  const store = makeStore();
  store.watchlistApply([{ op: 'add', ticker: 'AAA', name: 'Alpha Ltd', by: 'Ravi Kumar' }]);
  const { snapshot } = store.watchlistApply([{ op: 'seed', ticker: 'AAA', name: 'Alpha Ltd' }]);
  assert.equal(snapshot.companies[0].addedBy, 'Ravi Kumar');
});

test('a seed carrying a contributor field is still filed as a seed', () => {
  const store = makeStore();
  const { snapshot } = store.watchlistApply([{ op: 'seed', ticker: 'AAA', by: 'Someone At The Keyboard' }]);
  assert.equal(snapshot.companies[0].addedBy, null);
  assert.equal(snapshot.people.length, 0);
});

test('an unknown operation is refused', () => {
  assert.throws(() => watchlistIntent({ op: 'replace', ticker: 'AAA', by: 'Ravi' }), /operation/);
});

test('an oversized or empty batch is refused before anything is written', () => {
  const store = makeStore();
  assert.throws(() => store.watchlistApply([]), /batch/);
  assert.throws(() => store.watchlistApply(Array.from({ length: 60 }, (_, i) => ({ op: 'add', ticker: `T${i}`, by: 'Ravi' }))), /batch/);
  assert.equal(store.watchlistSnapshot().count, 0);
});

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${count - failures}/${count} checks\n`);
process.exit(failures ? 1 : 0);
