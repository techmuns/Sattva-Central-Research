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
assert.equal(feed.rows().length, 2, 'a network failure retains the last stored snapshot');
assert.match(feed.meta().degraded, /retained copy/);
const refreshed = await feed.refresh();
assert.equal(refreshed.added, 1);
assert.equal(feed.rows().length, 3);
assert.deepEqual(feed.filterByScope(feed.rows(), 'portfolio', [{ ticker: 'GAMMA' }]).map((row) => row.ticker), ['GAMMA'], 'new portfolio symbols are selected from the same exchange-wide capture');

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
