#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mergeLastGoodFilings } from './lib/filings-snapshot.mjs';
import { cleanAnnouncementText } from '../worker/bse-ann.mjs';

const current = {
  capturedAt: '2026-09-02T13:30:00.000Z',
  byTicker: { fresh: [{ id: 'new' }], ARRAYEMPTY: [], OVERLAP: [{ id: 'row-wins' }], MALFORMED: {} },
  empty: ['NOWEMPTY', 'OVERLAP'],
  failed: {
    KEEPROWS: { reason: 'timeout' },
    KEEPEMPTY: { reason: 'upstream' },
    NEVER: { reason: 'timeout' },
    FRESH: { reason: 'must-be-discarded' },
  },
  headers: ['A'],
};

const previous = {
  capturedAt: '2026-09-01T13:30:00.000Z',
  byTicker: {
    FRESH: [{ id: 'old' }],
    KEEPROWS: [{ id: 'last-good' }],
    NOWEMPTY: [{ id: 'must-disappear' }],
  },
  empty: ['KEEPEMPTY'],
  failed: {},
};

const merged = mergeLastGoodFilings(current, previous, ['FRESH', 'ARRAYEMPTY', 'OVERLAP', 'MALFORMED', 'KEEPROWS', 'KEEPEMPTY', 'NOWEMPTY', 'NEVER', 'STOPPED']);

assert.deepEqual(merged.byTicker.FRESH, [{ id: 'new' }], 'fresh rows must win');
assert.deepEqual(merged.byTicker.KEEPROWS, [{ id: 'last-good' }], 'a failed company must retain last-good rows');
assert.equal(merged.byTicker.NOWEMPTY, undefined, 'a fresh empty answer must remove old rows');
assert(merged.empty.includes('NOWEMPTY'), 'fresh empty answers remain covered');
assert(merged.empty.includes('ARRAYEMPTY'), 'an empty row array is a confirmed empty answer');
assert(!merged.empty.includes('OVERLAP'), 'rows win over an overlapping empty marker');
assert(merged.empty.includes('KEEPEMPTY'), 'failed companies may retain a last-good empty answer');
assert.equal(merged.failed.KEEPROWS, undefined, 'a recovered company is no longer unresolved');
assert.equal(merged.failed.KEEPEMPTY, undefined, 'a recovered empty answer is no longer unresolved');
assert.equal(merged.failed.FRESH, undefined, 'a fresh answer cannot remain failed');
assert.equal(merged.failed.NEVER.reason, 'timeout', 'a company with no last-good answer stays failed');
assert.equal(merged.failed.STOPPED.reason, 'not-reached', 'a company left in the queue is explicit');
assert.equal(merged.failed.MALFORMED.reason, 'shape', 'a malformed row collection is never treated as an empty answer');
assert.equal(merged.fallbackCount, 2, 'fallback coverage is counted per company');
assert.equal(merged.freshCovered, 4, 'fresh coverage includes rows and fresh empty answers');
assert.equal(merged.covered, 6, 'coverage includes fresh and last-good answers');
assert.equal(merged.withRows, 3);
assert.equal(merged.emptyCount, 3);
assert.equal(merged.failedCount, 3);
assert.equal(merged.rowCount, 3);
assert.equal(merged.oldestDataAt, previous.capturedAt);
assert.deepEqual(current.byTicker.fresh, [{ id: 'new' }], 'the input payload must not be mutated');
assert.deepEqual(current.byTicker.ARRAYEMPTY, [], 'normalising empty arrays must not mutate the input');
assert.deepEqual(current.byTicker.MALFORMED, {}, 'rejecting malformed rows must not mutate the input');

const nextDay = mergeLastGoodFilings({
  capturedAt: '2026-09-03T13:30:00.000Z',
  byTicker: { FRESH: [{ id: 'newer' }] },
  empty: [],
  failed: { KEEPROWS: { reason: 'timeout-again' } },
}, merged, ['FRESH', 'KEEPROWS']);
assert.deepEqual(nextDay.byTicker.KEEPROWS, [{ id: 'last-good' }], 'last-good rows survive consecutive failed runs');
assert.equal(nextDay.fallback.KEEPROWS.capturedAt, previous.capturedAt, 'fallback age stays anchored to the last real answer');
assert.equal(nextDay.oldestDataAt, previous.capturedAt, 'consecutive retries must not make retained data look newer');

assert.equal(
  cleanAnnouncementText('Board meeting<BR>outcome <b>approved</b> &amp; filed'),
  'Board meeting outcome approved &amp; filed',
  'presentation tags must never leak into announcement headlines',
);

console.log('PASS resilient filings merge and announcement text cleanup');
