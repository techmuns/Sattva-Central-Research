// Exact full-history / selected-view equivalence using the shipped source captures. No egress.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('public');
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
// Freeze one real run instant, and query the last completed IST day. This remains a
// meaningful news test as daily captures advance, rather than rejecting them as future data.
const now = Date.now();
Date.now = () => now;
const completedDay = new Date(now + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
globalThis.fetch = async input => {
  const path = String(input).split('?')[0];
  if (/^https?:/.test(path)) return new Response('{}', { status: 503 });
  const mapped = { 'api/earnings': 'data/earnings-live.json', 'api/concalls': 'data/concall-scans.json',
    'api/nse-announcements': 'data/nse-announcements.json', 'api/ipo-filings': 'data/ipo-filings.json' }[path] || path;
  assert(resolve(root, mapped).startsWith(root + '/'));
  try { return new Response(readFileSync(resolve(root, mapped)), { headers: { 'content-type': 'application/json' } }); }
  catch { return new Response('{}', { status: 404 }); }
};
const coverage = await import('../public/js/data/coverage.js');
coverage.prime(JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'))));
const alerts = await import('../public/js/data/daily-alerts.js');
const options = { scope: 'universe', day: completedDay, includeHistory: true };
const full = await alerts.collect(options);
assert(full.feeds.find(f => f.id === 'news').count > 0, 'the full-history oracle must actually load retained news');
console.log(JSON.stringify({ day: completedDay, full: full.events.length, news: full.feeds.find(f => f.id === 'news').count }));
const { inAlertQuery } = alerts;
for (const days of (process.env.NEWS_QUERY_DAYS || '1,3,14,30').split(',').map(Number)) {
  const queryWindow = { from: new Date(Date.parse(options.day) - (days-1)*86400000).toISOString().slice(0,10), to: options.day, includeUndated: false };
  const bounded = await alerts.collect({ ...options, queryWindow });
  const expected = full.events.filter(event => inAlertQuery(event, queryWindow));
  const actual = new Map(bounded.events.map(event => [event.id, event]));
  const missing = expected.filter(event => !actual.has(event.id));
  const ids = new Set(expected.map(event => event.id));
  const extra = bounded.events.filter(event => !ids.has(event.id));
  assert.deepEqual({ missing: missing.map(e=>({id:e.id,headline:e.headline,feed:e.feed})), extra: extra.map(e=>({id:e.id,headline:e.headline,feed:e.feed})) }, { missing: [], extra: [] }, `${days}-day identities`);
  for (const event of expected) {
    try { assert.deepEqual(actual.get(event.id), event, `${days}-day original fields/provenance: ${event.id}`); }
    catch(error) {
      console.log(JSON.stringify({queryWindow,feedCounts:bounded.feeds.map(f=>({id:f.id,count:f.count,status:f.status,note:f.note})),
        companions:bounded.sourceFeeds.flatMap(f=>f.events.filter(e=>e.url===event.url).map(e=>({feed:f.id,id:e.id,day:e.day,at:e.at}))),
        rawPublisher:(await import('../public/js/data/market-news.js')).rows().filter(r=>r.url===event.url).map(r=>({id:r.id,publishedAt:r.publishedAt}))}));
      throw error;
    }
  }
  console.log(`PASS ${days}-day query: ${expected.length} exact complete events`);
}
// Research owns its prepared shared source records independently of a mounted alert tab.
await alerts.prepareSources({ feedIds: ['news'] });
const { news } = await import('../public/js/data/filings.js');
const preparedNews = news.rows();
const off = alerts.onChange(() => {}); off();
assert.equal(news.rows(), preparedNews, 'leaving alerts must not invalidate a prepared research estate');
console.log('PASS bounded raw reading preserves canonical history, corrections, provenance and independent research ownership.');

// A RELEASED READER STARTS NO FURTHER READS. The archive walk is one sequential request per
// month, so a cancellation observed only after the walk lets a disposed tab go on fetching every
// remaining month — requests that start after destroy, are discarded on arrival, and hold
// connections the next view needs. Nothing throws, no count is wrong and no state is lost, which
// is why the browser suite could only catch it as a race it could not reproduce locally. Asserted
// here against the paths actually requested, so the guarantee is testable off a clock.
const { createNewsWorkingSet } = await import('../public/js/data/news-working-set.js');
const month = (file, url, day) => [file, { articles: [{ url, publishedAt: `${day}T00:00:00Z` }] }];
const captures = Object.fromEntries([
  ['data/news.json', { archive: { index: 'company-news/index.json' }, byTicker: { AAA: [{ url: 'https://example.test/head', publishedAt: '2026-08-02T00:00:00Z' }] } }],
  ['data/tradingview-news/latest.json', { archive: { index: 'tradingview-news/index.json' }, articles: [] }],
  ['data/company-news/index.json', { updatedAt: '2026-08-31T00:00:00Z', entities: [],
    archive: [{ file: 'company-news/2026-08.json', count: 1 }, { file: 'company-news/2026-07.json', count: 1 }] }],
  ['data/tradingview-news/index.json', { updatedAt: '2026-08-31T00:00:00Z', entities: [],
    archive: [{ file: 'tradingview-news/2026-08.json', count: 1 }, { file: 'tradingview-news/2026-07.json', count: 1 }] }],
  month('data/company-news/2026-08.json', 'https://example.test/c8', '2026-08-10'),
  month('data/company-news/2026-07.json', 'https://example.test/c7', '2026-07-10'),
  month('data/tradingview-news/2026-08.json', 'https://example.test/t8', '2026-08-11'),
  month('data/tradingview-news/2026-07.json', 'https://example.test/t7', '2026-07-11'),
]);
const held = 'data/company-news/2026-08.json';
const requested = [];
let openGate, atGate;
const gate = new Promise(resolve => { openGate = resolve; });
const reached = new Promise(resolve => { atGate = resolve; });
const workingSet = createNewsWorkingSet({
  window: () => null,
  read: async (path) => {
    requested.push(path);
    if (path === held) { atGate(); await gate; }
    if (!Object.hasOwn(captures, path)) throw Error(`Unexpected read: ${path}`);
    return { value: structuredClone(captures[path]), tag: path };
  },
  diskRead: async () => null,
  diskWrite: async () => {},
  fetcher: async () => { throw Error('this fixture has no sharded parts to fetch'); },
});
const walk = workingSet.prepare().then(() => 'completed', (error) => error.message);
await reached;
workingSet.release();
const duringWalk = requested.length;
openGate();
assert.equal(await walk, 'Obsolete news view', 'a released preparation is abandoned rather than adopted');
await new Promise(resolve => setTimeout(resolve, 50));
const after = requested.slice(duringWalk);
assert.deepEqual(after, [], `a released reader starts no further reads (started: ${after.join(', ') || 'none'})`);
assert(duringWalk < Object.keys(captures).length, 'the fixture must leave unread months for the walk to skip');
console.log(`PASS released news reader stops after ${duringWalk} reads instead of walking all ${Object.keys(captures).length} captures.`);

// THE COMPANION INDEX IS BUILT ONCE PER SET OF CAPTURES AND SHARED — AND STAYS EXACT. One All Alerts
// open used to walk every retained month three or four times (seed, the refresh after it, a second
// collection, the News tab's reader of the same day). A sharded head and a date-corrected story (one
// URL on two days) are enough to show the reuse is invisible: projections equal an independently
// built index, a refresh or a second reader of the day builds nothing, and a different day, a changed
// capture or an index nobody holds any more is built afresh. The parts carry no published query
// index here, so every build looks each part's index up on the device exactly once — a count no
// memory cache beneath can hide.
{
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeNewsJson } = await import('./lib/news-json-storage.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'news-index-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const story = (ticker, n, date, url = `https://example.test/${ticker}/${n}`) =>
      ({ ticker, title: `${ticker} story ${n}`, source: 'Example Wire', url, date, publishedAt: `${date}T06:00:00Z` });
    const head = { capturedAt: '2026-09-03T12:00:00Z', byTicker: {
      AAA: [story('AAA', 1, '2026-09-02'), story('AAA', 2, '2026-09-01'), story('AAA', 3, '2026-08-30')],
      // The same article captured on two days: the later reading corrected its date.
      BBB: [story('BBB', 1, '2026-09-02', 'https://example.test/corrected'), story('BBB', 2, '2026-08-31', 'https://example.test/corrected'), story('BBB', 3, '2026-08-29')],
      CCC: Array.from({ length: 12 }, (_, i) => story('CCC', i, `2026-08-${String(10 + i).padStart(2, '0')}`)),
    } };
    const publish = () => {
      const path = join(dir, 'data/news.json');
      writeNewsJson(path, head, { maxBytes: 1400 });
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      for (const part of manifest._jsonShards.parts) delete part.queryIndex;
      writeFileSync(path, JSON.stringify(manifest));
      return manifest._jsonShards.parts.length;
    };
    const partCount = publish();
    assert(partCount > 2, 'the fixture is sharded');
    let lookups = 0;
    const shared = { fetcher: async path => new Response(readFileSync(join(dir, path))),
      diskRead: async () => { lookups++; return null; }, diskWrite: async () => {} };
    const independent = () => ({ fetcher: async path => new Response(readFileSync(join(dir, path))), diskRead: async () => null, diskWrite: async () => {} });
    const fixtureRead = async path => ({ value: JSON.parse(readFileSync(join(dir, path), 'utf8')) });
    const reader = (window, io = shared) => createNewsWorkingSet({ window: () => window, read: fixtureRead, ...io });
    const projected = async set => Object.values((await set.read('data/news.json')).value.byTicker).flat().map(row => row.url).sort();
    const day = { from: '2026-09-02', to: '2026-09-02', includeUndated: false };

    const first = reader(day);
    await first.prepare();
    assert.equal(lookups, partCount, 'the first preparation builds the index over every part once');
    const expected = await projected(reader(day, independent()));
    assert.deepEqual(await projected(first), expected, 'a shared index projects exactly what an independent one does');
    assert.equal(expected.filter(url => url === 'https://example.test/corrected').length, 2, 'the corrected story brings its companion');
    assert(first.includes(story('BBB', 2, '2026-08-31', 'https://example.test/corrected')) && !first.includes(story('CCC', 0, '2026-08-10')),
      'companion membership comes from the index, not the day alone');
    await first.prepare();
    assert.equal(lookups, partCount, 'an unchanged refresh adopts the finished index');
    const second = reader(day);
    await second.prepare();
    assert.equal(lookups, partCount, 'a second reader of the same day shares it');
    assert.deepEqual(await projected(second), expected);
    first.release();
    await second.prepare();
    assert.equal(lookups, partCount, 'one reader\'s release leaves the index to the reader still holding it');
    assert.deepEqual(await projected(second), expected);

    const august31 = { from: '2026-08-31', to: '2026-08-31', includeUndated: false };
    const otherDay = reader(august31);
    await otherDay.prepare();
    assert.equal(lookups, 2 * partCount, 'another day builds its own index');
    assert.deepEqual(await projected(otherDay), await projected(reader(august31, independent())));

    // A changed capture is a changed key: the new story is found without a reload.
    head.byTicker.AAA.push(story('AAA', 9, '2026-09-02'));
    const changedParts = publish();
    const beforeChange = lookups;
    await second.prepare();
    assert.equal(lookups, beforeChange + changedParts, 'a changed capture rebuilds the index');
    assert((await projected(second)).includes('https://example.test/AAA/9'), 'the changed capture\'s new story is selected');

    second.release(); otherDay.release();
    const released = lookups;
    await reader(day).prepare();
    assert.equal(lookups, released + changedParts, 'an index no reader holds is not kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('PASS the companion index is built once per set of captures, shared by readers of the same day, and exact.');
}
