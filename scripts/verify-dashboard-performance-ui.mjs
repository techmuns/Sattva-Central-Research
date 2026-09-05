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
let offline = false;
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
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    }[extname(path)] || 'application/octet-stream');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    res.end(readFileSync(path));
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
  assert(!cacheState.urls.some((url) => new URL(url).pathname.startsWith('/api/')), 'authenticated/API replies are never persisted');
  assert(!cacheState.urls.some((url) => /authorized-fixture|no-store-fixture/.test(url)),
    'Authorization and explicit no-store reads are never persisted');

  offline = true;
  const reloadedAt = Date.now();
  await page.reload();
  await page.getByRole('navigation', { name: 'Research navigation' }).waitFor({ timeout: 1500 });
  assert(Date.now() - reloadedAt < 1500, 'repeat visit paints from the app cache without waiting for the network');

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
    const tabMs = await page.evaluate(async (selected) => {
      const started = performance.now();
      document.querySelector(`[data-tab-id="${selected}"]`).click();
      const ready = () => document.querySelector(`[data-tab-id="${selected}"]`)?.getAttribute('aria-selected') === 'true' &&
        !!document.querySelector('#content-host')?.firstElementChild;
      while (!ready() && performance.now() - started < 500) await new Promise(requestAnimationFrame);
      return ready() ? performance.now() - started : null;
    }, id);
    assert(tabMs != null && tabMs < 500, `${id} opens immediately while revalidation is unavailable`);
  }

  await page.locator('[data-tab-id="ai-alerts"]').click();
  await page.getByRole('heading', { name: 'AI Alerts', exact: true }).waitFor({ timeout: 500 });

  const popupMs = await page.evaluate(async () => {
    const started = performance.now();
    document.querySelector('[data-sources-open]').click();
    const ready = () => !document.querySelector('#modal-overlay')?.classList.contains('hidden');
    while (!ready() && performance.now() - started < 300) await new Promise(requestAnimationFrame);
    return ready() ? performance.now() - started : null;
  });
  assert(popupMs != null && popupMs < 300, 'shared popups open without a network dependency');
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
  assert.deepEqual(errors, []);
  console.log('PASS: app-shell cache, offline repeat paint, immediate tab/popup actions, private-cache boundary and freshness-aware poll restart.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
