#!/usr/bin/env node
// Real service worker + browser cache behavior. All data is local; external calls are blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_ROOT) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
// GitHub's shared runner can execute headless Chromium at roughly half local CPU speed. Keep the
// interaction budget strict enough to catch network-bound navigation while allowing one loaded,
// synchronous table render to complete under that measured slowdown.
const TAB_INTERACTION_LIMIT_MS = 1000;
const POPUP_INTERACTION_LIMIT_MS = 600;
let offline = false;
let previousRelease = true;
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url.pathname);
  if (offline) { res.writeHead(503, { 'cache-control': 'no-store' }); res.end('offline'); return; }
  if (['/api/private-fixture', '/data/authorized-fixture.json', '/data/no-store-fixture.json'].includes(url.pathname)) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"private":true}');
    return;
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    }[extname(path)] || 'application/octet-stream');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    if (pathname === '/sw.js') {
      const source = readFileSync(path, 'utf8');
      res.end(previousRelease ? source.replace(/const CACHE_NAME = ([^;\n]+);/, 'const CACHE_NAME = $1 + "-previous-fixture";') : source);
    } else if (pathname === '/js/core/watchlist.js') {
      res.end(`${readFileSync(path, 'utf8')}\nglobalThis.__watchlistRelease = ${JSON.stringify(previousRelease ? 'previous' : 'current')};`);
    } else if (pathname === '/js/core/app-updates.js') {
      res.end(`${readFileSync(path, 'utf8')}\nglobalThis.__performanceRelease = ${JSON.stringify(previousRelease ? 'previous' : 'current')};`);
    } else res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByRole('navigation', { name: 'Research navigation' }).waitFor();
  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.evaluate(async () => {
    await fetch('/api/private-fixture');
    await fetch('/data/authorized-fixture.json', { headers: { authorization: 'Bearer test-only' } });
    await fetch('/data/no-store-fixture.json', { cache: 'no-store' });
  });

  const cacheState = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith('sattva-dashboard-'));
    const entries = names.length ? await (await caches.open(names[0])).keys() : [];
    return { names, urls: entries.map((request) => request.url) };
  });
  assert.equal(cacheState.names.length, 1, 'one current app cache is active');
  assert(cacheState.urls.filter((url) => url.includes('/js/')).length > 90, 'complete native module graph is warm');
  assert(cacheState.urls.some((url) => url.endsWith('/data/portfolio-companies.json')), 'critical portfolio identity snapshot is warm');
  for (const asset of ['sattva-ventures-wordmark.png', 'sattva-ventures-mark.svg', 'favicon.svg']) {
    assert(cacheState.urls.some(url => url.endsWith(`/assets/brand/${asset}`)), 'product identity is available on an offline repeat visit');
  }
  for (const asset of ['/js/theme-init.js', '/js/ui/theme-toggle.js', '/css/theme.css']) {
    assert(cacheState.urls.some((url) => url.endsWith(asset)), `${asset} is available offline`);
  }
  assert(!cacheState.urls.some((url) => new URL(url).pathname.startsWith('/api/')), 'authenticated/API replies are never persisted');
  assert(!cacheState.urls.some((url) => /authorized-fixture|no-store-fixture/.test(url)),
    'Authorization and explicit no-store reads are never persisted');

  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  offline = true;
  const reloadedAt = Date.now();
  await page.reload();
  await page.getByRole('navigation', { name: 'Research navigation' }).waitFor({ timeout: 1500 });
  assert(Date.now() - reloadedAt < 1500, 'repeat visit paints from the app cache without waiting for the network');
  await page.locator('[data-brand-mark] img').evaluate(image => image.decode());
  await page.locator('.research-opening-brand').evaluate(image => image.decode());
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'cached app restores the saved theme');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(11, 18, 32)', 'cached dark styles are applied');

  const scrollMs = await page.evaluate(async () => {
    const list = document.querySelector('[data-tab-list]');
    const before = list.scrollLeft;
    const started = performance.now();
    document.querySelector('[data-tab-scroll="1"]').click();
    while (list.scrollLeft <= before && performance.now() - started < 500) {
      await new Promise(requestAnimationFrame);
    }
    return list.scrollLeft > before ? performance.now() - started : null;
  });
  assert(scrollMs != null && scrollMs < 500, 'tab-strip scroll button responds locally');

  const tabIds = ['ask-research', 'ai-alerts', 'daily-alerts', 'earnings-hub', 'concall', 'public-chatter',
    'breakouts', 'super-investors', 'news', 'ipos', 'corp-announcements', 'nse-filings', 'insider-trades'];
  for (const id of tabIds) {
    const started = Date.now();
    await page.locator(`[data-tab-id="${id}"]`).click();
    await page.waitForSelector(`#content-host[data-active-tab="${id}"]`, { timeout: TAB_INTERACTION_LIMIT_MS });
    const tabMs = Date.now() - started;
    assert(tabMs < TAB_INTERACTION_LIMIT_MS,
      `${id} opens immediately while revalidation is unavailable (${tabMs}ms)`);
  }

  await page.locator('[data-tab-id="ai-alerts"]').click();
  // This revisit has the same one-second offline tab budget as the sweep above. A separate
  // 500ms setup timeout made the popup check intermittently fail on the shared runner before
  // the popup was even opened, despite the navigation satisfying its documented budget.
  await page.getByRole('heading', { name: 'AI Alerts', exact: true }).waitFor({ timeout: TAB_INTERACTION_LIMIT_MS });

  const started = Date.now();
  await page.locator('[data-sources-open]').click();
  await page.waitForSelector('#modal-overlay:not(.hidden)', { timeout: POPUP_INTERACTION_LIMIT_MS });
  const popupMs = Date.now() - started;
  assert(popupMs != null && popupMs < POPUP_INTERACTION_LIMIT_MS,
    `shared popups open without a network dependency (${popupMs ?? 'not ready'}ms)`);
  await page.locator('[data-modal-close]').first().click();

  const restartHits = await page.evaluate(async () => {
    const live = await import('/js/core/live.js');
    window.__perfPolls = 0;
    live.register('performance-restart-check', { intervalMs: 5000, fetcher: async () => ++window.__perfPolls });
    live.start('performance-restart-check');
    await new Promise((done) => setTimeout(done, 40));
    live.stop('performance-restart-check');
    live.start('performance-restart-check');
    await new Promise((done) => setTimeout(done, 80));
    live.stop('performance-restart-check');
    return window.__perfPolls;
  });
  assert.equal(restartHits, 1, 'tab re-entry resumes the cadence instead of duplicating a fresh request');
  assert.equal(await page.evaluate(() => globalThis.__performanceRelease), 'previous', 'the returning reader is running the older cached module graph');
  assert.equal(await page.evaluate(() => globalThis.__watchlistRelease), 'previous', 'the cached watchlist module belongs to the older release');
  offline = false;
  previousRelease = false;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(() => globalThis.__performanceRelease === 'current', null, { timeout: 30000 });
  await page.waitForFunction(() => globalThis.__watchlistRelease === 'current', null, { timeout: 30000 });
  const upgradedCaches = await page.evaluate(() => caches.keys());
  assert(!upgradedCaches.some(name => name.includes('previous-fixture')), 'activation removes the superseded app cache');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'automatic upgrade retains reader preferences');
  assert.deepEqual(errors, []);
  console.log('PASS: app-shell cache, offline repeat paint, immediate tab/popup actions, private-cache boundary, freshness-aware poll restart and automatic warm-session release upgrade.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
