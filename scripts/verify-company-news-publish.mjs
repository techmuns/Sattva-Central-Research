#!/usr/bin/env node
// Pure offline semantic reconciliation fixtures. No provider reads, GitHub or production writes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { mergeCaptureData, mergeQueryCheckpoint } from './lib/company-news-publish.mjs';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';
import { withNewsHistory } from '../public/js/data/news-history.js';

const scratch = mkdtempSync(join(tmpdir(), 'company-news-merge-fixture-'));
const oldAt = '2026-09-07T06:00:00Z', mainAt = '2026-09-07T07:00:00Z', newAt = '2026-09-07T08:00:00Z';
const entity = (id, fields = {}) => ({ entityId: id, key: id, ticker: id, name: id, queries: [id], ...fields });
const A = entity('A', { aliases: ['Reviewed main alias'], officialPages: ['https://example.test/ir'] });
const EXIT = entity('EXIT'), NEW = entity('NEW'), LIVE = entity('LIVE');
const row = (id, fields = {}) => ({ entityId: 'A', ticker: 'A', title: `Fixture ${id}`, source: 'Economic Times',
  url: `https://example.test/${id}`, date: '2026-09-07', firstSeenAt: oldAt, lastSeenAt: oldAt, ...fields });
const good = at => ({ lastAttemptAt: at, lastSuccessAt: at, coveredThrough: '2026-09-07', error: null });
const read = (dir, file) => readNewsJson(join(dir, file));
const digest = dir => {
  const entries = [];
  const walk = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), `${key}/`);
      else entries.push([key, createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex')]);
    }
  };
  walk(dir); return entries;
};
function capture(name, { entities, rows, archived = [], at, queries = {}, discovery = null, extraBuckets = {}, maxBytes } = {}) {
  const dir = join(scratch, name); mkdirSync(dir, { recursive: true });
  const byTicker = Object.fromEntries([['A', rows], ...Object.entries(extraBuckets)]);
  writeNewsJson(join(dir, 'news.json'), { capturedAt: at, newsUpdatedAt: at, from: '2026-08-08', entities,
    byTicker, empty: [], queryCoverage: { planned: 2, succeeded: 2, failed: 0 }, archive: { index: 'company-news/index.json' } }, maxBytes ? { maxBytes } : {});
  const months = new Map();
  for (const item of archived) {
    const month = item.date?.slice(0, 7) || 'undated';
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(item);
  }
  const archive = [];
  for (const [month, articles] of months) {
    const file = `company-news/${month}.json`;
    writeNewsJson(join(dir, file), { month, articles, capturedAt: oldAt, updatedAt: oldAt }, maxBytes ? { maxBytes } : {});
    archive.push({ month, file, count: articles.length });
  }
  writeNewsJson(join(dir, 'company-news/index.json'), { createdAt: oldAt, updatedAt: at, entities, queries, archive,
    articleCount: archived.length });
  if (discovery) writeNewsJson(join(dir, 'company-news/discovery.json'), discovery);
  return dir;
}
const allArchive = dir => read(dir, 'company-news/index.json').archive.flatMap(part => read(dir, part.file).articles);

