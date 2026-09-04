#!/usr/bin/env node

// Isolated browser regression. It uses local synthetic action rows and blocks every external read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = '2026-09-04T18:00:00.000Z';
const row = (ticker, company, purpose, type, exDate) => ({
  ticker, company, isin: `INE${ticker.padEnd(9, '0').slice(0, 9)}`, series: 'EQ', purpose, actionType: type,
  faceValue: '10', exDate, recordDate: exDate, bookClosureStart: null, bookClosureEnd: null, source: 'NSE',
  sourceUrl: `https://www.nseindia.com/companies-listing/corporate-filings-actions?symbol=${ticker}&tabIndex=equity`,
  id: `${ticker}|EQ|${exDate}|${exDate}|${purpose}`,
});
const capture = {
  version: 1, capturedAt: at, requestedFrom: '2023-09-05', requestedTo: '2027-09-04', companyCount: 3,
  typeCounts: { dividend: 1, bonus: 1, rights: 1 },
  rows: [
    row('TCS', 'Tata Consultancy Services Limited', 'Dividend - Rs 10 Per Share', 'dividend', '2026-09-10'),
    row('INFY', 'Infosys Limited', 'Bonus 1:1', 'bonus', '2026-09-11'),
    row('NEWCO', 'New Company Limited', 'Rights 2:5', 'rights', '2026-09-12'),
  ],
};
let failed = false;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/style.css"></head><body class="bg-slate-50 p-4"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/corporate-actions.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import {corporateActions as feed} from '/js/data/corporate-actions.js';
const live={register(id,entry){window.poll=entry;},start(){window.pollStarted=true;},stop(){window.pollStopped=true;}};
coverage.prime({holdings:[{ticker:'TCS',name:'Tata Consultancy Services'}]});
watchlist.add('INFY','Infosys');
window.renderScope=(scope)=>{const root=document.querySelector('#root');root.innerHTML='';tab.render({root,scope,live,data:{universe:[]},params:{}});};
window.addNewHolding=()=>{coverage.prime({holdings:[...coverage.holdings(),{ticker:'NEWCO',name:'New Company'}]});window.renderScope('portfolio');};
window.feed=feed;window.destroyTab=()=>tab.destroy();window.renderScope('portfolio');
</script></body></html>`;

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (pathname === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (pathname === '/data/corporate-actions.json') {
    response.setHeader('content-type', 'application/json');
    response.statusCode = failed ? 503 : 200;
    response.end(JSON.stringify(failed ? {} : capture));
    return;
  }
  if (pathname === '/test/fail') { failed = true; response.end('ok'); return; }
  try {
    const file = resolve(root, `.${pathname}`); assert.ok(file.startsWith(root + sep));
    response.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    response.end(readFileSync(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.setFixedTime(new Date(at));
  await page.goto(origin);
  await page.locator('[data-score-table]').waitFor();
  assert.match(await page.locator('[data-row-count]').innerText(), /^1 action · 1 company$/);
  assert.match(await page.locator('tbody').innerText(), /Dividend - Rs 10 Per Share/);
  assert.deepEqual(await page.locator('thead th').allInnerTexts(), ['PURPOSE', 'TYPE', 'EX DATE ▾', 'RECORD DATE', 'FACE VALUE', 'SOURCE']);
  assert.equal(await page.locator('tbody a[href*="nseindia.com"]').count(), 1);
  assert(await page.evaluate(() => window.pollStarted && window.poll.intervalMs === 90000));

  await page.evaluate(() => window.renderScope('universe'));
  await page.locator('[data-table-filter="0"]').selectOption('bonus');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'action-type filter narrows the exchange-wide feed');
  await page.evaluate(() => window.renderScope('watchlist'));
  assert.match(await page.locator('[data-row-count]').innerText(), /^1 action · 1 company$/);
  assert.match(await page.locator('tbody').innerText(), /Bonus 1:1/);

  await page.evaluate(() => window.addNewHolding());
  assert.match(await page.locator('[data-row-count]').innerText(), /^2 actions · 2 companies$/);
  assert.match(await page.locator('tbody').innerText(), /Rights 2:5/);

  await page.evaluate(() => fetch('/test/fail'));
  await page.evaluate(() => window.poll.fetcher());
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 2, 'a failed refresh retains the valid rows');
  assert.match(await page.evaluate(() => window.feed.meta().degraded), /retained copy/);

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('[data-table-search]').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.destroyTab());
  assert(await page.evaluate(() => window.pollStopped));
  assert.deepEqual(errors, []);
  console.log('PASS corporate actions table, scope filters, new holdings, failure retention, mobile layout and polling cleanup');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
