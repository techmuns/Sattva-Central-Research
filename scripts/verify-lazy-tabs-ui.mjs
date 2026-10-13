#!/usr/bin/env node
// Code-only startup and delayed-navigation checks. No captured or private data is read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lazyTab } from '../public/js/core/lazy-tab.js';

// Concurrent mounts share loading; a rejected loader does not poison later attempts.
let attempts = 0;
let destroyed = 0;
const module = { render: ctx => ctx.value, destroy: () => destroyed++ };
const descriptor = lazyTab({ id: 'fixture' }, () => {
  if (++attempts === 1) throw Error('temporary failure');
  return module;
});
descriptor.destroy();
const first = descriptor.load();
assert.equal(first, descriptor.load());
await assert.rejects(first, /temporary failure/);
assert.equal(await descriptor.load(), module);
assert.equal(await descriptor.load(), module);
assert.equal(attempts, 2);
assert.equal(descriptor.render({ value: 42 }), 42);
descriptor.destroy();
assert.equal(destroyed, 1);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const reads = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/data/portfolio-companies.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ holdings: [{ ticker: 'SYNTHETIC', name: 'Synthetic company',
      isin: 'INE000000001', sector: 'Unclassified' }], count: 1, asOf: '2026-10-06' }));
    return;
  }
  // Deny before filesystem access. All source captures and APIs stay outside this test.
  if (pathname.startsWith('/data/') || pathname.startsWith('/api/') || req.method !== 'GET') {
    res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return;
  }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const bytes = await readFile(file);
    reads.push({ path: pathname, bytes: bytes.length });
    res.setHeader('content-type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  for (const colorScheme of ['light', 'dark']) {
    reads.length = 0;
    const context = await browser.newContext({ serviceWorkers: 'block', colorScheme });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue()
      : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    await page.goto(`${origin}/#/research/ask-research?scope=universe`);
    await page.locator('[data-active-tab="ask-research"]').waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), colorScheme);
    const scripts = reads.filter(row => row.path.startsWith('/js/'));
    assert.deepEqual(scripts.filter(row => row.path.startsWith('/js/tabs/')).map(row => row.path).sort(),
      ['/js/tabs/ai-alerts.js', '/js/tabs/ask-research.js', '/js/tabs/catalog.js', '/js/tabs/registry.js']);
    assert(!requests.includes('/data/institution-holdings.json'), 'unrelated holdings are not fetched at startup');
    assert.equal(await page.locator('[data-tab-id], [data-header-bookmarks]').count(), 8, 'all retained navigation remains available before its code loads');
    assert.deepEqual(await page.locator('[data-tab-id]').evaluateAll(tabs => tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])), [
      ['alerts', 'Alerts'], ['announcements', 'Announcements'], ['earnings', 'Earnings'],
      ['breakouts', 'Breakouts / Technical'], ['mutual-funds', 'Mutual Funds'],
      ['news-section', 'News'], ['super-investors', 'Super Investors'],
    ], 'navigation matches the requested parent order and labels');
    assert.equal(await page.locator('[data-tab-id="ask-research"]').count(), 0, 'Ask Research is absent from navigation, including on its saved route');
    assert.equal(await page.locator('[data-tab-id="nse-filings"]').count(), 0, 'NSE Filings is absent from navigation');
    await page.evaluate(() => { location.hash = '#/research/nse-filings?scope=universe'; });
    await page.locator('[data-active-tab="nse-filings"]').waitFor();
    await page.getByRole('heading', { name: 'NSE Filings', exact: true }).waitFor();

    await page.locator('#tabbar-mount [data-tab-id="alerts"]').click();
    await page.locator('[data-active-tab="ai-alerts"]').waitFor();
    assert.deepEqual(await page.locator('#subview-mount [data-tab-id]').evaluateAll(tabs =>
      tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])),
      [['ai-alerts', 'AI Alerts'], ['daily-alerts', 'All Alerts']]);
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="alerts"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#subview-mount').getAttribute('data-navigation'), 'group');
    assert(await page.locator('#subview-mount [data-tab-scroll-controls]').isHidden(), 'both alert subtabs fit without overflow controls');
    await page.evaluate(() => { window.alertSubtabs = document.querySelector('#subview-mount [data-tab-list]'); });
    await page.locator('#subview-mount [data-tab-id="ai-alerts"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#content-host').getAttribute('data-active-tab'), 'ai-alerts', 'arrows only move focus');
    await page.keyboard.press('Enter');
    await page.locator('[data-active-tab="daily-alerts"]').waitFor();
    assert(await page.evaluate(() => window.alertSubtabs === document.querySelector('#subview-mount [data-tab-list]')));
    assert(await page.locator('#subview-mount [data-tab-id="daily-alerts"]').evaluate(tab => document.activeElement === tab));
    await page.evaluate(() => { location.hash = '#/research/daily-alerts?scope=watchlist&company=SYNTHETIC'; });
    await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [aria-pressed="true"]')?.textContent.trim() === 'Watchlist');
    await page.locator('#tabbar-mount [data-tab-id="alerts"]').click();
    assert.match(page.url(), /daily-alerts\?scope=watchlist&company=SYNTHETIC/, 'active parent retains the reader and filters');
    await page.evaluate(() => { location.hash = '#/research/daily-alerts?scope=universe&company=SYNTHETIC'; });
    await page.locator('[data-active-tab="daily-alerts"]').waitFor();
    assert.equal(await page.locator('#subview-mount [data-tab-id="daily-alerts"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="alerts"]').getAttribute('aria-selected'), 'true');
    await page.goBack();
    await page.waitForFunction(() => location.hash.includes('scope=watchlist'));
    assert.equal(await page.locator('#subview-mount [data-tab-id="daily-alerts"]').getAttribute('aria-selected'), 'true');
    await page.goBack();
    await page.waitForFunction(() => location.hash.includes('/daily-alerts?scope=universe'));
    await page.goBack();
    await page.locator('[data-active-tab="ai-alerts"]').waitFor();
    assert.equal(await page.locator('#subview-mount [data-tab-id="ai-alerts"]').getAttribute('aria-selected'), 'true');
    await page.locator('#tabbar-mount [data-tab-id="announcements"]').click();
    await page.locator('[data-active-tab="corp-announcements"]').waitFor();
    assert.deepEqual(await page.locator('#subview-mount [data-tab-id]').evaluateAll(tabs =>
      tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])),
      [['corp-announcements', 'Corporate Announcements'], ['corporate-actions', 'Corporate Actions'], ['ipos', 'IPOs'], ['insider-trades', 'Bulk/Block Deal']]);
    assert.equal(await page.locator('#subview-mount [data-tab-id="corp-announcements"]').getAttribute('aria-selected'), 'true', 'Announcements defaults to Corporate Announcements');
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="announcements"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#subview-mount [data-tab-id="ai-alerts"]').count(), 0, 'the new parent replaces the previous group');
    await page.evaluate(() => { window.announcementSubtabs = document.querySelector('#subview-mount [data-tab-list]'); });
    await page.locator('#subview-mount [data-tab-id="corp-announcements"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#content-host').getAttribute('data-active-tab'), 'corp-announcements', 'subtab arrows only move focus');
    await page.keyboard.press('Enter');
    await page.locator('[data-active-tab="corporate-actions"]').waitFor();
    assert(await page.evaluate(() => window.announcementSubtabs === document.querySelector('#subview-mount [data-tab-list]')));
    assert(await page.locator('#subview-mount [data-tab-id="corporate-actions"]').evaluate(tab => document.activeElement === tab));
    await page.evaluate(() => { location.hash = '#/research/corporate-actions?scope=watchlist&company=SYNTHETIC'; });
    await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [aria-pressed="true"]')?.textContent.trim() === 'Watchlist');
    await page.locator('#tabbar-mount [data-tab-id="announcements"]').click();
    assert.match(page.url(), /corporate-actions\?scope=watchlist&company=SYNTHETIC/, 'active Announcements retains its reader and filters');
    await page.goBack();
    await page.waitForFunction(() => location.hash.includes('/corporate-actions?scope=universe'));
    await page.goBack();
    await page.locator('[data-active-tab="corp-announcements"]').waitFor();
    assert.equal(await page.locator('#subview-mount [data-tab-id="corp-announcements"]').getAttribute('aria-selected'), 'true', 'history restores the selected announcement reader');
    await page.locator('#tabbar-mount [data-tab-id="earnings"]').click();
    await page.locator('[data-active-tab="earnings-hub"]').waitFor();
    assert.deepEqual(await page.locator('#subview-mount [data-tab-id]').evaluateAll(tabs =>
      tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])),
      [['earnings-hub', 'Results'], ['concall', 'Concall']]);
    assert.equal(await page.locator('#subview-mount [data-tab-id="earnings-hub"]').getAttribute('aria-selected'), 'true', 'Earnings defaults to Results');
    await page.evaluate(() => { window.earningsSubtabs = document.querySelector('#subview-mount [data-tab-list]'); });
    await page.locator('#subview-mount [data-tab-id="earnings-hub"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#subview-mount [aria-selected="true"]').getAttribute('data-tab-id'), 'earnings-hub', 'arrows only move focus between Earnings readers');
    await page.keyboard.press('Enter');
    await page.locator('[data-active-tab="concall"]').waitFor();
    assert(await page.evaluate(() => window.earningsSubtabs === document.querySelector('#subview-mount [data-tab-list]')));
    assert(await page.locator('#subview-mount [data-tab-id="concall"]').evaluate(tab => document.activeElement === tab));
    await page.evaluate(() => { location.hash = '#/research/earnings-hub?scope=universe&view=filings&company=SYNTHETIC'; });
    await page.locator('#subview-mount [data-tab-id="earnings-hub"][aria-selected="true"]').waitFor();
    await page.locator('#tabbar-mount [data-tab-id="earnings"]').click();
    assert.match(page.url(), /earnings-hub\?scope=universe&view=filings&company=SYNTHETIC/, 'active Earnings retains the reader view and company filter');
    await page.goBack();
    await page.locator('#subview-mount [data-tab-id="concall"][aria-selected="true"]').waitFor();
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="earnings"]').getAttribute('aria-selected'), 'true', 'history restores Concall inside Earnings');
    await page.locator('#tabbar-mount [data-tab-id="news-section"]').click();
    await page.locator('[data-active-tab="news"]').waitFor();
    assert.deepEqual(await page.locator('#subview-mount [data-tab-id]').evaluateAll(tabs =>
      tabs.map(tab => [tab.dataset.tabId, tab.textContent.trim()])),
      [['news', 'Market News'], ['public-chatter', 'Public Chatter']]);
    await page.evaluate(() => { window.newsSubtabs = document.querySelector('#subview-mount [data-tab-list]'); });
    await page.locator('#subview-mount [data-tab-id="news"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#subview-mount [aria-selected="true"]').getAttribute('data-tab-id'), 'news');
    await page.keyboard.press('Enter');
    await page.locator('[data-active-tab="public-chatter"]').waitFor();
    assert(await page.evaluate(() => window.newsSubtabs === document.querySelector('#subview-mount [data-tab-list]')));
    assert(await page.locator('#subview-mount [data-tab-id="public-chatter"]').evaluate(tab => document.activeElement === tab));
    await page.evaluate(() => { location.hash = '#/research/public-chatter?scope=watchlist&topic=SYNTHETIC'; });
    await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [aria-pressed="true"]')?.textContent.trim() === 'Watchlist');
    await page.locator('#tabbar-mount [data-tab-id="news-section"]').click();
    assert.match(page.url(), /public-chatter\?scope=watchlist&topic=SYNTHETIC/, 'active News retains its reader, scope and topic');
    await page.locator('#subview-mount [data-tab-id="news"]').click();
    await page.locator('#subview-mount [data-tab-id="news"][aria-selected="true"]').waitFor();
    await page.goBack();
    await page.locator('[data-active-tab="public-chatter"]').waitFor();
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="news-section"]').getAttribute('aria-selected'), 'true');
    await page.evaluate(() => { location.hash = '#/research/public-chatter?scope=universe'; });
    await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [aria-pressed="true"]')?.textContent.trim() === 'Universe');
    await page.locator('#tabbar-mount [data-tab-id="announcements"]').click();
    await page.locator('[data-active-tab="corp-announcements"]').waitFor();
    await page.locator('#subview-mount [data-tab-id="insider-trades"]').click();
    await page.locator('[data-active-tab="insider-trades"]').waitFor();
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="announcements"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tabbar-mount [data-tab-id="insider-trades"]').count(), 0, 'deals only occupy their announcement subtab');
    await page.locator('#tabbar-mount [data-tab-id="mutual-funds"]').click();
    await page.locator('[data-active-tab="mutual-funds"]').waitFor();
    assert(await page.locator('#subview-mount').isHidden(), 'group subtabs leave with their parent');

    // Hold one real renderer request while the reader moves to another interface.
    let release;
    let requested;
    const held = new Promise(done => { release = done; });
    const arrived = new Promise(done => { requested = done; });
    await page.route('**/js/tabs/bookmarks.js', async route => {
      requested(); await held; await route.continue();
    });
    await page.locator('[data-header-bookmarks]').click();
    await arrived;
    assert(await page.locator('#content-host').evaluate(el => el.inert), 'obsolete controls stay covered while loading');
    await page.locator('#tabbar-mount [data-tab-id="announcements"]').click();
    await page.locator('[data-active-tab="corp-announcements"]').waitFor();
    release();
    // Await module evaluation itself, then allow its queued mount continuation to run.
    await page.evaluate(async () => {
      await import('/js/tabs/bookmarks.js');
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    assert.equal(await page.locator('#content-host').getAttribute('data-active-tab'), 'corp-announcements');
    assert.equal(await page.locator('#content-host').evaluate(el => el.inert), false);
    await page.locator('[data-header-bookmarks]').click();
    await page.locator('[data-active-tab="bookmarks"]').waitFor();
    await page.evaluate(() => { location.hash = '#/research/ask-research?scope=universe'; });
    await page.locator('[data-active-tab="ask-research"]').waitFor();
    assert.equal(requests.filter(path => path === '/js/tabs/ask-research.js').length, 1, 'repeat visits reuse the loaded interface');
    await page.route('**/js/tabs/ipos.js', route => route.fulfill({ status: 503, body: '' }));
    await page.locator('#tabbar-mount [data-tab-id="announcements"]').click();
    await page.locator('[data-active-tab="corp-announcements"]').waitFor();
    await page.locator('[data-tab-id="ipos"]').click();
    await page.getByText('This panel hit a snag', { exact: true }).waitFor();
    assert.equal(await page.locator('#content-host').evaluate(el => el.inert), false, 'a failed module cannot leave the cover stuck');
    await page.locator('[data-header-bookmarks]').click();
    await page.locator('[data-active-tab="bookmarks"]').waitFor();
    assert.deepEqual(errors, [], 'no application exceptions');
    console.log(`PASS: ${colorScheme}: ${scripts.length} startup modules / ${scripts.reduce((sum, row) => sum + row.bytes, 0)} bytes; delayed navigation and repeat visits.`);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
