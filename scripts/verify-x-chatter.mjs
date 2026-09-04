// Offline contracts. No credentials, browser cookies, X requests, or paid resources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { portfolioCatalog, companyQuery, manualSearchUrl, CACHE_MS } from '../public/js/data/x-chatter-shared.js';
import { normaliseX, searchRecent, XReadError } from '../worker/x-chatter-api.mjs';
import { XChatterEngine, collectionConfig } from '../worker/x-chatter-engine.mjs';

const NOW = Date.parse('2026-09-04T07:00:00Z');
const holdings = [{ isin: 'INE000000001', name: 'Example Optical Limited', ticker: 'EXAMPLE' },
  { isin: 'INE000000002', name: 'Sample Unlisted Private Ltd', ticker: null }];
const env = { X_CHATTER_ENABLED: 'true', X_CHATTER_DAILY_POST_LIMIT: '80', X_CHATTER_COMPANIES: 'all', X_BEARER_TOKEN: 'offline-placeholder' };
const post = (id = '111') => ({ id, text: 'Example fixture post', author: { name: 'Fixture author', username: 'fixture_author' },
  createdAt: new Date(NOW - 3600000).toISOString(), editIds: [id], images: [] });
function harness({ environment = env, read = async () => ({ posts: [post()], partial: false, returned: 1 }) } = {}) {
  const rows = new Map(); let time = NOW, alarmAt = null;
  const store = { get: (key) => structuredClone(rows.get(key)), put: (key, value) => rows.set(key, structuredClone(value)),
    delete: (key) => rows.delete(key), entries: (prefix) => [...rows].filter(([k]) => k.startsWith(prefix)).map((r) => structuredClone(r)),
    setAlarm: async (at) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } };
  const make = () => new XChatterEngine(store, environment, { clock: () => time, read });
  return { engine: make(), restart: make, store, rows, time: () => time, advance: (ms) => { time += ms; }, alarm: () => alarmAt };
}
const apiPayload = () => ({ meta: { result_count: 1 }, data: [{ id: '111', author_id: '42', text: 'Short text',
  note_tweet: { text: 'Full fixture text with detailed information' }, created_at: new Date(NOW - 1000).toISOString(),
  attachments: { media_keys: ['media1'] } }], includes: { users: [{ id: '42', name: 'Fixture person', username: 'fixture_person' }],
  media: [{ media_key: 'media1', type: 'photo', url: 'https://pbs.twimg.com/media/fixture.jpg', alt_text: 'A test image' }] } });

