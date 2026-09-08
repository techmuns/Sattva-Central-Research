#!/usr/bin/env node
// Real browser/News table with local immutable parts. Never calls a live collector or publisher.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeNewsJson } from './lib/news-json-storage.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, '');
const fixture = mkdtempSync(join(tmpdir(), 'sattva-news-browser-'));
const at = '2026-09-07T05:00:00Z';
const entity = { entityId: 'ISIN:INE089C01029', key: 'STLTECH', ticker: 'STLTECH', name: 'Sterlite Technologies Limited', legalName: 'Sterlite Technologies Limited' };
const row = n => ({ ticker: 'STLTECH', entityId: entity.entityId, company: entity.name,
  title: `Sterlite Technologies verified update ${n}`, summary: 'Source observation ₹ '.repeat(60),
  source: 'Fixture publisher', url: `https://example.test/news/${n}`, date: '2026-09-07', publishedAt: at });
let head = { capturedAt: at, entities: [entity], byTicker: { STLTECH: Array.from({ length: 440 }, (_, n) => row(n)) },
  archive: { index: 'company-news/index.json' }, empty: [], failed: {}, windowDays: 30 };
const save = () => writeNewsJson(join(fixture, 'news.json'), head, { maxBytes: 65536 });
save();
const old = { ...row('historical'), date: '2020-01-01', publishedAt: '2020-01-01T01:00:00Z' };
writeNewsJson(join(fixture, 'company-news/index.json'), { updatedAt: at, entities: [entity], archive: [{ file: 'company-news/2020-01.json', count: 1 }] });
writeNewsJson(join(fixture, 'company-news/2020-01.json'), { articles: [old] });
writeNewsJson(join(fixture, 'tradingview-news/latest.json'), { capturedAt: at, entities: [], byTicker: {}, tradingViewCoverage: {} });
let unavailable = null;
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/news.js';
import { recentNews as news, news as history } from '/js/data/filings.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({ holdings: [{ ticker: 'STLTECH', isin: 'INE089C01029', name: 'Sterlite Technologies Limited' }] });
window.newsTest = { feed: news, history };
await news.seed();
tab.render({ root: document.querySelector('#root'), scope: 'portfolio', live: { register() {}, start() {}, stop() {} } });
window.newsTest.ready = true;
</script>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (pathname === '/api/news') { res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, fetchedAt: at, articles: [row('manual-query')] })); return; }
  if (pathname === unavailable) { res.writeHead(503); res.end(); return; }
  const base = pathname.startsWith('/data/') ? fixture : root;
  const path = resolve(base, `.${pathname.replace(/^\/data/, '')}`);
  if (!path.startsWith(base + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const body = readFileSync(path);
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.setHeader('etag', '"' + createHash('sha256').update(body).digest('hex') + '"');
    res.setHeader('cache-control', 'no-cache');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin);
  await page.waitForFunction(() => window.newsTest?.ready);
  assert.equal(await page.evaluate(() => window.newsTest.feed.rows().length), 440);
  const search = page.locator('[data-table-search]');
  await search.fill('verified update 439');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('verified update 439'));
  await search.fill('verified update historical');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0, 'recent News excludes old history');
  assert.equal(await page.evaluate(async () => {
    await window.newsTest.history.seed();
    return window.newsTest.history.rows().some(row => row.title.includes('verified update historical'));
  }), true, 'full-history reader still delivers the archived article to All Alerts/research');
  head = { ...head, capturedAt: '2026-09-07T05:01:00Z', byTicker: { STLTECH: [...head.byTicker.STLTECH, row('fresh')] } };
  save();
  unavailable = '/data/' + JSON.parse(readFileSync(join(fixture, 'news.json')))._jsonShards.parts.at(-1).file;
  assert.equal(await page.evaluate(async () => (await window.newsTest.feed.refreshSnapshot()).partial), true);
  assert.equal(await page.evaluate(() => window.newsTest.feed.rows().length), 440, 'incomplete transport retains last-good news');
  unavailable = null;
  await page.evaluate(() => window.newsTest.feed.refreshSnapshot());
  await search.fill('verified update fresh');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('verified update fresh'));
  assert.equal(await page.evaluate(() => window.newsTest.feed.rows().length), 441);
  await page.reload();
  await page.waitForFunction(() => window.newsTest?.ready);
  assert.equal(await page.evaluate(() => window.newsTest.feed.rows().length), 441, 'reopening keeps recent news without widening the date window');
  assert.equal(await page.evaluate(async () => {
    await window.newsTest.feed.loadOne('STLTECH', { force: true });
    return window.newsTest.history.rows().some(row => row.title.includes('manual-query'));
  }), true, 'explicit live News query immediately reaches the shared All Alerts/research head');
  assert.deepEqual(errors, []);
  console.log('PASS browser: every part reaches the Portfolio News table; old history, incomplete refresh, recovery and reopening preserved.');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
  rmSync(fixture, { recursive: true, force: true });
}
