#!/usr/bin/env node
// THE POOL IN THE BROWSER: the same rows in the same order as the live collection, with no capture
// downloaded to get them; a capture that moved sends its feed down the live path; the ranking
// reads the AI pool. Local captures and local stand-ins only; no production request, no writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const { captureStatusFor } = await import('./lib/alert-pool-build.mjs');

// The pool, built exactly as the runner builds it, with the committed exchange seed standing in
// for the bulk/block artifact under a known id so the insider feed can be verified.
const EXCHANGE_ID = 4242;
const poolDir = process.env.ALERT_POOL_DIR || mkdtempSync(join(tmpdir(), 'alert-pool-ui-'));
if (!existsSync(join(poolDir, 'index.json'))) {
  console.log(`building the pool into ${poolDir}`);
  execFileSync(process.execPath, ['--max-old-space-size=4096', resolve(here, 'build-alert-pool.mjs'), poolDir],
    { stdio: 'inherit', env: { ...process.env, ALERT_POOL_EXCHANGE_FILE: resolve(root, 'data/exchange-deals.json'), ALERT_POOL_EXCHANGE_ID: String(EXCHANGE_ID) } });
}
const index = JSON.parse(readFileSync(join(poolDir, 'index.json'), 'utf8'));
const exchange = { text: readFileSync(resolve(root, 'data/exchange-deals.json'), 'utf8'), id: EXCHANGE_ID };
const status = captureStatusFor({ root, exchange, servedAt: index.builtAt });
const served = { status: JSON.parse(JSON.stringify(status)), artifact: 1, requests: [] };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  served.requests.push(url.pathname);
  if (req.method !== 'GET') { res.writeHead(503); res.end('{}'); return; }
  if (url.pathname === '/api/alert-pool/index') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ ...index, artifact: served.artifact })); return;
  }
  const member = /^\/api\/alert-pool\/(\d+)\/(.+)$/.exec(url.pathname);
  if (member) {
    const file = join(poolDir, member[2]);
    if (Number(member[1]) !== served.artifact || !file.startsWith(poolDir + sep) || !existsSync(file)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'public, max-age=604800, immutable', etag: `"pool-${member[1]}-${member[2]}"` });
    res.end(readFileSync(file)); return;
  }
  if (url.pathname === '/api/capture-status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(served.status)); return; }
  if (url.pathname === '/api/bulk-block-deals') { res.writeHead(200, { 'content-type': 'application/json', etag: `"exchange-${EXCHANGE_ID}"` }); res.end(exchange.text); return; }
  const api = { '/api/earnings': 'earnings-live.json', '/api/concalls': 'concall-scans.json',
    '/api/nse-announcements': 'nse-announcements.json', '/api/ipo-filings': 'ipo-filings.json' }[url.pathname];
  let path = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (api) path = resolve(root, 'data', api);
  if (url.pathname === '/fixture/chatter/dashboard') path = resolve(root, '../scripts/fixtures/chatter-dashboard.json');
  if (url.pathname.startsWith('/api/') && !api) { res.writeHead(503); res.end('{}'); return; }
  if (!path.startsWith(root + sep) && !url.pathname.startsWith('/fixture/')) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

// The market-news HEAD is not in this list: the header's notification watcher (js/core/watch.js)
// polls it from boot on every page, pool or no pool. Its archive months are, because only the
// alert collection reads those.
const CAPTURE_FILES = ['/data/news.json', '/data/insider-trades.json', '/data/corp-announcements.json', '/data/technicals.json'];
const captureReads = (since = 0) => served.requests.slice(since).filter((path) => CAPTURE_FILES.includes(path) || /^\/data\/(news\.parts|company-news|insider-archive|announcements-archive|market-news|tradingview-news)\//.test(path));
const poolReads = (since = 0) => served.requests.slice(since).filter((path) => path.startsWith('/api/alert-pool/'));

async function openPage() {
  // Compare the completed data presentation, not two independent entrance-animation clocks.
  // Normal-motion queue timing and complete-model export are covered by verify-general-alerts-ui.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript((base) => { localStorage.setItem('sattva:chatter-base', `${base}/fixture/chatter`); }, origin);
  const page = await context.newPage();
  // Both readers compare one immutable captured instant, including freshness and the IST day.
  // Timer-driven lifecycle/rollover checks have dedicated suites; this oracle must not age its
  // inputs between the fast pooled reading and the slower full-history reading.
  await page.clock.setFixedTime(new Date(index.builtAt));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return { context, page, errors };
}
// A PAGE THAT MUST TAKE THE LIVE PATH IS TOLD THERE IS NO POOL BY ITS OWN ROUTE. Switching the
// server's answer for every page also answered the pooled page while the live page settled: All
// Alerts re-checks a visible page every 90 seconds, so once the comparison took that long the
// pooled page read "no pool" too, went down the live path and failed the later pooled checks.
const withoutPool = (page) => page.route('**/api/alert-pool/index', (route) =>
  route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"reason":"no-pool"}' }));
const alertSnapshot = page => page.evaluate(() => {
  const keys = [...document.querySelectorAll('tbody tr[data-row-key]')].map(row => row.dataset.rowKey);
  const count = document.querySelector('[data-row-count]')?.textContent.trim() || '';
  const chips = Object.fromEntries([...document.querySelectorAll('[data-feed]')].map(chip =>
    [chip.dataset.feed, chip.textContent.trim().replace(/\s+/g, ' ')]));
  const empty = /^No loaded event\b/.test(document.querySelector('tbody')?.textContent.trim() || '') && /^0\b/.test(count);
  const ready = (keys.length > 0 || empty) && Object.keys(chips).length > 0 &&
    !Object.values(chips).some(label => label.includes('reading…')) &&
    document.querySelector('[data-alerts-workspace]')?.getAttribute('aria-busy') === 'false' &&
    document.querySelector('[data-alerts-workspace]')?.getAttribute('data-alerts-collecting') === 'false' &&
    !document.querySelector('[data-table-loading]');
  return { keys, count, chips, ready };
});
// Settled also means the relevance order is final: within the recent days a large table reads
// relevance in slices after its first paint (surface-relevance.js), and rows not yet read sort by
// time until then. Comparing two pages mid-way would compare two partial orders.
const settledAlerts = async (page) => {
  // Relevance warm-up alone does not wait for its asynchronously loaded inputs.
  // A fast pooled page can otherwise be sampled with unknown size bands while
  // the slower live page already has company profiles and a different final order.
  await page.evaluate(async () => {
    const [profiles, feedback] = await Promise.all([
      import('/js/data/company-profiles.js'), import('/js/data/relevance-feedback.js'),
    ]);
    await Promise.all([profiles.loadProfiles(), feedback.loadModel()]);
  });
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('tbody tr[data-row-key]').length;
    const chips = [...document.querySelectorAll('[data-feed]')];
    // Today is empty after IST midnight until something dated today is captured: settled then means
    // the table's own empty state over a zero count, never the placeholders of a read still running.
    const empty = /^No loaded event\b/.test(document.querySelector('tbody')?.textContent.trim() || '')
      && /^0\b/.test(document.querySelector('[data-row-count]')?.textContent.trim() || '');
    // The feeds may be ready while sliced story grouping still shows the original reports.
    // Compare completed line items, never a fixed-delay sample of an intermediate count.
    return (rows > 0 || empty) && chips.length > 0 && !chips.some((chip) => chip.textContent.includes('reading…'))
      && document.querySelector('[data-alerts-workspace]')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('[data-alerts-workspace]')?.getAttribute('data-alerts-collecting') === 'false'
      && !document.querySelector('[data-table-loading]');
  }, null, { timeout: 120000 });
  // Story grouping folds exact duplicate reports after the first paint and hands the table new row
  // objects, which are read in slices too; a refresh repaints the unfolded rows until the fold runs
  // again. So settled means the readings are done and two reads a moment apart agree on the painted
  // rows AND on the complete count, which counts rows that are not painted.
  let previous = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.evaluate(async () => { await (await import('/js/data/surface-relevance.js')).relevanceSettled(); });
    // The normal 90-second refresh can start after the first readiness check,
    // retaining rows while its chips read "reading". Recheck readiness and take
    // rows, count and chips in one atomic DOM read; never compare separate clocks.
    const snapshot = await alertSnapshot(page), state = JSON.stringify(snapshot);
    if (snapshot.ready && state === previous) return snapshot;
    previous = snapshot.ready ? state : null;
    await page.waitForTimeout(1500);
  }
  throw Error('the alert rows, count and source chips did not settle');
};
const rowKeys = (page) => page.evaluate(() => [...document.querySelectorAll('tbody tr[data-row-key]')].map((row) => row.dataset.rowKey));
// THE RANKING IS SETTLED when the tab is no longer reading — `complete`, or `partial` where a live
// route this sandbox cannot answer left a feed failed — and the cards have stopped changing.
const settledRanking = async (page, timeout) => {
  const snapshot = () => {
    const status = document.querySelector('[data-ai-feed-status]');
    const cards = [...document.querySelectorAll('[data-ai-card]')].map(card => card.dataset.ticker);
    const firstPosition = Number(document.querySelector('[data-ai-card]')?.getAttribute('aria-posinset') || 0);
    const total = Number(document.querySelector('[data-ai-cards]')?.dataset.aiTotal || 0);
    // A source failure has priority in the compact status label while the remaining sources
    // still read. Collection readiness is separate from that truthful coverage label.
    const ready = !!status?.dataset.state && status.dataset.state !== 'pending' &&
      document.querySelector('[data-ai-cards]')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('[data-ai-layout]')?.getAttribute('data-ai-collecting') === 'false';
    return { cards, firstPosition, total, ready, coverage: status?.dataset.state, grouping: status?.dataset.aiStoryStatus };
  };
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-ai-feed-status]');
    return !!status?.dataset.state && status.dataset.state !== 'pending' &&
      document.querySelector('[data-ai-cards]')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('[data-ai-layout]')?.getAttribute('data-ai-collecting') === 'false';
  }, null, { timeout }).catch(async error => {
    console.error('AI ranking did not finish collection:', await page.evaluate(snapshot));
    throw error;
  });
  let previous = null;
  for (let i = 0; i < 40; i++) {
    // Live arrivals preserve the company being read. Compare the same first eight companies,
    // independent of that reading anchor or the adaptive number of mounted grid rows.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    // Recheck readiness with the order: another source arrival can start a reassembly.
    const state = await page.evaluate(snapshot), cards = state.cards.join(',');
    if (state.ready && state.firstPosition === 1 && cards && cards === previous) return { cards: state.cards.slice(0, 8), total: state.total };
    previous = state.ready && state.firstPosition === 1 ? cards : null;
    await page.waitForTimeout(1500);
  }
  throw new Error('the ranking did not settle');
};
const rowCount = (page) => page.evaluate(() => document.querySelector('[data-row-count]')?.textContent.trim() || '');
const feedChips = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-feed]')].map((chip) => [chip.dataset.feed, chip.textContent.trim().replace(/\s+/g, ' ')])));

