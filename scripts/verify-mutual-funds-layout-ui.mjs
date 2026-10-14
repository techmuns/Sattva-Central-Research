// Full dashboard chrome with local source fixtures, shared navigation and short viewports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const seed = JSON.parse(readFileSync(resolve(root, 'data/mutual-funds/index.json')));
const template = seed.rows.find(row => row.comparableFunds > 0);
const rows = Array.from({ length: 1000 }, (_, i) => ({ ...template, isin: `INE${String(i).padStart(9, '0')}`,
  ticker: `TEST${i}`, name: `Fixture Company ${String(i).padStart(4, '0')}` }));
const capture = { ...seed, rows };
const bootstrap = `<script type="module">import * as coverage from '/js/data/coverage.js';import {mount} from '/js/ui/shell.js';
coverage.prime({holdings:${JSON.stringify(rows.slice(0, 3))}});window.AMFIBEAS_API_BASE=location.origin;
mount(document.querySelector('#app'));window.mfFeed=await import('/js/data/mutual-funds.js');</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (path === '/data/mutual-funds/index.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(capture)); return; }
  if (path === '/js/core/watch.js') { res.setHeader('content-type', 'text/javascript'); res.end('export const start=()=>{};export const ensureRunning=()=>{};export const refreshNow=async()=>{};'); return; }
  if (path === '/api/returns-ranking') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ asOfDate: new Date().toISOString().slice(0, 10), periods: ['1Y'], funds: [{ schemecode: 'fixture', fundName: 'Fixture Fund', classification: 'Equity : Large Cap', plan: 'direct', option: 'growth', cohortKey: 'large', returns: { '1Y': { return: 12, categoryAverage: 10, categoryMedian: 11, rank: 1, peerCount: 4 } } }] })); return; }
  if (path.startsWith('/api/') || path.startsWith('/data/')) { res.writeHead(404); res.end('{}'); return; }
  const pathname = path === '/' ? '/index.html' : path;
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    let body = readFileSync(file);
    if (pathname === '/index.html') body = body.toString().replace(/<script type="module" src="js\/app\.js"><\/script>/, bootstrap);
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  async function open() {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 500 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
    const page = await context.newPage();
    await page.goto(`${origin}/#/research/mutual-funds/company-holdings?scope=universe`);
    await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1000 companies');
    return { page, context };
  }
  const geometry = page => page.evaluate(() => {
    const table = document.querySelector('[data-table-scroll]').getBoundingClientRect();
    return { top: table.top, bottom: table.bottom, height: table.height, visible: Math.min(innerHeight, table.bottom) - table.top,
      toolbar: document.querySelector('[data-table-toolbar]').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  const { page, context } = await open();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('[data-table-scroll]').style.height);
  const newGeometry = await geometry(page);
  assert(newGeometry.toolbar <= 70, 'desktop controls fit in one row');
  assert.equal(await page.locator('#subview-mount').isVisible(), true);
  assert.equal(await page.locator('[data-mf-view]').count(), 0, 'view choices belong above the table');
  assert.deepEqual(await page.locator('#subview-mount [data-tab-id]').evaluateAll(tabs => tabs.map(tab => tab.dataset.tabId)),
    ['company-holdings', 'all-schemes', 'category-performance']);
  for (const [width, height] of [[1280, 800], [1024, 768], [390, 844], [1280, 500]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const table = document.querySelector('[data-table-scroll]').getBoundingClientRect();
      return Math.abs(table.height - Math.max(120, Math.floor(innerHeight - table.top - 24))) < 2;
    });
    const measured = await geometry(page); assert(!measured.overflow); assert(measured.height >= 120);
    assert(await page.locator('[data-mf-view], [data-mf-sort], [data-mf-coverage], [data-export]').evaluateAll(controls =>
      controls.every(control => {const rect=control.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth;})), 'every toolbar action stays reachable');
    await page.screenshot({ path: `/tmp/sattva-mf-layout-${width}x${height}.png` });
  }
  const search = page.getByLabel('Search Company', { exact: true });
  await search.fill('Fixture Company 0999');
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1 companies');
  assert(await page.getByText('Fixture Company 0999', { exact: true }).isVisible());
  await search.fill('');
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1000 companies');
  assert(await page.locator('[data-row-key]').count() < 100, 'rows stay bounded with every company searchable');
  await page.getByLabel('Sort mutual funds').selectOption('newest');
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await page.getByText('Mutual Fund coverage', { exact: true }).waitFor(); await page.keyboard.press('Escape');
  for (const subview of ['all-schemes', 'category-performance', 'company-holdings']) {
    await page.locator(`#subview-mount [data-tab-id="${subview}"]`).click();
    await page.locator(`#subview-mount [data-tab-id="${subview}"][aria-selected="true"]`).waitFor();
    assert(page.url().includes(subview) && page.url().includes('scope=universe'));
  }
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent === '1000 companies');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.screenshot({ path: '/tmp/sattva-mf-layout-dark.png' });
  assert.deepEqual(errors, []);
  console.log('PASS full-shell Mutual Funds layout, viewport resize, all views, scope, offscreen search and coverage', { newGeometry });
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
