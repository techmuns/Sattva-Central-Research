#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { assertSafeCorporateActionReplacement, corporateActionType, corporateActionKey, normaliseNseCorporateActions, parseNseActionDate, validateScreenerActionRows } from '../public/js/data/corporate-actions-shared.js';
import { createCorporateActionsFeed, filterCorporateActionsByScope } from '../public/js/data/corporate-actions.js';

assert.equal(parseNseActionDate('04-Sep-2026'), '2026-09-04');
assert.equal(parseNseActionDate('29-Feb-2024'), '2024-02-29');
assert.equal(parseNseActionDate('29-Feb-2023'), null);
assert.equal(parseNseActionDate('-'), null);
assert.equal(corporateActionType('Bonus 1:1'), 'bonus');
assert.equal(corporateActionType('Rights 2:5'), 'rights');
assert.equal(corporateActionType('Stock Split From Rs.10/- to Rs.2/-'), 'split');
assert.equal(corporateActionType('Buy Back'), 'buyback');
assert.equal(corporateActionType('Income Distribution (InvIT)'), 'distribution');
assert.equal(corporateActionType('Interim Dividend - Rs 3'), 'dividend');
assert.equal(corporateActionType('Demerger'), 'demerger');
assert.equal(corporateActionType('Interest Payment'), 'interest');
assert.equal(corporateActionType('Redemption'), 'redemption');
assert.equal(corporateActionType('Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share'), 'capital-reduction');
assert.equal(corporateActionType('Interimdividend - Re 0.50 Per Share'), 'dividend');

const raw = [
  { symbol: 'ALPHA', comp: 'Alpha Ltd', isin: 'INE000A01001', series: 'EQ', subject: 'Interim Dividend - Rs 3', faceVal: '10', exDate: '04-Sep-2026', recDate: '05-Sep-2026', bcStartDate: '-', bcEndDate: '-' },
  { symbol: 'ALPHA', comp: 'Alpha Ltd', isin: 'INE000A01001', series: 'EQ', subject: 'Interim Dividend - Rs 3', faceVal: '10', exDate: '04-Sep-2026', recDate: '05-Sep-2026' },
  { symbol: 'BETA', comp: 'Beta Ltd', isin: 'INE000B01000', series: 'EQ', subject: 'Bonus 1:1', faceVal: '2', exDate: '10-Sep-2026', recDate: '10-Sep-2026' },
  { symbol: 'AGMCO', comp: 'AGM Co', isin: 'INE000D01008', series: 'EQ', subject: 'Annual General Meeting', faceVal: '2', exDate: '10-Sep-2026', recDate: '10-Sep-2026' },
];
const normalised = normaliseNseCorporateActions(raw);
assert.equal(normalised.rows.length, 2, 'identical exchange rows are deduplicated');
assert.equal(normalised.duplicates, 1);
assert.equal(normalised.excludedMeetings, 1);
assert.equal(normalised.rows[0].ticker, 'BETA', 'newest ex date sorts first');
assert.match(normalised.rows[0].sourceUrl, /nseindia\.com/);
assert.equal(normalised.rows[1].id, corporateActionKey(normalised.rows[1]));
assert.deepEqual(filterCorporateActionsByScope(normalised.rows, 'portfolio', [{ ticker: 'OLD-BETA', isin: 'INE000B01000' }]).map((row) => row.ticker), ['BETA'], 'ISIN keeps renamed portfolio symbols connected');

const priorLarge = { version: 1, rows: Array.from({ length: 120 }, (_, index) => ({ ticker: `OLD${index}` })) };
assert.throws(
  () => assertSafeCorporateActionReplacement({ rows: Array.from({ length: 50 }, (_, index) => ({ ticker: `NEW${index}` })) }, priorLarge),
  /shrank abnormally/,
  'a syntactically valid partial response cannot erase retained history',
);
assert.doesNotThrow(() => assertSafeCorporateActionReplacement({ rows: priorLarge.rows.slice(0, 100) }, priorLarge));

