#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compactObservations, compactNewsData } from './compact-news-data.mjs';
import { writeNewsJson, readNewsJson } from './lib/news-json-storage.mjs';
import { verifyAssetSizes } from './partition-news-data.mjs';

const row = { ticker: 'KISSHT', entityId: 'isin:INE12F801023', title: 'OnEMI Technology coverage',
  source: 'The Economic Times', url: 'https://example.test/onemi', summary: 'Original source text', date: '2026-09-04' };
const old = { ...row, firstSeenAt: '2026-09-04T07:00:00Z', lastSeenAt: '2026-09-04T07:00:00Z', query: 'Kissht' };
const next = { ...row, firstSeenAt: '2026-09-05T07:00:00Z', lastSeenAt: '2026-09-05T07:00:00Z', query: 'OnEMI Technology' };
const corrected = { ...next, title: 'OnEMI Technology corrected source headline' };
const unlinked = { ticker: 'KISSHT', summary: 'Distinct unlinked source text' };
const compact = compactObservations([old, next, corrected, unlinked, { ...unlinked, summary: 'Different text' }]);
assert.equal(compact.length, 4);
assert.equal(compact[0].firstSeenAt, old.firstSeenAt);
assert.equal(compact[0].lastSeenAt, next.lastSeenAt);
assert.deepEqual(compact[0].matchedQueries, ['Kissht', 'OnEMI Technology']);
assert.deepEqual(compactObservations(compact), compact, 'maintenance is idempotent');
assert(compact.some(r => r.title === corrected.title), 'different content at the same URL is retained');
const offset = { ...old, firstSeenAt: '2026-09-04T09:00:00+05:30', lastSeenAt: '2026-09-04T06:00:00-04:00' };
const range = compactObservations([old, offset])[0];
assert.equal(range.firstSeenAt, offset.firstSeenAt, 'first observation compares actual instants across UTC offsets');
assert.equal(range.lastSeenAt, offset.lastSeenAt, 'last observation keeps the original timestamp spelling');
assert.deepEqual(compactObservations([range]), [range]);
for (const malformed of [null, undefined, 'source text', 123, [], { ...old, firstSeenAt: 'yesterday' },
  { ...old, lastSeenAt: 123 }, { ...old, query: 123 }, { ...old, matchedQueries: 'Kissht' }, { ...old, matchedQueries: [123] }]) {
  assert.throws(() => compactObservations([old, malformed]), /observation/i, 'malformed records/provenance fail without rewriting content');
}
assert.throws(() => compactObservations({ articles: [] }), /array/);
const directory = mkdtempSync(join(tmpdir(), 'news-maintenance-'));
try {
  const data = join(directory, 'data');
  writeNewsJson(join(data, 'news.json'), { capturedAt: '2026-09-05T08:00:00Z', rowCount: 3,
    byTicker: { KISSHT: [old, next, corrected], OTHER: [{ ...old, ticker: 'OTHER' }] },
    archive: { index: 'company-news/index.json', articleCount: 3 } }, { maxBytes: 1024 });
  const partsDirectory = join(data, 'news.parts');
  assert(readdirSync(partsDirectory).some(name => /^[a-f0-9]{64}\.json$/.test(name)), 'fixture begins as a partitioned head');
  writeNewsJson(join(partsDirectory, 'operator-note.json'), { note: 'not a generated fragment' });
  writeNewsJson(join(data, 'company-news/2026-09.json'), { capturedAt: 'unchanged', articles: [old, next, corrected], articleCount: 3 });
  writeNewsJson(join(data, 'company-news/index.json'), { updatedAt: 'unchanged', articleCount: 3,
    queries: { Kissht: { lastSuccessAt: 'unchanged' } }, archive: [{ file: 'company-news/2026-09.json', count: 3 }] });
  const headBefore = readNewsJson(join(data, 'news.json'));
  assert.equal(compactNewsData(data)[0].duplicates, 1);
  assert.deepEqual(readNewsJson(join(data, 'news.json')), headBefore, 'read-only audit never mutates files');
  const archiveBefore = readNewsJson(join(data, 'company-news/2026-09.json'));
  writeNewsJson(join(data, 'company-news/2026-09.json'), { ...archiveBefore, articles: [...archiveBefore.articles, null] });
  assert.throws(() => compactNewsData(data, { write: true }), /observation/);
  assert.deepEqual(readNewsJson(join(data, 'news.json')), headBefore, 'a malformed later month is rejected before any earlier head write');
  writeNewsJson(join(data, 'company-news/2026-09.json'), archiveBefore);
  compactNewsData(data, { write: true });
  const head = readNewsJson(join(data, 'news.json')), index = readNewsJson(join(data, 'company-news/index.json'));
  assert.equal(head.byTicker.KISSHT.length, 2);
  assert.equal(head.byTicker.OTHER.length, 1, 'identical story in another company bucket stays');
  assert.deepEqual(readdirSync(partsDirectory), ['operator-note.json'], 'verified inline downsizing only prunes obsolete generated fragment names');
  assert.deepEqual(readNewsJson(join(partsDirectory, 'operator-note.json')), { note: 'not a generated fragment' });
  assert.equal(head.capturedAt, headBefore.capturedAt, 'compaction cannot advance freshness');
  assert.equal(index.updatedAt, 'unchanged');
  assert.equal(index.queries.Kissht.lastSuccessAt, 'unchanged');
  assert.equal(index.articleCount, 2);
  assert.equal(head.archive.articleCount, 2);
  assert.equal(index.archive[0].count, 2);
  assert(compactNewsData(data, { write: true }).every(r => r.duplicates === 0));
  const capacity = verifyAssetSizes(directory);
  assert.equal(capacity.fileBudget, 20000);
  assert.equal(capacity.remainingFiles + capacity.files, capacity.fileBudget);
  assert(capacity.bytes > 0 && capacity.largestBytes > 0);
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log('PASS news maintenance: identical observations only, preserved corrections/query history/time ranges, unchanged freshness, exact archive counts and capacity headroom.');
