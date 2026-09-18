// THE ALERT POOL BUILD, AS A LIBRARY: the offline fetch that answers every route the collectors ask
// for from the committed files, the capture identities the index records, the member writer and
// the member check. `scripts/build-alert-pool.mjs` is the runner's command line over these; the
// verification suites call the same functions over the same collection, so what the tests prove
// about a pool is proven about the pool the runner publishes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { captureRevision, captureStamp, POOL_CAPTURES, POOL_FEEDS, ALERT_POOL_CONTRACT, ALERT_POOL_INDEX_MEMBER, dayMember } from '../../public/js/data/alert-pool-shared.js';
import { buildDayShards, buildAiShards, validateShard, compactAiEvent } from '../../public/js/data/alert-pool-format.js';
import { newsStateInputs, bookSignature } from '../../public/js/data/alert-pool.js';

const LIVE_ROUTES = { 'api/earnings': 'data/earnings-live.json', 'api/concalls': 'data/concall-scans.json',
  'api/nse-announcements': 'data/nse-announcements.json', 'api/ipo-filings': 'data/ipo-filings.json' };

/** A fetch answering from `root` (the public directory) and, for the bulk/block route, `exchange`. */
export function offlineFetch({ root, exchange = null, onRequest = null }) {
  return async (input) => {
    const path = String(input).split('?')[0];
    onRequest?.(path);
    if (/^https?:/.test(path)) return new Response('{}', { status: 503 });
    if (path === 'api/bulk-block-deals') {
      if (!exchange) return new Response('{}', { status: 503 });
      return new Response(exchange.text, { headers: { 'content-type': 'application/json', etag: `"exchange-${exchange.id}"` } });
    }
    const target = resolve(root, LIVE_ROUTES[path] || path);
    if (!target.startsWith(root + '/')) return new Response('{}', { status: 403 });
    try { return new Response(readFileSync(target), { headers: { 'content-type': 'application/json' } }); }
    catch { return new Response('{}', { status: 404 }); }
  };
}

/** The identity of every capture a pooled feed reads, as the index records it. */
export function captureIdentities({ root, exchange = null }) {
  const captures = {};
  for (const [name, source] of Object.entries(POOL_CAPTURES)) {
    if (source.path) {
      let body = null;
      try { body = JSON.parse(readFileSync(resolve(root, `.${source.path}`), 'utf8')); } catch { body = null; }
      captures[name] = { path: source.path, revision: captureRevision(body), capturedAt: captureStamp(body) };
    } else {
      captures[name] = { route: source.route, artifactId: exchange?.id ?? null, revision: exchange ? `exchange-${exchange.id}` : null };
    }
  }
  return captures;
}

/** What /api/capture-status would report for these files, for offline verification and fixtures. */
export function captureStatusFor({ root, exchange = null, servedAt = new Date().toISOString() }) {
  const captures = {};
  for (const [name, entry] of Object.entries(captureIdentities({ root, exchange }))) {
    captures[name] = entry.path
      ? { ok: entry.revision != null, capturedAt: entry.capturedAt, revision: entry.revision }
      : { ok: entry.artifactId != null, capturedAt: null, artifactId: entry.artifactId };
  }
  return { ok: true, captures, servedAt };
}