try {
  const pendingBaseline = { from: '2026-08-01', to: '2026-08-02' };
  const pendingMain = { from: '2026-08-04', to: '2026-08-04' };
  const pendingCapture = { from: '2026-08-10', to: '2026-08-10' };
  const checkpoint = { ...good(oldAt), lastAttemptAt: oldAt, pending: [pendingBaseline],
    range: { from: '2026-08-01', to: '2026-09-07' }, error: 'incomplete-discovery' };
  const current = { ...checkpoint, lastAttemptAt: mainAt, pending: [pendingBaseline, pendingMain] };
  const incoming = { ...checkpoint, lastAttemptAt: newAt, pending: [pendingCapture] };
  assert.deepEqual(mergeQueryCheckpoint(current, incoming).pending, [pendingCapture, pendingBaseline, pendingMain],
    'a broad envelope without baseline cannot clear unseen branch-divergent work');
  assert.deepEqual(mergeQueryCheckpoint(current, incoming, checkpoint).pending, [pendingCapture, pendingMain],
    'verified result may remove baseline work, never a target-only pending interval');
  const failed = mergeQueryCheckpoint(current, { lastAttemptAt: newAt, error: 'read-failed', range: incoming.range }, checkpoint);
  assert.equal(failed.lastSuccessAt, oldAt); assert.equal(failed.error, 'read-failed');
  assert.deepEqual(failed.pending, current.pending, 'a failed attempt without a partition result cannot clear pending work');
  const completed = { ...good(newAt), range: incoming.range, pending: [] };
  assert.deepEqual(mergeQueryCheckpoint(current, completed, checkpoint).pending, [pendingMain]);
  assert.equal(mergeQueryCheckpoint(current, completed, checkpoint).error, 'incomplete-discovery');
  assert.deepEqual(mergeQueryCheckpoint(checkpoint, completed, checkpoint).pending, []);

  const baselineA = entity('A', { aliases: ['Old baseline alias'], officialPages: ['https://example.test/ir'] });
  const baselineIndex = { entities: [baselineA, EXIT], queries: { A: { A: checkpoint }, EXIT: { EXIT: good(oldAt) } } };
  const baselineDiscovery = { queries: { 'A|ALL|A': checkpoint }, pages: {}, documents: {} };
  const page = 'A|https://example.test/ir';
  const discovery = (at, pending) => ({ queries: { 'A|ALL|A': pending }, pages: { [page]: good(at) }, documents: {},
    coverage: { capturedAt: at, plannedQueries: 1, staleOrIncompleteQueries: 0, pagesFailed: 0, documentsPending: 0 } });
  const duplicateMain = row('same', { query: 'A', matchedQueries: ['A'], lastSeenAt: mainAt });
  const duplicateCapture = row('same', { query: 'alias', matchedQueries: ['alias'], firstSeenAt: '2026-09-07T05:00:00Z', lastSeenAt: newAt });
  const historical = row('old-head', { date: '2026-07-10' });
  const document = row('document.pdf', { discoverySource: 'official-ir', date: null });
  const target = capture('target', { entities: [A, NEW], at: mainAt,
    rows: [row('main'), duplicateMain, historical], archived: [row('archive-main'), document],
    queries: { A: { A: good(mainAt) }, NEW: {} }, discovery: discovery(mainAt, current) });
  const source = capture('source', { entities: [entity('A', { aliases: ['Stale capture alias'] }), EXIT, LIVE], at: newAt,
    rows: [row('capture'), duplicateCapture, row('same', { title: 'Corrected headline at identical URL' })],
    archived: [row('archive-source')], queries: { A: { A: good(newAt) }, EXIT: { EXIT: good(newAt) }, LIVE: { LIVE: good(newAt) } },
    extraBuckets: JSON.parse('{"__proto__":[]}'), discovery: discovery(newAt, incoming) });
  const sourceBefore = digest(source);
  const report = mergeCaptureData(source, target, { baselineIndex, baselineDiscovery });
  const head = read(target, 'news.json'), index = read(target, 'company-news/index.json'), retained = allArchive(target);
  assert.equal(report.capturedAt, newAt); assert.equal(head.newsUpdatedAt, newAt);
  assert.deepEqual(index.entities.map(item => item.entityId), ['A', 'LIVE', 'NEW']);
  assert.deepEqual(index.entities.find(item => item.entityId === 'A').aliases, ['Reviewed main alias']);
  assert.ok(index.historicalEntities.some(item => item.entityId === 'EXIT'));
  assert.ok(Object.hasOwn(head.byTicker, '__proto__'), 'arbitrary bucket keys remain own JSON properties');
  assert.equal(head.byTicker.A.some(item => item.url === historical.url), false, 'aged records do not grow the recent head');
  assert.ok(retained.some(item => item.url === historical.url), 'aged head observations survive permanently');
  for (const id of ['main', 'capture', 'archive-main', 'archive-source']) assert.ok(retained.some(item => item.url === row(id).url));
  const same = retained.filter(item => item.url === row('same').url);
  assert.equal(same.length, 2, 'same-URL content corrections remain separate source observations');
  const original = same.find(item => item.title === row('same').title);
  assert.equal(original.firstSeenAt, duplicateCapture.firstSeenAt); assert.equal(original.lastSeenAt, newAt);
  assert.deepEqual(new Set(original.matchedQueries), new Set(['A', 'alias']));
  assert.equal(head.queryCoverage.publicationUnverifiedQueries, 1, 'new current-main identity is not falsely reported checked');
  const combinedDiscovery = read(target, 'company-news/discovery.json');
  assert.deepEqual(combinedDiscovery.queries['A|ALL|A'].pending, [pendingCapture, pendingMain]);
  assert.equal(combinedDiscovery.coverage.documentsPending, 1, 'target-only unread IR document is not hidden by newer scalar zero');
  assert.equal(read(target, 'company-news/2026-09.json').capturedAt, newAt, 'archive clock includes newly retained head capture');
  assert.deepEqual(digest(source), sourceBefore, 'capture source bytes are immutable');
  const payloadBefore = [head, index, allArchive(target), combinedDiscovery];
  mergeCaptureData(source, target, { baselineIndex, baselineDiscovery });
  assert.deepEqual([read(target, 'news.json'), read(target, 'company-news/index.json'), allArchive(target), read(target, 'company-news/discovery.json')],
    payloadBefore, 'repeated merge is logically idempotent including incomplete coverage counts');

  const recovery = capture('recovery', { entities: [A, NEW], rows: [], at: newAt, queries: { A: { A: good(newAt) } } });
  mergeCaptureData(source, recovery);
  assert.deepEqual(read(recovery, 'company-news/index.json').entities.map(item => item.entityId), ['A', 'NEW'],
    'artifact recovery without baseline does not guess a new active book');
  const recoveryBefore = read(recovery, 'news.json');
  mergeCaptureData(source, recovery);
  assert.deepEqual(read(recovery, 'news.json').queryCoverage, recoveryBefore.queryCoverage);
  const targetNewer = read(recovery, 'news.json');
  targetNewer.capturedAt = '2026-09-07T09:00:00Z';
  writeNewsJson(join(recovery, 'news.json'), targetNewer);
  mergeCaptureData(source, recovery);
  assert.deepEqual(read(recovery, 'news.json').queryCoverage, recoveryBefore.queryCoverage,
    'a reconciled newer target cannot turn its unverified query into an assumed captured-plan success');
  const unlisted = entity('LISTING', { ticker: null, key: 'ISIN:LISTING', queries: ['Old listing name'] });
  const listed = entity('LISTING', { ticker: 'NEWLIST', key: 'NEWLIST', queries: ['New listing name', 'NEWLIST'] });
  const listingMain = capture('listing-main', { entities: [unlisted], rows: [], at: mainAt });
  const listingCapture = capture('listing-capture', { entities: [listed], rows: [], at: newAt,
    queries: { LISTING: { 'New listing name': good(newAt), NEWLIST: { lastAttemptAt: newAt, error: 'provider-failed' } } } });
  const failedHead = read(listingCapture, 'news.json');
  failedHead.queryCoverage = { planned: 2, succeeded: 1, failed: 1 };
  writeNewsJson(join(listingCapture, 'news.json'), failedHead);
  mergeCaptureData(listingCapture, listingMain, { baselineIndex: { entities: [unlisted], queries: {} } });
  assert.deepEqual(read(listingMain, 'company-news/index.json').entities, [listed], 'existing ISIN adopts a live listing when main fields were unchanged');
  assert.deepEqual(read(listingMain, 'news.json').queryCoverage, failedHead.queryCoverage,
    'a failed query already counted in the captured plan is not counted twice');
  // Actual customer archive adapter chooses the newest observed content even when correcting a
  // publication date moves the record into an older month. Both raw versions remain retained.
  const olderCorrection = row('corrected-date', { title: 'Original headline', date: '2026-08-10', lastSeenAt: oldAt });
  const newerCorrection = row('corrected-date', { title: 'Corrected archived headline', date: '2026-07-10', lastSeenAt: newAt });
  const correctionArchive = capture('correction-archive', { entities: [A], rows: [], archived: [olderCorrection, newerCorrection], at: newAt });
  let currentRows = [newerCorrection];
  const history = withNewsHistory({ rows: () => currentRows, meta: () => ({ ok: true, archive: { index: 'company-news/index.json' } }),
    onChange: () => () => {}, invalidate() {} }, { read: async path => ({ value: read(correctionArchive, path.replace(/^data\//, '')), tag: newAt }) });
  await history.loadArchive();
  assert.equal(history.rows().length, 1);
  assert.equal(history.rows()[0].title, newerCorrection.title);
  currentRows = [];
  assert.equal(history.rows()[0].title, newerCorrection.title, 'new correction remains canonical after head eviction and cross-month history load');
  currentRows = [{ ...newerCorrection, title: 'Unstamped current head', firstSeenAt: undefined, lastSeenAt: undefined }];
  assert.equal(history.rows()[0].title, 'Unstamped current head', 'without observed time, preserve existing current-head precedence');
  assert.equal(allArchive(correctionArchive).length, 2, 'presentation deduplication never deletes original observations');
  const symlink = join(scratch, 'source-link'); symlinkSync(source, symlink);
  assert.throws(() => mergeCaptureData(source, symlink), /separate/);

  // Content-addressed part failures must abort before any valid target file is written.
  const many = Array.from({ length: 45 }, (_, i) => row(`sharded-${i}`, { summary: 'x'.repeat(100) }));
  const sharded = capture('sharded', { entities: [A], rows: many, archived: many, at: newAt, maxBytes: 8192 });
  const manifest = JSON.parse(readFileSync(join(sharded, 'company-news/2026-09.json'), 'utf8'));
  assert.ok(manifest._jsonShards?.parts.length > 1);
  const validTarget = capture('valid-target', { entities: [A], rows: [row('safe')], at: mainAt });
  const before = digest(validTarget);
  unlinkSync(join(sharded, 'company-news', manifest._jsonShards.parts[0].file));
  assert.throws(() => mergeCaptureData(sharded, validTarget), /ENOENT/);
  assert.deepEqual(digest(validTarget), before, 'missing source part cannot partially modify target');
  console.log('PASS: company-news semantic publication preserves content, pending work, current identities, clocks and bounded heads.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
