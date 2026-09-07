#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNewsJson, writeNewsJson } from './lib/news-json-storage.mjs';
import { hydrateJsonShards, shardSpec } from '../public/js/core/json-shards.js';
import { conditionalJson, readEntry, writeEntry, clearAll } from '../public/js/core/store.js';
import { checkNewsPublication } from './check-news-publication.mjs';
import { withNewsHistory } from '../public/js/data/news-history.js';

const dir = mkdtempSync(join(tmpdir(), 'sattva-news-publication-'));
const originalFetch = globalThis.fetch;
try {
  const path = join(dir, 'news.json');
  const row = n => ({ title: `Company update ${n} - ₹ ₹ 日本語`, url: `https://example.test/${n}`,
    date: '2026-08-01', publishedAt: null, summary: 'Source text '.repeat(60), nested: { nullValue: null, array: [1, 2] } });
  const before = { capturedAt: '2026-09-07T04:00:00Z', rowCount: 440, empty: ['EMPTY'], failed: {},
    byTicker: { ALPHA: Array.from({ length: 240 }, (_, n) => row(n)), 'ISIN:PRIVATE': Array.from({ length: 200 }, (_, n) => row(n+240)), EMPTY: [] } };
  writeNewsJson(path, before, { maxBytes: 64 * 1024 });
  const manifest = JSON.parse(readFileSync(path));
  assert(shardSpec(manifest).parts.length > 2);
  assert.deepEqual(readNewsJson(path), before, 'all fields, order, Unicode, tickerless records and history preserved');
  const calls = [];
  let unavailable = null, tag = 'v1';
  const fetcher = async input => {
    const relative = String(input).replace(/^https:\/\/fixture.test\/data\//, '');
    calls.push(relative);
    if (relative === unavailable) return new Response('', { status: 503 });
    try { return new Response(readFileSync(join(dir, relative)), { headers: { etag: relative === 'news.json' ? tag : relative } }); }
    catch { return new Response('', { status: 404 }); }
  };
  assert.deepEqual(await hydrateJsonShards(manifest, 'news.json', { fetcher }), before);
  globalThis.fetch = fetcher;
  const first = await conditionalJson('news.json', { key: 'news-test' });
  assert.deepEqual(first.value, before);
  await writeEntry('news-test', { tag, value: manifest, savedAt: Date.now() });
  assert.deepEqual((await conditionalJson('news.json', { key: 'news-test' })).value, before,
    'a pre-upgrade client caching a bare manifest cannot poison the matching-ETag cache');
  const count = calls.length;
  assert.equal((await conditionalJson('news.json', { key: 'news-test' })).status, 304);
  assert.equal(calls.length, count+1, 'unchanged manifest does not re-download its parts');
  const after = { ...before, capturedAt: '2026-09-07T05:00:00Z', byTicker: { ...before.byTicker, ALPHA: [...before.byTicker.ALPHA, row(999)] } };
  writeNewsJson(path, after, { maxBytes: 64 * 1024 });
  const newer = JSON.parse(readFileSync(path));
  unavailable = newer._jsonShards.parts.at(-1).file; tag = 'v2';
  assert.equal((await conditionalJson('news.json', { key: 'news-test', optional: true })).value, null);
  assert.deepEqual((await readEntry('news-test')).value, before, 'partial refresh cannot replace last-good rows or ETag');
  unavailable = null;
  assert.deepEqual((await conditionalJson('news.json', { key: 'news-test' })).value, after, 'recovery brings the new row without losing old rows');
  const part = newer._jsonShards.parts[0], partPath = join(dir, part.file), bytes = readFileSync(partPath);
  writeFileSync(partPath, bytes.toString().replace('Company update', 'Changed update'));
  assert.throws(() => readNewsJson(path, {}), /integrity/);
  await assert.rejects(hydrateJsonShards(newer, 'news.json', { fetcher }), /count|integrity/);
  writeFileSync(partPath, bytes);
  assert.throws(() => shardSpec({ ...newer, _jsonShards: { ...newer._jsonShards, rows: 1 } }), /count/);
  await assert.rejects(hydrateJsonShards({ ...newer, _jsonShards: { ...newer._jsonShards,
    parts: [{ ...part, file: '../outside.json' }] } }, 'news.json', { fetcher }), /reference/);
  assert.throws(() => writeNewsJson(path, { byTicker: { ALPHA: [{ text: 'x'.repeat(100000) }] } }, { maxBytes: 65536 }), /record exceeds/);
  assert.deepEqual(readNewsJson(path), after, 'oversize single row fails before manifest replacement');
  writeNewsJson(join(dir, 'month.json'), { month: '2026-08', articles: before.byTicker.ALPHA }, { maxBytes: 65536 });
  assert.deepEqual(readNewsJson(join(dir, 'month.json')).articles, before.byTicker.ALPHA);
  mkdirSync(join(dir, 'tradingview-news'));
  writeNewsJson(join(dir, 'tradingview-news/latest.json'), { capturedAt: after.capturedAt, byTicker: {} });
  writeNewsJson(join(dir, 'market-news.json'), { capturedAt: after.capturedAt, articles: [] });
  const options = { dataDir: dir, base: 'https://fixture.test', fetcher, now: Date.parse(after.capturedAt)+60000 };
  assert.equal((await checkNewsPublication(options)).ok, true);
  const behind = await checkNewsPublication({ ...options, fetcher: async url => String(url).endsWith('/news.json') ? Response.json(before) : fetcher(url) });
  assert(behind.findings.some(f => f.code === 'capture-not-published'), 'successful capture cannot conceal an old live deployment');
  unavailable = newer._jsonShards.parts[0].file;
  assert.equal((await checkNewsPublication(options)).ok, false, 'reachable manifest alone is not publication success');
  let archiveFails = false, indexRevision = 1, headRows = [{ ...row(1), ticker: 'ALPHA' }], notifyBase = () => {};
  const oldStory = { ...row(800), ticker: 'ALPHA', entityId: 'ticker:ALPHA', date: '2020-01-01' };
  const base = { rows: () => headRows, meta: () => ({ ok: true, archive: { index: 'company-news/index.json' } }),
    seed: async () => {}, load: async () => {}, refresh: async () => ({}), refreshSnapshot: async () => ({ available: true }),
    onChange: fn => { notifyBase = fn; return () => {}; }, wasAskedEmpty: () => true, invalidate() {} };
  const history = withNewsHistory(base, { read: async path => {
    if (path.endsWith('/index.json')) return { tag: String(indexRevision), value: { archive: [{ file: 'company-news/2020-01.json', count: 1 }] } };
    if (archiveFails) throw Error('Offline');
    return { value: { articles: [oldStory] } };
  } });
  await history.seed();
  assert(history.rows().some(r => r.url === oldStory.url), 'customer readers include records older than the recent head');
  assert.equal(history.wasAskedEmpty('ALPHA'), false, 'historical evidence is not labelled an empty company search');
  const off = history.onChange(() => {});
  archiveFails = true; indexRevision++;
  assert.equal((await history.refreshSnapshot()).partial, true);
  assert(history.rows().some(r => r.url === oldStory.url), 'failed history refresh retains previously loaded history');
  assert(history.meta().newsHistory.error);
  archiveFails = false; notifyBase(); await history.loadArchive();
  assert.equal(history.meta().newsHistory.error, null);
  off();
  history.invalidate(); assert.equal(history.rows().length, 1, 'portfolio invalidation clears adopted history');
  console.log('PASS lossless split, complete hydration, corruption/missing-part refusal, cache recovery and end-to-end publication checks.');
} finally {
  globalThis.fetch = originalFetch;
  await clearAll();
  rmSync(dir, { recursive: true, force: true });
}