test('every holding is represented, including companies without an NSE symbol', () => {
  const book = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
  const catalog = portfolioCatalog(book.holdings);
  assert.equal(catalog.length, book.holdings.length);
  assert.ok(catalog.filter((c) => !c.ticker).every((c) => c.query));
  assert.ok(catalog.every((c) => c.query.length <= 512 && c.query.includes('-is:retweet')));
  assert.equal(portfolioCatalog(holdings).length, 2);
});
test('queries keep aliases, strip legal suffixes, exclude retweets and do not require news', () => {
  const query = companyQuery({ name: 'Jayaswal Neco Industries Ltd', matchedName: 'Jayaswal Neco', ticker: 'JAYNECOIND' });
  assert.match(query, /"Jayaswal Neco"/); assert.match(query, /#JAYNECOIND/); assert.doesNotMatch(query, /news|Ltd/);
  assert.doesNotMatch(companyQuery({ name: 'Example Optical', ticker: 'STL' }), / OR STL /);
  const manual = new URL(manualSearchUrl(portfolioCatalog(holdings)[0], true, NOW));
  assert.equal(manual.searchParams.get('f'), 'live'); assert.match(manual.searchParams.get('q'), /since:2026-08-28/);
});
test('X parsing preserves long text, author and allowed media without invented metrics', () => {
  const output = normaliseX(apiPayload(), 20, NOW);
  assert.equal(output.posts[0].text, 'Full fixture text with detailed information');
  assert.equal(output.posts[0].url, 'https://x.com/fixture_person/status/111');
  assert.equal(output.posts[0].images.length, 1); assert.equal(output.partial, false);
});
test('old posts, unsafe media, missing authors and partial response are not silently trusted', () => {
  const p = apiPayload(); p.data[0].created_at = '2022-03-29T00:00:00Z';
  assert.equal(normaliseX(p, 20, NOW).posts.length, 0); assert.equal(normaliseX(p, 20, NOW).partial, true);
  const unsafe = apiPayload(); unsafe.includes.media[0].url = 'https://evil.test/image';
  assert.equal(normaliseX(unsafe, 20, NOW).posts[0].images.length, 0);
  const missing = apiPayload(); missing.includes.users = [];
  assert.equal(normaliseX(missing, 20, NOW).partial, true);
  assert.throws(() => normaliseX({ data: [] }, 20, NOW), /invalid-response/);
  assert.throws(() => normaliseX({ meta: { result_count: 0 }, errors: [{}] }, 20, NOW), /partial-response/);
});
test('pagination signals incomplete coverage and IDs deduplicate', () => {
  const p = apiPayload(); p.data.push(p.data[0]); p.meta.result_count = 2; p.meta.next_token = 'another-page';
  const output = normaliseX(p, 20, NOW); assert.equal(output.posts.length, 1); assert.equal(output.partial, true);
  assert.deepEqual(normaliseX({ meta: { result_count: 0 } }, 20, NOW).posts, []);
});
test('official API request uses bounded recency search, server token and no cookies', async () => {
  await searchRecent({ token: 'fixture-secret', query: '"Example Optical" -is:retweet', now: NOW, fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://api.x.com'); assert.equal(url.pathname, '/2/tweets/search/recent');
    assert.equal(url.searchParams.get('sort_order'), 'recency'); assert.equal(url.searchParams.get('max_results'), '20');
    assert.equal(options.headers.Authorization, 'Bearer fixture-secret'); assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return Response.json(apiPayload());
  } });
});
test('X throttles respect reset and auth/credits failures stop with no secret/body leak', async () => {
  for (const status of [401, 402, 403, 429, 500]) {
    await assert.rejects(searchRecent({ token: 'fixture-secret', query: 'example', now: NOW, fetcher: async () =>
      new Response('private upstream diagnostic', { status, headers: { 'retry-after': '600', 'x-rate-limit-reset': String(NOW / 1000 + 900) } }) }),
    (err) => {
      assert.doesNotMatch(err.message, /private|fixture-secret/);
      if (status === 429) assert.equal(err.retryAt, NOW + 900000);
      else assert.equal(err.code, status >= 500 ? 'unavailable' : 'access-required');
      return true;
    });
  }
});
test('oversized successful responses are bounded', async () => {
  await assert.rejects(searchRecent({ token: 'fixture', query: 'example', now: NOW,
    fetcher: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /invalid-response/);
});
test('disabled configuration and public snapshots never start paid reads', async () => {
  let reads = 0; const h = harness({ environment: {}, read: async () => { reads++; } });
  assert.equal(collectionConfig({}).enabled, false);
  assert.equal((await h.engine.start(holdings)).code, 'setup-required');
  await h.engine.alarm(); h.engine.snapshot(); h.engine.snapshot(); assert.equal(reads, 0);
});
test('daily reservations persist across restarts and GETs cost no reads', async () => {
  let reads = 0; const h = harness({ environment: { ...env, X_CHATTER_DAILY_POST_LIMIT: '20' },
    read: async () => { reads++; return { posts: [post()], partial: false }; } });
  await h.engine.start(holdings); await h.engine.alarm();
  const fresh = h.restart(); fresh.snapshot(); fresh.snapshot(); h.advance(60000); await fresh.alarm();
  assert.equal(reads, 1); assert.equal(fresh.snapshot().reservedToday, 20); assert.equal(fresh.snapshot().status, 'daily-limit');
  h.advance(86400000); await fresh.alarm(); assert.equal(reads, 2);
});
test('a failed search cannot become no-matches or advance the success timestamp', async () => {
  const h = harness({ read: async () => { throw new XReadError('access-required'); } });
  await h.engine.start(holdings); await h.engine.alarm();
  const snapshot = h.engine.snapshot();
  assert.equal(snapshot.running, false); assert.equal(snapshot.lastSuccessAt, null);
  assert.equal(snapshot.companies[0].status, 'access-required'); assert.equal(snapshot.reservedToday, 20);
});
test('actual empty successes, partial coverage, date filtering, search and deduplication', async () => {
  let n = 0; const h = harness({ read: async () => ({ posts: ++n === 1 ? [post()] : [post(), post('112')], partial: true }) });
  await h.engine.start(holdings); await h.engine.alarm(); h.advance(60000); await h.engine.alarm();
  const s = h.engine.snapshot({ hours: 168 }); assert.equal(s.total, 2); assert.equal(s.posts.find((p) => p.id === '111').companies.length, 2);
  assert.equal(h.engine.snapshot({ q: 'not present' }).total, 0);
  assert.equal(h.engine.snapshot({ company: holdings[0].isin }).total, 1);
  assert.equal(h.engine.snapshot({ keys: holdings[0].isin }).total, 1);
  assert.equal(h.engine.snapshot({ limit: 1 }).hasMore, true);
  const empty = harness({ read: async () => ({ posts: [], partial: false }) });
  await empty.engine.start(holdings); await empty.engine.alarm(); assert.equal(empty.engine.snapshot().companies[0].status, 'no-matches');
});
test('unlisted holdings search by name and a pilot never spends on excluded companies', async () => {
  const queries = []; const h = harness({ environment: { ...env, X_CHATTER_COMPANIES: holdings[1].isin },
    read: async ({ query }) => { queries.push(query); return { posts: [], partial: false }; } });
  await h.engine.start(holdings); await h.engine.alarm(); h.advance(60000); await h.engine.alarm();
  assert.equal(queries.length, 1); assert.match(queries[0], /Sample Unlisted/);
  assert.equal(h.engine.snapshot().companies[0].status, 'not-checked');
});
test('warrant and ordinary holding for the same issuer share one read', async () => {
  let reads = 0; const h = harness({ read: async () => { reads++; return { posts: [post()], partial: false }; } });
  await h.engine.start([holdings[0], { isin: 'WARRANT01', name: 'Example Optical — warrants' }]);
  await h.engine.alarm(); h.advance(60000); await h.engine.alarm();
  assert.equal(reads, 1); assert.equal(h.engine.snapshot().companies.length, 2);
});
test('expiry removes content from storage and serving even without another successful read', async () => {
  const h = harness(); await h.engine.start(holdings); await h.engine.alarm();
  h.advance(CACHE_MS + 1); assert.equal(h.engine.snapshot({ hours: 168 }).posts.length, 0);
  assert.equal(h.engine.snapshot().companies[0].status, 'expired');
  assert.deepEqual(h.store.get(`company:${holdings[0].isin}`).posts, []);
});
test('removal and pause during an in-flight read cannot resurrect content', async () => {
  let resolve; const h = harness({ read: () => new Promise((done) => { resolve = done; }) });
  await h.engine.start(holdings); const flight = h.engine.alarm(); await Promise.resolve();
  assert.equal(h.engine.remove(['111']).ok, true); resolve({ posts: [post()], partial: false }); await flight;
  assert.equal(h.engine.snapshot().total, 0);
  h.advance(60000); const second = h.engine.alarm(); await Promise.resolve();
  await h.engine.pause(); resolve({ posts: [post('112')], partial: false }); await second;
  assert.equal(h.engine.snapshot().total, 0); assert.equal(h.alarm(), null);
});
test('rate-limit reset survives retries, while cached bodies still get an expiry alarm', async () => {
  let reads = 0; const h = harness({ read: async () => {
    if (++reads === 1) return { posts: [post()], partial: false };
    throw new XReadError('rate-limited', NOW + 3 * 86400000);
  } });
  await h.engine.start(holdings); await h.engine.alarm(); h.advance(60000); await h.engine.alarm();
  assert.ok(h.alarm() <= NOW + CACHE_MS + 1000);
  h.advance(CACHE_MS); await h.engine.alarm(); assert.equal(reads, 2); assert.equal(h.engine.snapshot().total, 0);
});
test('concurrent alarms/start cannot double-charge a read', async () => {
  let resolve, reads = 0; const h = harness({ read: () => { reads++; return new Promise((done) => { resolve = done; }); } });
  await h.engine.start(holdings); const a = h.engine.alarm(); await Promise.resolve(); await h.engine.alarm();
  assert.equal((await h.engine.start(holdings)).code, 'already-running'); assert.equal(reads, 1);
  resolve({ posts: [], partial: false }); await a; assert.equal(h.engine.snapshot().reservedToday, 20);
});