const capture = {
  version: 1, capturedAt: '2026-09-04T18:00:00.000Z', requestedFrom: '2023-09-05', requestedTo: '2027-09-04',
  companyCount: 2, typeCounts: { bonus: 1, dividend: 1 }, rows: normalised.rows,
};
const newer = {
  ...capture, capturedAt: '2026-09-04T19:00:00.000Z', companyCount: 3,
  rows: [...capture.rows, { ...capture.rows[0], ticker: 'GAMMA', company: 'Gamma Ltd', isin: 'INE000C01009', purpose: 'Rights 1:2', actionType: 'rights', id: 'gamma-rights' }],
};
const network = [null, { status: 200, checkedAt: 3, value: newer }];
const feed = createCorporateActionsFeed({
  now: () => 4,
  readSaved: async () => ({ savedAt: 1, value: capture }),
  read: async () => network.shift(),
});
await feed.load();
await feed.refresh(); // join the cache-first load's background check
assert.equal(feed.rows().length, 2, 'a network failure retains the last stored snapshot');
assert.match(feed.meta().degraded, /retained copy/);
const refreshed = await feed.refresh();
assert.equal(refreshed.added, 1);
assert.equal(feed.rows().length, 3);
assert.deepEqual(feed.filterByScope(feed.rows(), 'portfolio', [{ ticker: 'GAMMA' }]).map((row) => row.ticker), ['GAMMA'], 'new portfolio symbols are selected from the same exchange-wide capture');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const staleCheck = deferred();
let reads = 0;
let savedReads = 0;
const instant = createCorporateActionsFeed({
  readSaved: async () => { savedReads += 1; return { savedAt: 1, value: capture }; },
  read: () => { reads += 1; return staleCheck.promise; },
});
const cached = await Promise.race([instant.load(), new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Cached load waited for the network')), 250);
  timer.unref();
})]);
assert.equal(cached.rows.length, 2);
assert.equal(instant.isLoaded(), true);
assert.equal(instant.meta().checking, true);
assert.equal(instant.meta().origin, 'store');
const poll = instant.refresh();
assert.equal(instant.refresh(), poll, 'manual/live/load checks share one in-flight request');
await instant.load();
assert.equal(reads, 1);
assert.equal(savedReads, 1);
staleCheck.resolve({ status: 200, value: newer, checkedAt: 10 });
await poll;
assert.equal(instant.meta().checking, false);
assert.equal(instant.rows().length, 3, 'new rows publish after the retained first paint');

let response = { status: 200, value: capture, checkedAt: 20 };
const durable = createCorporateActionsFeed({ readSaved: async () => null, read: async () => response, now: () => 50 });
await durable.load();
const originalRows = durable.rows();
response = { status: 200, value: structuredClone(capture), checkedAt: 21 };
await durable.refresh();
assert.equal(durable.rows(), originalRows, 'identical 200 preserves table identity');
response = { status: 304, value: response.value, checkedAt: 22 };
await durable.refresh();
assert.equal(durable.rows(), originalRows, '304 preserves table identity');
assert.equal(durable.meta().checkedAt, 22);
for (const value of [null, { ...capture, rows: [] }, { ...capture, rows: [...capture.rows, {}] },
  { ...capture, rowCount: 1 }, { ...capture, capturedAt: '2026-09-03T00:00:00Z' }]) {
  response = { status: 200, value, checkedAt: 30 };
  assert.equal((await durable.refresh()).failed, 1);
  assert.equal(durable.rows(), originalRows, 'failed, partial or older payload cannot erase retained rows');
  assert.equal(durable.meta().checkedAt, 22, 'failure cannot advance the last successful check');
  assert.equal(durable.meta().attemptedAt, 50);
}
response = { status: 200, value: newer, checkedAt: 40 };
assert.equal((await durable.refresh()).added, 1);
assert.equal(durable.meta().degraded, null);

// Neither a late disk read nor a late network result may resurrect invalidated state.
for (const stage of ['disk', 'network']) {
  const waiting = deferred();
  const guarded = createCorporateActionsFeed({
    readSaved: () => stage === 'disk' ? waiting.promise : Promise.resolve(null),
    read: () => stage === 'network' ? waiting.promise : Promise.resolve({ status: 200, value: capture }),
  });
  const loading = guarded.load();
  await new Promise(setImmediate);
  guarded.invalidate();
  waiting.resolve(stage === 'disk' ? { value: capture } : { status: 200, value: capture });
  await loading;
  assert.equal(guarded.isLoaded(), false);
  assert.deepEqual(guarded.rows(), []);
}
const unavailableStorage = createCorporateActionsFeed({ readSaved: async () => { throw new Error('disabled'); }, read: async () => ({ status: 200, value: capture }) });
assert.equal((await unavailableStorage.load()).rows.length, 2, 'first visits still load all records when storage is unavailable');

if (process.argv[2]) {
  const body = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  assert.equal(body.version, 1);
  assert.ok(Date.parse(body.capturedAt));
  assert.ok(Array.isArray(body.rows) && body.rows.length > 0);
  assert.equal(body.rowCount, body.rows.length);
  assert.equal(body.companyCount, new Set(body.rows.map((row) => row.ticker || `screener:${row.screener?.companyKey || row.company}`)).size);
  const screener = [];
  for (const row of body.rows) {
    assert.equal(row.id, corporateActionKey(row));
    assert.ok((row.ticker || row.screener?.companyKey) && row.company && row.purpose);
    assert.ok(Object.hasOwn(row, 'exDate') && Object.hasOwn(row, 'recordDate'));
    const sources = row.sources || [row.source];
    assert.ok(sources.every((source) => ['NSE', 'Screener'].includes(source)));
    if (sources.includes('NSE')) assert.match(row.sourceUrl, /^https:\/\/www\.nseindia\.com\//);
    if (sources.includes('Screener')) {
      assert.ok(row.screener);
      assert.match(row.screenerUrl, /^https:\/\/www\.screener\.in\/actions\//);
      screener.push(row.screener);
    }
  }
  validateScreenerActionRows([...new Map(screener.map((row) => [row.id, row])).values()]);
}

console.log('PASS corporate actions parsing, retention, refresh and dynamic portfolio scope');