const environment = (message) => /ExcelJS|fonts\.googleapis|exceljs|Failed to load resource|net::ERR|503/.test(message);

try {
  // 1. ALL ALERTS ON TODAY, FROM THE POOL: the day shard is read and no capture is.
  const pooled = await openPage();
  const from = served.requests.length;
  await pooled.page.goto(`${origin}/#/research/daily-alerts?scope=universe`);
  const pooledReading = await settledAlerts(pooled.page);
  const { keys: pooledKeys, count: pooledCount, chips: pooledChips } = pooledReading;
  assert(poolReads(from).some((path) => path.endsWith(`/days/${index.day}.json.gz`)), `today's shard is read (${poolReads(from).join(', ')})`);
  assert.deepEqual(captureReads(from), [], `no pooled capture is downloaded for Today (${captureReads(from).join(', ')})`);
  const poolState = await pooled.page.evaluate(async () => (await import('/js/data/alert-pool.js')).status());
  assert.deepEqual(Object.fromEntries(Object.entries(poolState.feeds).map(([id, state]) => [id, state.pooled])),
    { technicals: true, announcements: true, insider: true, news: true, 'market-news': true }, `every pooled feed came from the pool (${JSON.stringify(poolState.feeds)})`);
  console.log(`PASS All Alerts Today from the pool: ${pooledKeys.length} rows painted, ${pooledCount}, no capture downloaded`);

  // 1b. A PER-COMPANY ENTRY FROM AN EARLIER VISIT — what a Refresh on the News tab leaves behind
  // — does not send the feed down the live path: a reader seeded with no company list never reads
  // it. This is the case the owner's own browser was in on the day the pool went live.
  await pooled.page.evaluate(async () => {
    const { writeEntry, KEYS } = await import('/js/core/store.js');
    await writeEntry(KEYS.filingRow('news', 'RELIANCE'), { tag: null, value: { rows: [] } });
    await writeEntry(KEYS.filingRow('insider', 'RELIANCE'), { tag: null, value: { rows: [] } });
  });
  const fromStale = served.requests.length;
  await pooled.page.reload();
  await settledAlerts(pooled.page);
  await pooled.page.waitForTimeout(1500);
  assert.deepEqual(captureReads(fromStale), [], `stale device entries download no capture (${captureReads(fromStale).join(', ')})`);
  const staleState = await pooled.page.evaluate(async () => (await import('/js/data/alert-pool.js')).status().feeds);
  assert.deepEqual({ news: staleState.news, insider: staleState.insider }, { news: { pooled: true }, insider: { pooled: true } }, `news and insider stay pooled beside stale device entries (${JSON.stringify(staleState)})`);
  assert.deepEqual(await rowKeys(pooled.page), pooledKeys, 'and the rows are unchanged');
  console.log('PASS per-company device entries from an earlier visit leave every feed on the pool');

  // A real statement-book handoff can keep every ticker/display name yet change the
  // legal name used by news matching. The in-flight context must get a replacement
  // reader; silently abandoning it otherwise leaves the five pooled feeds pending.
  const handoff = await openPage();
  let releaseIndex, sawIndex;
  const indexWaiting = new Promise(resolve => { sawIndex = resolve; });
  const indexGate = new Promise(resolve => { releaseIndex = resolve; });
  await handoff.page.route('**/api/alert-pool/index', async route => {
    sawIndex(); await indexGate; await route.continue();
  });
  const handoffFrom = served.requests.length;
  await handoff.page.goto(`${origin}/#/research/daily-alerts?scope=universe`);
  await indexWaiting;
  // Keep the test's module promise rooted while the index is deliberately held.
  // A bare async DevTools evaluation can lose its promise during a browser GC;
  // apply the book change synchronously after the dependency is available.
  await handoff.page.evaluate(() => {
    window.handoffCoverageReady = import('/js/data/coverage.js').then(module => {
      window.handoffCoverage = module;
    });
  });
  await handoff.page.waitForFunction(() => !!window.handoffCoverage, null, { timeout: 10000 });
  await handoff.page.evaluate(() => {
    const coverage = window.handoffCoverage;
    coverage.useFamilyBook(coverage.holdings().map(h => ({ ...h, bookName: `${h.name} statement name` })));
  });
  releaseIndex();
  await handoff.page.waitForFunction(async () => {
    const state = (await import('/js/data/alert-pool.js')).status();
    return state.feeds.announcements?.pooled && state.feeds.news?.pooled;
  }, null, { timeout: 10000 });
  await settledAlerts(handoff.page);
  assert.deepEqual(captureReads(handoffFrom), [], 'the replacement context still uses the pool instead of raw captures');
  assert(poolReads(handoffFrom).some(path => path.endsWith(`/days/${index.day}.json.gz`)), 'the replacement reads the current-day shard');
  await handoff.page.evaluate(() => {
    window.handoffSearch = document.querySelector('[data-table-search]');
    const coverage = window.handoffCoverage;
    coverage.useFamilyBook(coverage.holdings().map(h => ({ ...h, cmp: 123, holdingWeightPct: 2.5 })));
    coverage.invalidateFamilyBook(); coverage.failFamilyBook();
  });
  await handoff.page.waitForTimeout(50);
  assert(await handoff.page.evaluate(() => window.handoffSearch === document.querySelector('[data-table-search]')),
    'quote and check-status updates keep the existing controls mounted');
  assert.deepEqual(handoff.errors.filter(message => !environment(message)), []);
  await handoff.context.close();
  console.log('PASS a statement-name handoff during index loading replaces the abandoned context and settles all pooled feeds.');

  // 2. THE SAME VIEW WITHOUT A POOL: the live collection paints the same rows in the same order.
  const live = await openPage();
  await withoutPool(live.page);
  const liveFrom = served.requests.length;
  await live.page.goto(`${origin}/#/research/daily-alerts?scope=universe`);
  const liveReading = await settledAlerts(live.page);
  assert(captureReads(liveFrom).length > 0, 'the live path downloads captures');
  assert.deepEqual(pooledKeys, liveReading.keys, 'the pool paints the rows the live collection paints, in the same order');
  assert.equal(pooledCount, liveReading.count, 'the same total');
  const liveChips = liveReading.chips;
  // A source chip is compared where the live read succeeded here. A sandbox that times out an
  // archive read paints that feed partial on the live page; the runner read it whole, and the pool
  // says so — that is the environment failing the live path, not the pool disagreeing with it.
  const skipped = [];
  for (const [feed, label] of Object.entries(liveChips)) {
    if (/partial|unread|reading/.test(label) && !/partial|unread|reading/.test(pooledChips[feed] || '')) { skipped.push(`${feed} (${label})`); continue; }
    assert.equal(pooledChips[feed], label, `${feed}: the same source chip`);
  }
  if (skipped.length) console.log(`SKIP source chips the live read could not settle in this environment: ${skipped.join(', ')}`);
  console.log('PASS the live collection paints the same rows, totals and source chips');

  // Today can legitimately be empty after IST midnight. Keep that exact comparison above,
  // and also require a populated period so an empty rendering regression cannot pass it.
  await pooled.page.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('7d');
  const recentReading = await settledAlerts(pooled.page);
  const { keys: recentKeys, count: recentCount } = recentReading;
  assert(recentKeys.length > 0, 'the retained seven-day fixture must paint actual events');
  await live.page.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('7d');
  const recentLive = await settledAlerts(live.page);
  assert.deepEqual(recentLive.keys, recentKeys, 'a populated period also paints identical rows in order');
  assert.equal(recentLive.count, recentCount, 'the populated period has identical complete counts');
  await pooled.page.getByRole('combobox', { name: 'Date range', exact: true }).selectOption('today');
  await settledAlerts(pooled.page);
  console.log('PASS empty Today and populated seven-day windows both preserve exact pool/live results');
  await live.context.close();

  // 3. A CAPTURE THAT MOVED: the insider feed leaves the pool and is read from its capture; the
  // rows do not change, because the capture is what the pool was built from.
  served.status.captures.insider.revision = 'moved';
  const before = served.requests.length;
  await pooled.page.locator('[data-header-refresh]').click();
  await pooled.page.waitForFunction(async () => {
    const state = (await import('/js/data/alert-pool.js')).status();
    return state.feeds.insider && state.feeds.insider.pooled === false;
  }, null, { timeout: 120000 });
  await settledAlerts(pooled.page);
  await pooled.page.waitForTimeout(1500);
  assert(served.requests.slice(before).includes('/data/insider-trades.json'), 'the insider capture is downloaded once its revision moved');
  assert.deepEqual(captureReads(before).filter((path) => path !== '/data/insider-trades.json' && !path.startsWith('/data/insider-archive/')), [], 'the other pooled feeds stay pooled');
  assert.deepEqual(await rowKeys(pooled.page), pooledKeys, 'the rows are unchanged: the capture is what the pool was built from');
  const declined = await pooled.page.evaluate(async () => (await import('/js/data/alert-pool.js')).status().feeds);
  assert.equal(declined.insider.reason, 'insider: moved');
  assert.equal(declined.news.pooled, true);
  console.log('PASS a moved capture sends only its feed down the live path, with the same rows');
  served.status = JSON.parse(JSON.stringify(status));

  // 4. AI ALERTS FROM THE AI POOL: the month and day shards are read, no capture is, and the
  // cards are the live cards. The page is RELOADED first: the reader holds a capture status for
  // twenty seconds and the one it holds is the moved one this test served at step 3. A revision
  // never moves back on a deployment, so a fresh page is the honest way to un-move it here.
  await pooled.page.goto(`${origin}/#/research/ai-alerts?scope=universe`);
  const fromAi = served.requests.length;
  await pooled.page.reload();
  const pooledRanking = await settledRanking(pooled.page, 180000), pooledCards = pooledRanking.cards;
  const aiReads = poolReads(fromAi).filter((path) => path.includes('/ai/'));
  assert(aiReads.length >= index.ai.length, `every AI shard is read (${aiReads.length} of ${index.ai.length})`);
  assert.deepEqual(captureReads(fromAi).filter((path) => path !== '/data/insider-trades.json' && !path.startsWith('/data/insider-archive/')), [], `no pooled capture is downloaded for the ranking (${captureReads(fromAi).join(', ')})`);
  assert(pooledCards.length > 0, 'cards surface from the AI pool');
  const aiState = await pooled.page.evaluate(async () => (await import('/js/data/alert-pool.js')).status().feeds);
  assert(Object.values(aiState).every((state) => state.pooled), `every pooled feed came from the AI pool (${JSON.stringify(aiState)})`);
  const real = pooled.errors.filter((message) => !environment(message));
  assert.deepEqual(real, [], `zero console errors (${pooled.errors.length - real.length} environment failures dropped)`);
  // The completed card identities are the comparison input. Release the first
  // reader's retained history before loading the second full-history reader.
  await pooled.context.close();
  const liveAi = await openPage();
  await withoutPool(liveAi.page);
  await liveAi.page.goto(`${origin}/#/research/ai-alerts?scope=universe`);
  const liveRanking = await settledRanking(liveAi.page, 300000), liveCards = liveRanking.cards;
  assert.equal(pooledRanking.total, liveRanking.total, 'the AI pool retains the same complete company count as full history');
  assert.deepEqual(pooledCards, liveCards, 'the AI pool ranks the same companies in the same order as the full history');
  assert.deepEqual(liveAi.errors.filter(message => !environment(message)), [], 'zero live ranking console errors');
  console.log(`PASS AI Alerts from the AI pool: ${pooledCards.length} cards, identical to the live ranking`);
  await liveAi.context.close();

  console.log('PASS alert pool in the browser: exact rows, exact cards, honest fallback, zero console errors.');
} finally {
  await browser.close();
  server.close();
  if (!process.env.ALERT_POOL_DIR) rmSync(poolDir, { recursive: true, force: true });
}
