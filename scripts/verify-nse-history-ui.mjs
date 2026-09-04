#!/usr/bin/env node
// Focused browser regression. All data is local, and every non-local request is blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const pwRoot = process.env.PLAYWRIGHT_ROOT;
if (!pwRoot) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${pwRoot}/index.mjs`);
const sterlite = { company: 'Sterlite Technologies Limited', ticker: 'STLTECH', publishedAt: '2026-09-03T16:02:07Z', subject: 'Analyst / Investor Meet', url: 'https://example.test/analyst.pdf' };
const old = { ...sterlite, publishedAt: '2026-08-12T10:00:00Z', subject: 'Old presentation', url: 'https://example.test/old.pdf' };
const other = { company: 'Other Company Limited', ticker: 'OTHER', publishedAt: '2026-09-04T05:00:00Z', subject: 'Updates', url: 'https://example.test/other.pdf' };
let snapshot = [sterlite];
let latest = [other];
let archiveBroken = false;
const json = (rows) => ({ ok: true, capturedAt: '2026-09-04T06:00:00Z', rows });
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head>
<body class="bg-slate-50 p-6"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/nse-filings.js';
import * as feed from '/js/data/nse-filings.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({ holdings: [{ ticker: 'STLTECH', name: 'Sterlite Technologies' }] });
const live = { register() {}, start() {}, stop() {} };
window.testNse = { feed, show(scope) { tab.render({ root: document.querySelector('#root'), scope, live }); } };
window.testNse.show('portfolio');
</script></body></html>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  let body;
  if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (pathname === '/api/nse-announcements') body = json(latest);
  else if (pathname === '/data/nse-announcements.json') body = json(snapshot);
  else if (pathname === '/data/nse-filings/index.json') body = { days: [{ day: '2026-08-12', count: 1, revision: 'one' }] };
  else if (pathname === '/data/nse-filings/2026-08-12.json') {
    if (archiveBroken) { res.writeHead(503); res.end(); return; }
    body = json([old]);
  }
  if (body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return; }
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date('2026-09-04T06:00:00Z') });
  await page.goto(origin);
  await page.locator('[data-table-search]').waitFor();
  await page.locator('[data-table-search]').fill('sterlite');
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1 of 1 filings shown');
  check('Sterlite is searchable in Portfolio despite absence from the live window', /Sterlite Technologies/.test(await page.locator('tbody').innerText()));
  check('the badge counts filings and companies separately', /Portfolio · 1 filing · 1 of 1 company/.test(await page.locator('#root').innerText()));
  await page.locator('[data-table-search]').fill('STLTECH');
  check('ticker search finds the same company', /Sterlite Technologies/.test(await page.locator('tbody').innerText()));
  snapshot = [];
  latest = [{ ...other, subject: 'New live update' }];
  await page.evaluate(() => window.testNse.feed.refresh());
  check('polling retains search text and historical results', await page.locator('[data-table-search]').inputValue() === 'stltech' && /Sterlite Technologies/.test(await page.locator('tbody').innerText()));
  check('polling does not interrupt typing in the search field', await page.locator('[data-table-search]').evaluate((el) => document.activeElement === el));
  await page.reload();
  await page.locator('[data-table-search]').waitFor();
  await page.locator('[data-table-search]').fill('sterlite');
  check('a page reload retains live-only device history', /Sterlite Technologies/.test(await page.locator('tbody').innerText()));
  await page.locator('[data-table-search]').fill('not-a-real-company');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('No captured filings match'));
  check('no match is never described as nobody having filed', !/None of your holdings has filed/.test(await page.locator('tbody').innerText()));
  await page.locator('[data-table-search]').fill('sterlite');
  archiveBroken = true;
  await page.locator('[data-nse-history]').selectOption('30');
  await page.getByRole('status').waitFor();
  check('failed historical requests produce a visible warning', /History is incomplete/.test(await page.getByRole('status').innerText()));
  archiveBroken = false;
  await page.evaluate(() => window.testNse.feed.refresh());
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '2 of 2 filings shown');
  check('retry restores older Sterlite filings inside the selected range', /Old presentation/.test(await page.locator('tbody').innerText()));
  await page.locator('[data-nse-history]').selectOption('7');
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1 of 1 filings shown');
  check('narrowing the date range excludes older filings', !/Old presentation/.test(await page.locator('tbody').innerText()));
  check('the layout fits the viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.NSE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.NSE_SCREENSHOT_PATH, fullPage: true });
  check('the browser raised no runtime errors', errors.length === 0);
  console.log(`\n${checks} NSE browser checks passed.`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
