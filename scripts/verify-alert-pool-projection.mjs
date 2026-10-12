// Prepared portfolio transport must be an exact reading shortcut over the complete archive.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortfolioProjection, projectPortfolioShard, portfolioProjectionSignature } from '../public/js/data/alert-pool-projection.js';
import { POOL_FEEDS, POOL_CAPTURES, ALERT_POOL_CONTRACT, isPoolMember, feedMember } from '../public/js/data/alert-pool-shared.js';
import { assembleFeedEvents } from '../public/js/data/alert-pool-format.js';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const { assemble, mapPortfolioDiscoveryEvents, matchesAlertScope, materializePublicAlertWindow, readCachedAlertWindow, alertContextKey } = await import('../public/js/data/daily-alerts.js');
const { writeEntry } = await import('../public/js/core/store.js');
const { ALERT_WINDOW_CACHE_KEY } = await import('../public/js/data/alert-window-cache.js');
const { portfolioNewsEntities } = await import('../public/js/data/company-news-identity.js');
const { scopeMatcher } = await import('../public/js/data/scope.js');
const { writePoolMembers, readMember, verifyPoolMembers } = await import('./lib/alert-pool-build.mjs');
const day = '2026-10-12';
const book = [{ ticker: 'ALPHA', name: 'Alpha Industries', isin: 'INE000A01001', listed: true },
  { ticker: 'ALPEXSOLAR-SM', name: 'Alpex Solar', isin: 'INE0J1H01015', listed: true },
  { ticker: null, name: 'No Quote Equity', isin: 'INE000B01001', listed: true }];
const entities = portfolioNewsEntities(book);
const entityIds = new Set(entities.map(entity => entity.entityId));
const scopeContext = { scope: 'portfolio', wanted: scopeMatcher('portfolio', book), entityIds };
const event = (feed, id, extra = {}) => ({ id, feed, ticker: 'ALPHA', company: 'Alpha Industries', day,
  headline: 'Alpha Industries approves expansion', url: `https://example.test/${id}`, importance: 'high', direction: 'neutral',
  severity: 'update', attribution: { status: 'confirmed', queryTicker: 'ALPHA', queryCompany: 'Alpha Industries' },
  sourceRecord: { company: 'Alpha Industries', title: 'Alpha Industries approves expansion', source: 'Original publisher',
    amount: '₹5,000', customEvidence: { retained: true } }, ...extra });
const sourceFeeds = POOL_FEEDS.map(id => ({ id, label: id, status: 'ok', asOf: day, reachesToday: true,
  events: [event(id, `${id}:held`), event(id, `${id}:other`, { ticker: 'OTHER', company: 'Other Company', entityId: null,
    headline: 'Other Company approves expansion', attribution: { status: 'confirmed', queryTicker: 'OTHER' } }),
  event(id, `${id}:sme`, { ticker: 'ALPEXSOLAR' }), event(id, `${id}:bse`, { ticker: null, entityId: entities.find(e => !e.ticker).entityId }),
  event(id, `${id}:unknown`, { ticker: null, entityId: null, headline: 'Unresolved source notice' }),
  event(id, `${id}:older`, { day: '2026-07-01' })] }));
