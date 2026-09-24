// Small adversarial captures: date grouping, correction companions and recovery. No egress.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeNewsJson, readNewsJson } from './lib/news-json-storage.mjs';
import { shardSpec, shardPath } from '../public/js/core/json-shards.js';
import { createNewsWorkingSet } from '../public/js/data/news-working-set.js';
import { newsQueryIndexRow, newsQueryIdentity } from '../public/js/data/news-query-index.js';
import { newsPeriodBounds } from '../public/js/data/news-window.js';
import { dedupeArticles } from '../public/js/data/filings-shared.js';
const dir = mkdtempSync(join(tmpdir(), 'sattva-query-boundaries-'));
const originalFetch = globalThis.fetch, originalNow = Date.now, originalDocument = globalThis.document, originalTimeout = globalThis.setTimeout;
const digest = data => createHash('sha256').update(data).digest('hex');
let now = Date.parse('2026-09-16T18:29:00Z');
Date.now = () => now;
try {
  const rows = Array.from({ length: 120 }, (_, i) => ({ title: `Alpha update ${i}`, ticker: 'ALPHA',
    company: 'Alpha Limited', date: i % 3 === 0 ? '2026-09-16' : '2026-08-01',
    url: `https://example.test/story/${i}`, description: 'Original detail. '.repeat(150) }));
  rows[3].tradingViewId = 'same-story';
  rows[4].tradingViewId = 'same-story';
  rows[1] = { ...rows[1], url: rows[0].url, lastSeenAt: '2026-09-16T17:00:00Z', title: 'Corrected publication day' };
  const value = { capturedAt: '2026-09-16T17:00:00Z', byTicker: { ALPHA: rows, EMPTY: [], FAILED: [{ ...rows[2], ticker: 'FAILED', url: 'https://example.test/failed' }], CHECKED: [] }, failed: { FAILED: { reason: 'source-down' } }, empty: ['CHECKED'] };
  const path = join(dir, 'news.json');
  writeNewsJson(path, value, { maxBytes: 32768 });
  const manifest = JSON.parse(readFileSync(path)), spec = shardSpec(manifest);
  assert.equal(spec.version, 2);
  assert.deepEqual(readNewsJson(path, null, { verifyIndexes: true }), value, 'date transport preserves every original field and order');
  assert(spec.parts.some((part, i) => part.order[0] !== spec.parts.slice(0,i).reduce((n,p)=>n+p.rows,0)), 'fixture really reorders transport');
  const duplicatedOrder = structuredClone(manifest);
  duplicatedOrder._jsonShards.parts[0].order[0] = duplicatedOrder._jsonShards.parts[0].order[1];
  assert.throws(() => shardSpec(duplicatedOrder), /order/, 'duplicate/missing original positions cannot pass');
  const index = spec.parts[0].queryIndex, indexPath = shardPath(path, index.file), originalIndex = readFileSync(indexPath);
  const wrongIndex = JSON.parse(originalIndex); wrongIndex.items[0][0] = '2020-01-01';
  const wrongBytes = Buffer.from(JSON.stringify(wrongIndex));
  const badManifest = structuredClone(manifest), badPart = badManifest._jsonShards.parts[0];
  badPart.queryIndex.sha256 = digest(wrongBytes); badPart.queryIndex.bytes = wrongBytes.length;
  badPart.queryIndex.file = `news.parts/${badPart.queryIndex.sha256}.json`;
  writeFileSync(shardPath(path, badPart.queryIndex.file), wrongBytes); writeFileSync(path, JSON.stringify(badManifest));
  assert.throws(() => readNewsJson(path, null, { verifyIndexes: true }), /dates or identities/, 'publication validates semantic index content, not only hashes');
  writeFileSync(path, JSON.stringify(manifest));

  let window = newsPeriodBounds('today', now), gate = null;
  const calls = [], disk = new Map();
  const read = async input => {
    if (input === 'data/tradingview-news/latest.json') return { value: { capturedAt: value.capturedAt, byTicker: {} } };
    if (input !== 'data/news.json') throw Error(`Unexpected fixture path ${input}`);
    if (gate) await gate;
    return { value: JSON.parse(readFileSync(path)), checkedAt: now };
  };
  const fetcher = async input => {
    calls.push(input);
    return new Response(readFileSync(join(dir, String(input).replace(/^data\//,''))));
  };
  const make = (fetcherOverride = fetcher) => createNewsWorkingSet({ window: () => window, read, fetcher: fetcherOverride,
    diskRead: key => disk.get(key), diskWrite: (key, value) => { disk.set(key, value); } });
  const working = make();
  await working.prepare();
  const projected = (await working.read('data/news.json')).value;
  assert.deepEqual(projected.empty, ['CHECKED'], 'the original source empty list remains unchanged');
  assert.deepEqual(projected.queryEmpty, [], 'failed or never-checked companies are not certified empty');
  const selected = rows.filter(row => row.date === '2026-09-16' || row.url === rows[0].url || row.tradingViewId === 'same-story');
  assert.deepEqual(projected.byTicker.ALPHA, selected, 'selected date includes corrected companions in their original order');
  const sourcePaths = new Set(spec.parts.map(part => 'data/'+part.file));
  assert(calls.filter(path => sourcePaths.has(path)).length < spec.parts.length, 'Today skips old source text');
  assert.equal(projected.byTicker.EMPTY.length, 0);
  const wrongCounts = structuredClone(manifest);
  wrongCounts._jsonShards.bucketRows.ALPHA--;
  wrongCounts._jsonShards.bucketRows.EMPTY++;
  writeFileSync(path, JSON.stringify(wrongCounts));
  assert.throws(() => readNewsJson(path), /bucket count mismatch/, 'bucket summaries must match verified original records');
  writeFileSync(path, JSON.stringify(manifest));
  const before = calls.length; await working.read('data/news.json');
  assert.equal(calls.length, before, 'unchanged verified parts are reused');
  const laterCapture = '2026-09-16T17:30:00Z';
  writeFileSync(path, JSON.stringify({ ...manifest, capturedAt: laterCapture, failed: { CHECKED: { reason: 'new-failure' } } }));
  await working.prepare();
  const checkedAgain = (await working.read('data/news.json')).value;
  assert.equal(checkedAgain.byTicker, projected.byTicker, 'a rechecked unchanged selection reuses its complete original rows');
  assert.equal(checkedAgain.capturedAt, laterCapture, 'reusing rows must still report the newly checked capture');
  assert.deepEqual(checkedAgain.failed, { CHECKED: { reason: 'new-failure' } }, 'a new source failure cannot be concealed by projection reuse');
  writeFileSync(path, JSON.stringify(manifest));
  working.release();
  writeFileSync(path, JSON.stringify({...manifest,archive:{index:'../invalid-index.json'}}));
  const partial = make();
  await partial.prepare();
  assert.deepEqual((await partial.read('data/news.json')).value.byTicker.ALPHA, selected,
    'malformed optional archive metadata cannot prevent independent head records from painting');
  partial.release(); writeFileSync(path, JSON.stringify(manifest));

  for (const failure of ['missing', 'corrupt']) {
    disk.clear();
    const fallback = make(async input => {
      if (String(input).endsWith(index.file)) return failure === 'missing' ? new Response('', { status: 404 }) : new Response('corrupt');
      return fetcher(input);
    });
    await fallback.prepare();
    assert.deepEqual((await fallback.read('data/news.json')).value.byTicker.ALPHA, selected, `${failure} optional index falls back without missing records`);
    fallback.release();
  }
  const emptyPeriod = { from: '2026-09-17', to: '2026-09-17', includeUndated: false };
  for (const representation of ['indexed', 'legacy', 'inline']) {
    const source = structuredClone(representation === 'inline' ? value : manifest);
    if (representation === 'legacy') delete source._jsonShards.bucketRows;
    writeFileSync(path, JSON.stringify(source));
    const emptyQuery = createNewsWorkingSet({ window: () => emptyPeriod, read, fetcher,
      diskRead: key => disk.get(key), diskWrite: (key, value) => { disk.set(key, value); } });
    await emptyQuery.prepare();
    const result = (await emptyQuery.read('data/news.json')).value;
    assert.deepEqual(result.queryEmpty, ['ALPHA'], `${representation}: checked companies survive an empty period`);
    assert.deepEqual(result.empty, ['CHECKED']);
    assert.deepEqual(result.failed, value.failed, 'source failure status survives projection');
    assert.equal(result.capturedAt, value.capturedAt, 'a date projection does not advance source checks');
    emptyQuery.release();
  }
  writeFileSync(path, JSON.stringify(manifest));
  let open;
  gate = new Promise(resolve => { open = resolve; });
  const switching = make();
  const old = switching.prepare();
  window = { from: '2026-08-01', to: '2026-08-01', includeUndated: false };
  const latest = switching.read('data/news.json');
  open(); await old;
  const newValue = (await latest).value;
  assert.equal(newValue.queryWindow.from, window.from, 'in-flight old preparation cannot certify a new period');
  assert.deepEqual(newValue.byTicker.ALPHA, rows.filter(row => row.date === '2026-08-01' || row.url === rows[0].url || row.tradingViewId === 'same-story'));
  switching.release(); gate = null;

  // A REPUBLISHED COPY IS FOLDED ON ITS HEADLINE, SO THE HEADLINE IS A COMPANION. TradingView
  // republishes an outlet's story under its own address with that outlet's name, headline and date,
  // and `dedupeArticles` folds the pair on exactly that. Past midnight IST the copy lands on the
  // next day, and a one-day read that could not see the original kept a copy the full history drops
  // (Mint's Pine Labs story, 21 September 2026, republished at 00:06 IST on the 22nd).
  {
    const synDir = join(dir, 'syndication');
    mkdirSync(synDir, { recursive: true });
    const original = { title: 'Mastercard to exit Alpha in a block deal', ticker: 'ALPHA', source: 'Mint', date: '2026-09-15',
      publishedAt: '2026-09-15T15:15:53Z', url: 'https://publisher.test/alpha-block-deal', description: 'Original detail. '.repeat(150) };
    const copy = { ...original, publishedAt: '2026-09-15T18:36:26Z', url: 'https://tradingview.test/news/alpha-block-deal', tradingViewId: 'tv-copy' };
    const otherOutlet = { ...original, source: 'Business Standard', url: 'https://other.test/alpha-block-deal' };
    const synValue = { capturedAt: value.capturedAt, byTicker: { ALPHA: [original, otherOutlet, copy] } };
    const synPath = join(synDir, 'news.json');
    for (const maxBytes of [32768, 4096]) {
      writeNewsJson(synPath, synValue, { maxBytes });
      const synWorking = createNewsWorkingSet({ window: () => ({ from: '2026-09-16', to: '2026-09-16', includeUndated: false }),
        read: async input => input === 'data/news.json' ? { value: JSON.parse(readFileSync(synPath)), checkedAt: now }
          : { value: { capturedAt: value.capturedAt, byTicker: {} } },
        fetcher: async input => new Response(readFileSync(join(synDir, String(input).replace(/^data\//, '')))),
        diskRead: () => undefined, diskWrite: () => {} });
      assert.equal(!!shardSpec(JSON.parse(readFileSync(synPath))), maxBytes < 32768, 'both the inline and the partitioned index are read');
      await synWorking.prepare();
      assert.deepEqual((await synWorking.read('data/news.json')).value.byTicker.ALPHA, [original, copy],
        `${maxBytes}: a copy published past midnight IST brings the original it folds into, and nothing another outlet printed`);
      synWorking.release();
    }
    assert.deepEqual(dedupeArticles([original, otherOutlet, copy]), [original, otherOutlet], 'the pair folds as the full history folds it');
  }

  // Exercise the real facade and explicit live searches in separate windows. Empty Today
  // must not trigger a company walk; the changing IST day is evaluated on every refresh.
  mkdirSync(join(dir, 'tradingview-news'), { recursive: true });
  writeFileSync(join(dir,'tradingview-news/latest.json'), JSON.stringify({capturedAt:value.capturedAt,byTicker:{}}));
  writeFileSync(join(dir,'market-news.json'), JSON.stringify({capturedAt:value.capturedAt,articles:[],sources:[]}));
  for (const row of rows) delete row.tradingViewId;
  writeNewsJson(path, value, {maxBytes:32768});
  let upstreamCalls = 0, failSourceParts = false;
  globalThis.fetch = async input => {
    const p = String(input);
    if (failSourceParts && p.startsWith('data/news.parts/')) return new Response('', {status:403});
    if (p.startsWith('data/')) {
      try { return new Response(readFileSync(join(dir,p.slice(5))), {headers:{'content-type':'application/json'}}); }
      catch { return new Response('{}',{status:404}); }
    }
    upstreamCalls++;
    return Response.json({ articles: [{ title:'Manual arrival',date:'2026-09-17',url:'https://example.test/manual' }], fetchedAt:new Date(now).toISOString() });
  };
  const { createQueryNews, createFeed } = await import('../public/js/data/filings.js');
  let poll = null, scheduled = 0;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= 120000) { poll = fn; scheduled++; return 123456789; }
    return originalTimeout(fn, ms, ...args);
  };
  const cachedPeriod = createQueryNews(() => newsPeriodBounds('today'), { autoRefresh: false });
  const offCached = cachedPeriod.onChange(() => {});
  await cachedPeriod.load(['ALPHA']);
  assert.equal(scheduled, 0, "cached alert periods rely on their owning tab's recheck, without extra pollers");
  offCached(); cachedPeriod.release();
  const current = createQueryNews(() => newsPeriodBounds('today'));
  const offCurrent = current.onChange(() => {});
  await current.load(['ALPHA']);
  assert(current.rows().some(row=>row.title==='Alpha update 3'));
  assert(!current.rows().some(row=>row.url===rows[2].url));
  writeFileSync(join(dir,'market-news.json'), JSON.stringify({capturedAt:'2026-09-16T18:00:00Z',sources:[],articles:[{
    id:'publisher:date-correction',title:'Publisher correction',url:rows[2].url,publishedAt:'2026-09-16T17:30:00Z'
  }]}));
  await current.refreshSnapshot();
  assert(current.rows().some(row=>row.url===rows[2].url), 'a new publisher date adds an older companion even when the company head timestamp is unchanged');
  failSourceParts = true;
  current.setWindow({from:'2026-08-01',to:'2026-09-16',includeUndated:false});
  await current.load(['ALPHA']);
  assert(current.rows().some(row=>row.title==='Alpha update 3'), 'a failed wider read keeps overlapping last-good stories visible');
  assert(current.meta().newsDelivery.core.error, 'failed widening is not reported as complete');
  failSourceParts = false;
  await current.refreshSnapshot();
  assert(current.rows().some(row=>row.url===rows[119].url), 'recovery reads the newly requested older records');
  current.setWindow(() => newsPeriodBounds('today'));
  await current.load(['ALPHA']);
  now = Date.parse('2026-09-16T18:31:00Z');
  assert.equal(current.isLoaded(), false, 'midnight invalidates the previous day without a manual filter change');
  assert.equal(typeof poll, 'function', 'visible query reader owns an automatic recheck');
  const priorScheduled = scheduled;
  await poll();
  assert(scheduled > priorScheduled, 'midnight replacement rearms the next automatic refresh');
  assert(current.isLoaded(), 'automatic rollover initializes the new reading period');
  assert.equal(current.rows().length, 0, 'the new empty day cannot retain yesterday in its working set');
  assert.equal(upstreamCalls, 0, 'an empty bounded date never starts unsolicited per-company requests');
  assert.equal((await current.refreshSnapshot()).available, true, 'a verified empty day is a successful read');
  await current.load(['ALPHA', 'EMPTY', 'FAILED', 'CHECKED']);
  assert(current.wasAskedEmpty('ALPHA'), 'checked history outside Today is a verified empty period');
  assert(current.wasAskedEmpty('CHECKED'), "the source's original empty answer remains covered");
  assert(!current.wasAskedEmpty('EMPTY'), 'an unaccounted empty bucket remains unchecked');
  assert(!current.wasAskedEmpty('FAILED') && current.failureFor('FAILED'), 'failed checks remain failures');
  assert.equal(current.meta().outstanding, 2, 'only the unchecked and failed companies remain outstanding');
  assert.equal(current.meta().queryWindow.from, '2026-09-17', 'coverage wording has the actual reading period');
  const live = createFeed('news');
  await live.loadOne('ALPHA', { force: true });
  assert.equal(upstreamCalls, 1);
  assert(current.rows().some(row=>row.url==='https://example.test/manual'), 'manual arrival reaches another active window');
  offCurrent(); current.release();
  globalThis.setTimeout = originalTimeout; globalThis.document = originalDocument;
  const reopened = createQueryNews(() => newsPeriodBounds('today'));
  await reopened.load(['ALPHA']);
  assert(reopened.rows().some(row=>row.url==='https://example.test/manual'), 'releasing a reading window cannot lose an uncheckpointed manual arrival');
  reopened.release(); live.dispose();
  // Force the verified-part RAM cache to evict earlier parts. A small fixture would hide the
  // old double-index walk and repeated projection downloads behind that cache.
  const largePath = join(dir, 'large.json');
  const large = { articles: Array.from({ length: 12 }, (_, i) => ({ title: `Retained original ${i}`,
    date: '2026-09-17', url: `https://example.test/large/${i}`, description: 'Original detail. '.repeat(65536) })) };
  writeNewsJson(largePath, large, { maxBytes: 1.5 * 1024 * 1024 });
  let largeManifest = JSON.parse(readFileSync(largePath));
  const largeCalls = [];
  const largeRead = createNewsWorkingSet({ window: () => emptyPeriod,
    read: async input => {
      if (input === 'data/news.json') return { value: largeManifest };
      throw Error('Optional independent family unavailable');
    },
    fetcher: async input => {
      largeCalls.push(input);
      // This fixture serves a news head from the standalone large.parts directory.
      return new Response(readFileSync(join(dir, String(input).replace(/^data\/news.parts\//, 'large.parts/'))));
    }, diskRead: async () => null, diskWrite: async () => {} });
  // References must remain beside the owning manifest, including under the fixture route.
  largeManifest._jsonShards.parts.forEach(part => {
    part.file = part.file.replace('large.parts/', 'news.parts/');
    part.queryIndex.file = part.queryIndex.file.replace('large.parts/', 'news.parts/');
  });
  await largeRead.prepare();
  const largeProjection = (await largeRead.read('data/news.json')).value;
  assert.deepEqual(largeProjection.articles, large.articles, 'every large original record survives the selection plan');
  for (const part of largeManifest._jsonShards.parts)
    assert.equal(largeCalls.filter(path => path.endsWith(part.queryIndex.file)).length, 1,
      'projection never rereads an index evicted by a large source part');
  const readsBeforeReuse = largeCalls.length;
  assert.equal((await largeRead.read('data/news.json')).value.articles, largeProjection.articles);
  assert.equal(largeCalls.length, readsBeforeReuse, 'a completed projection does not redownload evicted source parts');
  const originals = new Set(largeManifest._jsonShards.parts.map(part => `data/${part.file}`));
  await largeRead.prepare();
  assert.equal((await largeRead.read('data/news.json')).value.articles, largeProjection.articles);
  assert.equal(largeCalls.slice(readsBeforeReuse).filter(path => originals.has(path)).length, 0,
    'rechecking unchanged manifests reuses the complete selection after RAM eviction');
  large.articles[0].title = 'Corrected retained original';
  writeNewsJson(largePath, large, { maxBytes: 1.5 * 1024 * 1024 });
  largeManifest = JSON.parse(readFileSync(largePath));
  largeManifest._jsonShards.parts.forEach(part => {
    part.file = part.file.replace('large.parts/', 'news.parts/');
    part.queryIndex.file = part.queryIndex.file.replace('large.parts/', 'news.parts/');
  });
  await largeRead.prepare();
  assert.deepEqual((await largeRead.read('data/news.json')).value.articles, large.articles,
    'a corrected source invalidates the saved projection without losing any originals');
  largeRead.release();
  console.log('PASS date-part skipping, source order, correction companions, optional-index recovery, rapid switching, midnight and manual-arrival retention.');
} finally {
  Date.now = originalNow; globalThis.fetch = originalFetch; globalThis.document = originalDocument; globalThis.setTimeout = originalTimeout;
  rmSync(dir, {recursive:true,force:true});
}
