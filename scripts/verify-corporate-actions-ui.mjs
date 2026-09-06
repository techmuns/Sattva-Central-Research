#!/usr/bin/env node

// Isolated browser regression. It uses local synthetic action rows and blocks every external read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = '2026-09-04T18:00:00.000Z';
const row = (ticker, company, purpose, type, exDate, screener = null) => ({
  ticker, company, isin: `INE${ticker.padEnd(9, '0').slice(0, 9)}`, series: 'EQ', purpose, actionType: type,
  faceValue: '10', exDate, recordDate: exDate, bookClosureStart: null, bookClosureEnd: null, source: 'NSE',
  sourceUrl: `https://www.nseindia.com/companies-listing/corporate-filings-actions?symbol=${ticker}&tabIndex=equity`,
  sources: screener ? ['NSE', 'Screener'] : ['NSE'],
  ...(screener ? { source: 'NSE + Screener', screener, screenerUrl: screener.sourceUrl, screenerCompanyUrl: screener.companyUrl } : {}),
  id: `${ticker}|EQ|${exDate}|${exDate}|${purpose}`,
});
const screener = (ticker, company, type, exDate, fields) => ({
  id: `${ticker}|${type}|${exDate}|${type === 'dividend' ? String(fields.dividendType || '').toLowerCase() : ''}`,
  companyKey: ticker, ticker, company, companyUrl: `https://www.screener.in/company/${ticker}/consolidated/`,
  actionType: type, exDate, catalogueKey: type === 'dividend' ? 'dividend:2026' : type,
  sourceUrl: `https://www.screener.in/actions/${type === 'rights' ? 'right' : type}/`, observedAt: at, ...fields,
});
const capture = {
  version: 1, capturedAt: at, requestedFrom: '2023-09-05', requestedTo: '2027-09-04', companyCount: 3,
  sources: { nse: { state: 'live', capturedAt: at }, screener: { state: 'live', capturedAt: at, fullHistory: true } },
  typeCounts: { dividend: 1, bonus: 1, rights: 1 },
  rows: [
    row('TCS', 'Tata Consultancy Services Limited', 'Dividend - Rs 10 Per Share', 'dividend', '2026-09-10', screener('TCS', 'Tata Consultancy Services Limited', 'dividend', '2026-09-10', { dividendType: 'Interim', percent: '100.00' })),
    row('INFY', 'Infosys Limited', 'Bonus 1:1', 'bonus', '2026-09-11'),
    row('NEWCO', 'New Company Limited', 'Rights 2:5', 'rights', '2026-09-12'),
  ],
};
let failed = false;
let delayMs = 0;
let reads = 0;
let responseCapture = capture;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body class="bg-slate-50 p-4"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/corporate-actions.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import {corporateActions as feed} from '/js/data/corporate-actions.js';
import * as engine from '/js/core/live.js';
const live={register(id,entry){window.poll=entry;engine.register(id,entry);},start(id){window.pollStarted=true;engine.start(id);},stop(id){window.pollStopped=true;engine.stop(id);}};
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
  if (pathname === '/embed') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><meta charset="utf-8"><iframe title="Corporate Actions" src="/" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>'); return; }
  if (pathname === '/data/corporate-actions.json') {
    reads += 1;
    response.setHeader('content-type', 'application/json');
    setTimeout(() => {
      response.statusCode = failed ? 503 : 200;
      response.end(JSON.stringify(failed ? {} : responseCapture));
    }, delayMs);
    return;
  }
  if (pathname === '/test/slow') { delayMs = 8000; response.end('ok'); return; }
  if (pathname === '/test/fail') { failed = true; response.end('ok'); return; }
  try {
    const file = resolve(root, `.${pathname}`); assert.ok(file.startsWith(root + sep));
    response.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    response.end(readFileSync(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.env.CORPORATE_ACTIONS_SERVE === '1') {
  console.log(`Corporate Actions local fixture: ${origin}`);
  await new Promise(() => {});
}
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
  assert.match(await page.locator('tbody').innerText(), /Interim · 100.00%/);
  assert.deepEqual(await page.locator('thead th').allInnerTexts(), ['PURPOSE', 'TYPE', 'EX DATE ▾', 'RECORD / END DATE', 'TERMS', 'SOURCE']);
  assert.equal(await page.locator('tbody a[href*="nseindia.com"]').count(), 1);
  assert.equal(await page.locator('tbody a[href*="screener.in"]').count(), 1);
  assert(await page.evaluate(() => window.pollStarted && window.poll.intervalMs === 90000));

  // Persist the capture, then reopen inside an iframe with an eight-second check.
  // Cached rows must be usable before that check, not after its timeout budget.
  await page.evaluate(async () => {
    const store = await import('/js/core/store.js');
    const saved = await store.readEntry(store.KEYS.corporateActions);
    await store.writeEntry(store.KEYS.corporateActions, saved);
  });
  delayMs = 8000;
  const beforeReads = reads;
  const start = performance.now();
  await page.goto(`${origin}/embed`);
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('[data-score-table]').waitFor({ timeout: process.env.CORPORATE_ACTIONS_BASELINE ? 15000 : 1500 });
  console.log(`Cached iframe table ready: ${Math.round(performance.now() - start)}ms (network check delayed 8000ms)`);
  if (!process.env.CORPORATE_ACTIONS_BASELINE) {
    assert.match(await frame.locator('[data-filings-info]').innerText(), /Checking/);
    await frame.locator('[data-table-search]').fill('Dividend');
    await frame.locator('[data-table-search]').evaluate(el => { window.retainedSearch = el; });
  }
  await frame.waitForFunction(() => window.feed.meta().origin === 'live' && !window.feed.meta().checking);
  assert.equal(reads - beforeReads, 1, 'cache restore and live start share one network check');
  if (!process.env.CORPORATE_ACTIONS_BASELINE) {
    assert(await frame.evaluate(() => window.retainedSearch === document.querySelector('[data-table-search]')), 'unchanged network confirmation keeps the focused controls mounted');
    assert.equal(await frame.locator('[data-table-search]').inputValue(), 'Dividend');
    assert.match(await frame.locator('[data-filings-info]').innerText(), /Up to date/);
  }
  delayMs = 0;
  await page.goto(origin);
  await page.locator('[data-score-table]').waitFor();

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
  assert.match(await page.locator('[data-filings-info]').innerText(), /Update unavailable/);

  failed = false;
  // Reject malformed responses before they overwrite the persistent last-good capture.
  responseCapture = { ...capture, rows: [] };
  await page.evaluate(() => window.poll.fetcher());
  assert.equal(await page.evaluate(async () => {
    const store = await import('/js/core/store.js');
    return (await store.readEntry(store.KEYS.corporateActions)).value.rows.length;
  }), 3);
  responseCapture = { ...capture, sources: { ...capture.sources, screener: { state: 'retained', capturedAt: at } } };
  await page.evaluate(() => window.poll.fetcher());
  assert.match(await page.locator('[data-filings-info]').innerText(), /freshness unconfirmed/);
  responseCapture = capture;
  await page.evaluate(() => window.poll.fetcher());
  assert.match(await page.locator('[data-filings-info]').innerText(), /Up to date/);

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
