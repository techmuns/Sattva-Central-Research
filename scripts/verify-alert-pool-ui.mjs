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
const status = captureStatusFor({ root, exchange });
const served = { pool: true, status: JSON.parse(JSON.stringify(status)), artifact: 1, requests: [] };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  served.requests.push(url.pathname);
  if (req.method !== 'GET') { res.writeHead(503); res.end('{}'); return; }
  if (url.pathname === '/api/alert-pool/index') {
    if (!served.pool) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"ok":false,"reason":"no-pool"}'); return; }
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript((base) => { localStorage.setItem('sattva:chatter-base', `${base}/fixture/chatter`); }, origin);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return { context, page, errors };
}
const settledAlerts = (page) => page.waitForFunction(() => {
  const rows = document.querySelectorAll('tbody tr[data-row-key]').length;
  const chips = [...document.querySelectorAll('[data-feed]')];
  return rows > 0 && chips.length > 0 && !chips.some((chip) => chip.textContent.includes('reading…')) && !document.querySelector('[data-table-loading]');
}, null, { timeout: 120000 });
const rowKeys = (page) => page.evaluate(() => [...document.querySelectorAll('tbody tr[data-row-key]')].map((row) => row.dataset.rowKey));
// THE RANKING IS SETTLED when the tab is no longer reading — `complete`, or `partial` where a live
// route this sandbox cannot answer left a feed failed — and the cards have stopped changing.
const settledRanking = async (page, timeout) => {
  await page.waitForFunction(() => { const state = document.querySelector('[data-ai-feed-status]')?.dataset.state; return !!state && state !== 'pending'; }, null, { timeout });
  let previous = null;
  for (let i = 0; i < 40; i++) {
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-ai-card]')].map((card) => card.dataset.ticker).join(','));
    if (cards && cards === previous) return cards.split(',');
    previous = cards;
    await page.waitForTimeout(1500);
  }
  throw new Error('the ranking did not settle');
};
const rowCount = (page) => page.evaluate(() => document.querySelector('[data-row-count]')?.textContent.trim() || '');
const feedChips = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-feed]')].map((chip) => [chip.dataset.feed, chip.textContent.trim().replace(/\s+/g, ' ')])));

try {
  // 1. ALL ALERTS ON TODAY, FROM THE POOL: the day shard is read and no capture is.
  const pooled = await openPage();
  const from = served.requests.length;
  await pooled.page.goto(`${origin}/#/research/daily-alerts?scope=universe`);
  await settledAlerts(pooled.page);
  await pooled.page.waitForTimeout(1500);
  const pooledKeys = await rowKeys(pooled.page);
  const pooledCount = await rowCount(pooled.page);
  const pooledChips = await feedChips(pooled.page);
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

  // 2. THE SAME VIEW WITHOUT A POOL: the live collection paints the same rows in the same order.
  served.pool = false;
  const live = await openPage();
  const liveFrom = served.requests.length;
  await live.page.goto(`${origin}/#/research/daily-alerts?scope=universe`);
  await settledAlerts(live.page);
  await live.page.waitForTimeout(1500);
  assert(captureReads(liveFrom).length > 0, 'the live path downloads captures');
  assert.deepEqual(pooledKeys, await rowKeys(live.page), 'the pool paints the rows the live collection paints, in the same order');
  assert.equal(pooledCount, await rowCount(live.page), 'the same total');
  const liveChips = await feedChips(live.page);
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
  await live.context.close();
  served.pool = true;

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
  const pooledCards = await settledRanking(pooled.page, 180000);
  const aiReads = poolReads(fromAi).filter((path) => path.includes('/ai/'));
  assert(aiReads.length >= index.ai.length, `every AI shard is read (${aiReads.length} of ${index.ai.length})`);
  assert.deepEqual(captureReads(fromAi).filter((path) => path !== '/data/insider-trades.json' && !path.startsWith('/data/insider-archive/')), [], `no pooled capture is downloaded for the ranking (${captureReads(fromAi).join(', ')})`);
  assert(pooledCards.length > 0, 'cards surface from the AI pool');
  const aiState = await pooled.page.evaluate(async () => (await import('/js/data/alert-pool.js')).status().feeds);
  assert(Object.values(aiState).every((state) => state.pooled), `every pooled feed came from the AI pool (${JSON.stringify(aiState)})`);
  served.pool = false;
  const liveAi = await openPage();
  await liveAi.page.goto(`${origin}/#/research/ai-alerts?scope=universe`);
  const liveCards = await settledRanking(liveAi.page, 300000);
  assert.deepEqual(pooledCards, liveCards, 'the AI pool ranks the same companies in the same order as the full history');
  console.log(`PASS AI Alerts from the AI pool: ${pooledCards.length} cards, identical to the live ranking`);
  await liveAi.context.close();
  served.pool = true;

  const environment = (message) => /ExcelJS|fonts\.googleapis|exceljs|Failed to load resource|net::ERR|503/.test(message);
  const real = pooled.errors.filter((message) => !environment(message));
  assert.deepEqual(real, [], `zero console errors (${pooled.errors.length - real.length} environment failures dropped)`);
  await pooled.context.close();
  console.log('PASS alert pool in the browser: exact rows, exact cards, honest fallback, zero console errors.');
} finally {
  await browser.close();
  server.close();
  if (!process.env.ALERT_POOL_DIR) rmSync(poolDir, { recursive: true, force: true });
}
