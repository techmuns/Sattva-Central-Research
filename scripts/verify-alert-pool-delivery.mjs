// Small, offline proof that selective delivery changes bytes, never feed answers or history.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writePoolMembers, verifyPoolMembers } from './lib/alert-pool-build.mjs';
import { POOL_FEEDS, POOL_FEED_CAPTURES, feedMember, isPoolMember } from '../public/js/data/alert-pool-shared.js';
import { read, resetForTest, fullRecord } from '../public/js/data/alert-pool.js';

const day = '2026-09-24', older = '2026-09-23', outDir = mkdtempSync(join(tmpdir(), 'pool-delivery-'));
const originalFetch = globalThis.fetch;
const sourceFeeds = POOL_FEEDS.map(id => ({ id, status: 'ok', count: 10, events: Array.from({ length: 10 }, (_, i) => ({
  id: `${id}:${i}`, feed: id, day: i % 2 ? older : day, ticker: 'ALPHA', company: 'Alpha Limited', headline: `${id} original ${i}`,
  url: `https://example.test/${id}/${i}`, sourceRecord: { company: 'Alpha Limited', original: i,
    detail: ['news', 'insider'].includes(id) ? 'Retained complete original evidence. '.repeat(1000) : 'Original detail' },
})) }));
const captures = Object.fromEntries([...new Set(Object.values(POOL_FEED_CAPTURES).flat())].map(name =>
  [name, name === 'exchangeDeals' ? { artifactId: 42 } : { revision: 'original' }]));
let servedIndex, status, corrupt = false, calls = [], bytes = 0;
try {
  const index = writePoolMembers({ outDir, sourceFeeds, day, now: Date.parse(`${day}T12:00:00Z`), book: [], newsMeta: {}, captures });
  verifyPoolMembers({ outDir, sourceFeeds, index });
  servedIndex = index; status = structuredClone(captures);
  globalThis.fetch = async input => {
    const path = String(input);
    if (path === 'api/alert-pool/index') return Response.json({ ...servedIndex, artifact: 7 });
    if (path === 'api/capture-status') return Response.json({ captures: status });
    const member = path.replace('api/alert-pool/7/', '');
    assert(isPoolMember(member), `unexpected request ${path}`);
    calls.push(member);
    const raw = gunzipSync(readFileSync(join(outDir, member))); bytes += raw.length;
    const body = JSON.parse(raw);
    if (corrupt && member.includes('.technicals.')) body.feeds = {};
    return Response.json(body);
  };
  const options = { mode: 'window', day, queryWindow: { from: older, to: day, includeUndated: false } };
  resetForTest();
  const complete = await read(options), fullBytes = bytes;
  assert.equal(complete.feeds.size, POOL_FEEDS.length);
  status.companyNews.revision = 'corrected'; status.exchangeDeals.artifactId++;
  calls = [];
  const held = await read({ ...options, refresh: true });
  assert.equal(calls.length, 0, 'already-held complete members need no selective downloads');
  for (const [id, feed] of held.feeds) assert.deepEqual(feed, complete.feeds.get(id));
  resetForTest(); calls = []; bytes = 0;
  const selective = await read(options), selectiveBytes = bytes;
  assert.deepEqual([...selective.declined.keys()], ['insider', 'news']);
  assert(calls.length && calls.every(member => /\.(technicals|announcements|market-news)\.json\.gz$/.test(member)),
    'no declined feed or complete member is downloaded');
  for (const [id, feed] of selective.feeds) assert.deepEqual(feed, complete.feeds.get(id), `${id}: every event, field and source status survives`);
  assert(selectiveBytes < fullBytes / 10, 'a large declined feed does not dominate the remaining download');
  assert.deepEqual(await fullRecord(complete.feeds.get('news').events[0]), sourceFeeds.find(f => f.id === 'news').events[0].sourceRecord,
    'the original complete member still supplies full bookmark evidence');

  for (const mode of ['window', 'ai']) {
    resetForTest(); servedIndex = index;
    const split = await read({ ...options, mode });
    servedIndex = { ...index, days: index.days.map(({ feedMembers, ...entry }) => entry), ai: index.ai.map(({ feedMembers, ...entry }) => entry) };
    resetForTest();
    const legacy = await read({ ...options, mode });
    assert.deepEqual([...split.feeds], [...legacy.feeds], `${mode}: old artifacts and new selective artifacts answer identically`);
  }
  servedIndex = structuredClone(index);
  delete servedIndex.days.at(-1).feedMembers.technicals;
  resetForTest(); calls = [];
  assert.deepEqual([...(await read(options)).feeds], [...selective.feeds], 'incomplete optional descriptors fall back to the complete member');
  assert(calls.includes(index.days.at(-1).member));
  servedIndex = index; corrupt = true; resetForTest();
  await assert.rejects(read(options), /exactly technicals/, 'a missing requested feed is a failure, never a successful empty answer');
  assert.throws(() => feedMember(index.days[0].member, 'private'));
  assert(!isPoolMember('days/2026-09-24.private.json.gz'));
  console.log(`PASS selective delivery: ${fullBytes} -> ${selectiveBytes} decoded bytes; exact fields, legacy artifacts, empty days, failed members and full evidence preserved.`);
} finally { globalThis.fetch = originalFetch; resetForTest(); rmSync(outDir, { recursive: true, force: true }); }