/** Write index.json and every shard under `outDir`; returns the index the runner uploads. */
export function writePoolMembers({ outDir, sourceFeeds, day, now, book, newsMeta, captures }) {
  const pooled = sourceFeeds.filter((feed) => POOL_FEEDS.includes(feed.id));
  assert.equal(pooled.length, POOL_FEEDS.length, 'every pooled feed must be present in the collection');
  const feeds = {};
  for (const feed of pooled) {
    const { events, ...row } = feed;
    feeds[feed.id] = { row: JSON.parse(JSON.stringify(row)) };
  }
  feeds.news.newsMeta = newsStateInputs(newsMeta);
  // A company-news event names its company from the book only when the row carries no name of
  // its own; a pool built under one book is then exact only for readers of that same book.
  feeds.news.bookDependent = pooled.find((feed) => feed.id === 'news').events
    .some((event) => !event.sourceRecord?.company && !event.attribution?.queryCompany && event.ticker);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'days'), { recursive: true });
  mkdirSync(join(outDir, 'ai'), { recursive: true });
  const write = (member, shard) => {
    const json = JSON.stringify(shard);
    const gz = gzipSync(json, { level: 9 });
    writeFileSync(join(outDir, member), gz);
    const count = Object.values(shard.feeds).reduce((n, group) => n + group.events.length, 0);
    return { member, count, bytes: gz.length, rawBytes: Buffer.byteLength(json), hash: createHash('sha256').update(gz).digest('hex') };
  };
  const days = [...buildDayShards(sourceFeeds, day).values()].map((shard) => ({ day: shard.day, ...write(dayMember(shard.day), shard) }));
  const ai = [...buildAiShards(sourceFeeds, day).entries()].map(([member, shard]) => ({ span: shard.span, from: shard.from, to: shard.to, ...write(member, shard) }));
  const index = {
    version: 1, contract: ALERT_POOL_CONTRACT, builtAt: new Date(now).toISOString(), day,
    bookSignature: bookSignature(book), pooledFeeds: POOL_FEEDS, captures, feeds, days, ai,
    sourceEvents: Object.fromEntries(pooled.map((feed) => [feed.id, feed.events.length])),
  };
  writeFileSync(join(outDir, ALERT_POOL_INDEX_MEMBER), JSON.stringify(index));
  return index;
}

export const readMember = (outDir, member) => JSON.parse(gunzipSync(readFileSync(join(outDir, member))).toString('utf8'));
// A source record is carried in its JSON form: a rule function or a Set on the technicals row
// does not survive any serialisation, the device cache's included, and nothing in the alert
// surfaces reads either — the export column writes exactly this form.
export const jsonForm = (value) => JSON.parse(JSON.stringify(value));

/**
 * Every member reads back and carries exactly the collector's events. One shard is decoded at a
 * time — the full report is already in memory, and a month of decoded shards beside it is what an
 * OOM looks like — and each event is compared with the event the collector built at that position,
 * companions included; the AI shards' events with their compact form.
 */
export function verifyPoolMembers({ outDir, sourceFeeds, index }) {
  const pooled = sourceFeeds.filter((feed) => POOL_FEEDS.includes(feed.id));
  const seenOrders = new Map(pooled.map((feed) => [feed.id, new Set()]));
  for (const entry of index.days) {
    const shard = validateShard(readMember(outDir, entry.member), { day: entry.day });
    for (const feed of pooled) {
      const group = shard.feeds[feed.id];
      assert(group, `${entry.member}: ${feed.id} is present`);
      group.events.forEach((event, i) => {
        assert.deepEqual(event, jsonForm(feed.events[group.order[i]]), `${entry.member}: ${feed.id} event ${i} is the collector's event`);
        assert.equal(event.day, shard.day, `${entry.member}: ${feed.id} event ${i} falls on the shard's day`);
        seenOrders.get(feed.id).add(group.order[i]);
      });
      group.companions.events.forEach((event, i) => {
        assert.deepEqual(event, jsonForm(feed.events[group.companions.order[i]]), `${entry.member}: ${feed.id} companion ${i} is the collector's event`);
        assert.notEqual(event.day, shard.day, `${entry.member}: ${feed.id} companion ${i} is from another day`);
      });
    }
  }
  const held = new Set(index.days.map((entry) => entry.day));
  for (const feed of pooled) {
    const expected = new Set(feed.events.map((event, order) => (held.has(event.day) ? order : null)).filter((order) => order !== null));
    assert.deepEqual(seenOrders.get(feed.id), expected, `${feed.id}: the day shards hold every event of the pooled days exactly once`);
  }
  for (const entry of index.ai) {
    const shard = validateShard(readMember(outDir, entry.member), { span: entry.span });
    for (const feed of pooled) {
      const group = shard.feeds[feed.id];
      assert(group, `${entry.member}: ${feed.id} is present`);
      group.events.forEach((event, i) => {
        assert.deepEqual(event, jsonForm(compactAiEvent(feed.id, feed.events[group.order[i]])), `${entry.member}: ${feed.id} event ${i} is the collector's event in compact form`);
        assert(event.day >= shard.from && event.day <= shard.to, `${entry.member}: ${feed.id} event ${i} falls inside the shard's span`);
      });
      group.companions.events.forEach((event, i) => {
        assert.deepEqual(event, jsonForm(compactAiEvent(feed.id, feed.events[group.companions.order[i]])), `${entry.member}: ${feed.id} companion ${i} is the collector's event in compact form`);
      });
    }
  }
}