// Publisher discovery is checked against its text, not the ticker hint on another source.
sourceFeeds.find(feed => feed.id === 'market-news').events[1].sourceRecord.title = 'Other Company approves expansion';
const reading = createPortfolioProjection(book);
const out = mkdtempSync(join(tmpdir(), 'alert-projection-'));
try {
  const index = writePoolMembers({ outDir: out, sourceFeeds, day, now: Date.parse(day), book,
    newsMeta: {}, captures: {} });
  verifyPoolMembers({ outDir: out, sourceFeeds, index });
  const full = index.ai.map(entry => readMember(out, entry.member));
  const selected = index.portfolioAi.entries.map(entry => readMember(out, entry.member));
  assert.equal(index.portfolioAi.signature, portfolioProjectionSignature(book));
  const fullFeeds = sourceFeeds.map(feed => ({ ...feed, events: assembleFeedEvents(full, feed.id) }));
  const selectedFeeds = sourceFeeds.map(feed => ({ ...feed, events: assembleFeedEvents(selected, feed.id),
    preparedProjection: index.portfolioAi.sourceStats[feed.id] }));
  const a = assemble({ day, scope: 'portfolio', holdings: book, includeHistory: true,
    settledFeeds: new Map(fullFeeds.map(feed => [feed.id, feed])) });
  const b = assemble({ day, scope: 'portfolio', holdings: book, includeHistory: true,
    settledFeeds: new Map(selectedFeeds.map(feed => [feed.id, feed])) });
  assert.deepEqual(b.events, a.events, 'every eligible event ID, field, correction, discovery and companion stays identical');
  assert.deepEqual(b.meta, a.meta, 'source/unresolved counts and honest health metadata remain exact');
  const fullWindow = materializePublicAlertWindow(assemble({ day, scope: 'universe', holdings: book, includeHistory: true,
    settledFeeds: new Map(fullFeeds.map(feed => [feed.id, feed])) }));
  const scopedWindow = { ...materializePublicAlertWindow(b), scopeContext: alertContextKey('portfolio', book, day) };
  await writeEntry(ALERT_WINDOW_CACHE_KEY, { savedAt: 1, value: fullWindow });
  await writeEntry(`${ALERT_WINDOW_CACHE_KEY}:selected:portfolio`, { savedAt: 2, value: scopedWindow });
  assert.equal((await readCachedAlertWindow({ scope: 'portfolio', holdings: book, day })).cacheSavedAt, 2);
  const reopenedUniverse = await readCachedAlertWindow({ scope: 'universe', holdings: book, day });
  assert.deepEqual(reopenedUniverse.events.map(row => row.id), fullWindow.events.map(row => row.id), 'a scoped opening cache never truncates Universe');
  assert.equal((await readCachedAlertWindow({ scope: 'portfolio', holdings: [...book, { ticker: 'OTHER', name: 'Other Company' }], day })).cacheSavedAt, 1,
    'a changed book immediately restores its complete full-scope cache');
  await writeEntry(ALERT_WINDOW_CACHE_KEY, { savedAt: 3, value: fullWindow });
  assert.equal((await readCachedAlertWindow({ scope: 'portfolio', holdings: book, day })).cacheSavedAt, 3, 'the newest valid source cache wins');
  for (const feed of fullFeeds) {
    const mapped = mapPortfolioDiscoveryEvents(feed.id, feed.events, entities);
    assert.deepEqual(mapPortfolioDiscoveryEvents(feed.id, selectedFeeds.find(f => f.id === feed.id).events, entities)
      .filter(row => matchesAlertScope(row, scopeContext)), mapped.filter(row => matchesAlertScope(row, scopeContext)));
  }
  assert.notEqual(portfolioProjectionSignature([...book, { ticker: 'NEW', name: 'Future Holding' }]), index.portfolioAi.signature);
  assert.notEqual(portfolioProjectionSignature(book.map(row => ({ ...row, name: row.name + ' renamed' }))), index.portfolioAi.signature);
  for (const member of ['ai/2026-10.portfolio.json.gz', 'ai/2026-10-12.portfolio.news.json.gz']) assert(isPoolMember(member));
  assert.equal(feedMember('ai/2026-10.portfolio.json.gz', 'news'), 'ai/2026-10.portfolio.news.json.gz');
  assert(!isPoolMember('ai/../../private.portfolio.json.gz'));
  const synthetic = { version: 1, contract: ALERT_POOL_CONTRACT, span: day,
    feeds: { news: { events: [event('news', 'x')], order: [17], companions: { events: [], order: [] } } } };
  assert.deepEqual(projectPortfolioShard(synthetic, reading), synthetic);
  const pool = await import('../public/js/data/alert-pool.js');
  const requests = [];
  index.artifact = 1;
  index.captures = Object.fromEntries(Object.keys(POOL_CAPTURES).map(name => [name,
    name === 'exchangeDeals' ? { artifactId: 42 } : { revision: 'fixture-v1' }]));
  globalThis.fetch = async input => {
    const path = String(input); requests.push(path);
    if (path === pool.INDEX_ROUTE) return Response.json(index);
    if (path === pool.STATUS_ROUTE) return Response.json({ captures: index.captures });
    const member = path.replace(/^api\/alert-pool\/1\//, '');
    return Response.json(readMember(out, member));
  };
  pool.resetForTest();
  const portfolio = await pool.read({ mode: 'ai', day, scope: 'portfolio', book });
  assert(requests.filter(path => path.includes('/1/')).every(path => path.includes('.portfolio.')), 'portfolio reads only verified portfolio members');
  assert.equal(pool.current({ mode: 'ai', day, scope: 'portfolio', book }), portfolio);
  assert.equal(pool.current({ mode: 'ai', day, scope: 'universe', book }), null, 'a scoped result is not a Universe result');
  for (const feed of selectedFeeds) assert.deepEqual(portfolio.feeds.get(feed.id).events, feed.events);
  const universe = await pool.read({ mode: 'ai', day, scope: 'universe', book });
  for (const feed of fullFeeds) assert.deepEqual(universe.feeds.get(feed.id).events, feed.events, 'switching scope restores every eligible Universe record');
  const changedBook = [...book, { ticker: 'NEW', name: 'Future Holding' }];
  const changed = await pool.read({ mode: 'ai', day, scope: 'portfolio', book: changedBook });
  assert.equal(changed.projection, null, 'future holdings fall back to the complete source without waiting for a rebuild');
  const requested = await pool.read({ mode: 'ai', day, scope: 'portfolio', book, requestedCompanies: [{ ticker: 'OTHER' }] });
  assert.equal(requested.projection, null, 'research outside the book retains complete public issuer coverage');
  console.log('PASS: complete Universe archive retained; exact portfolio IDs/fields/counts, tickerless/SME/discovery evidence, old context and future-book invalidation.');
} finally { rmSync(out, { recursive: true, force: true }); }
