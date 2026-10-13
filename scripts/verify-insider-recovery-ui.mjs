// Isolated browser regression for failed opening reads, independent captures and returning readers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { EXCHANGE_SOURCES } from '../public/js/data/exchange-deals-shared.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = '2026-10-13T08:00:00Z', date = '2026-10-12';
const trade = name => ({ ticker: 'TEST', date, cells: { Insider: name, Transaction: 'Buy', 'Trade Shares': '100', 'Trade Category': 'Insider trade' } });
let capture = { kind: 'insider', capturedAt: at, coversUniverse: true, windowDays: 365,
  headers: ['Insider', 'Transaction', 'Trade Shares', 'Trade Category'], byTicker: { TEST: [trade('Alice')] } };
let exchange = { version: 1, checkedAt: at, updatedAt: at, records: [['nse-bulk', date, 'TEST', 'Test Company', 'Official fund', 'Buy', 10, 5, '']],
  sources: EXCHANGE_SOURCES.map(s => ({ ...s, ok: true, checkedAt: at, lastSuccessAt: at, coverage: [{ from: date, to: date }] })) };
let exchangeSeed = null;
let captureMode = 'failed', exchangeMode = 'failed', seedMode = 'failed', captureReads = 0, liveWalks = 0, upgraded = true;
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main>
<div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div>
<script type="module">
import * as tab from '/js/tabs/insider-trades.js';
import { insider as feed } from '/js/data/filings.js';
import * as coverage from '/js/data/coverage.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
coverage.prime({holdings:[{ticker:'TEST',name:'Test Company'}]});
window.feed=feed; window.tab=tab;
window.render=scope=>tab.render({root:document.querySelector('#root'),scope,data:{universe:[]},params:{},setParamsQuiet(){},live:{register(){},start(){},stop(){}}});
window.render('universe');
if (location.search.includes('upgrade')) {
  watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
  await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
}
window.ready=true;
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (path === '/' || path === '/index.html') { res.setHeader('content-type','text/html'); res.end(html); return; }
  if (path === '/data/insider-trades.json') {
    captureReads++;
    if (captureMode === 'failed') return json({ error: 'temporary delivery failure' }, 503);
    if (captureMode === 'malformed') return json({ capturedAt: at, byTicker: [] });
    return json(capture);
  }
  if (path === '/data/exchange-deals.json') return seedMode === 'failed' ? json({},503) : json(exchangeSeed || exchange);
  if (path === '/api/bulk-block-deals') return exchangeMode === 'failed' ? json({},503) : json(exchange);
  if (path.startsWith('/api/insider-trades/')) { liveWalks++; return json({},503); }
  if (path.startsWith('/api/') || path.includes('-archive/')) return json({},404);
  if (path === '/sdk-fixture.js') { res.setHeader('content-type','text/javascript'); res.end('/* isolated SDK */'); return; }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/-insider-more-filters-v\d+/, '-previous-insider-capture');
    }
    if (path === '/js/tabs/insider-trades.js' && !upgraded) body = `export const meta={};export const destroy=()=>{};export function render(ctx){ctx.root.innerHTML='<h2>This feed needs the Worker</h2>';}`;
    res.setHeader('content-type', {'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0,'127.0.0.1',done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const errors = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({status:404,body:''}));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({time:at});
  await page.goto(origin); await page.waitForFunction(() => window.ready && window.feed.isLoaded());
  assert.match(await page.locator('#root').innerText(), /capture is temporarily unavailable/);
  assert.doesNotMatch(await page.locator('#root').innerText(), /needs the Worker|wrangler|static files only/);
  assert.equal(liveWalks,0,'a failed shared capture cannot start a forty-company live walk');
  captureMode = 'ok';
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => window.feed.rows().some(row => row.cells.Insider === 'Alice'));
  assert.equal(await page.locator('[data-row-count]').innerText(),'1 trade from 1 company');
  assert.equal(await page.evaluate(() => window.feed.meta().snapshotReadError),null);
  assert(captureReads >= 2,'visible checks retry the independently captured Screener input');

  await page.getByRole('button',{name:'More filters (5)',exact:true}).click();
  await page.getByLabel('Transaction type',{exact:true}).selectOption('Buy');
  await page.getByRole('dialog',{name:'More filters (5)',exact:true}).getByRole('button',{name:'Done',exact:true}).click();
  const search = page.locator('[data-table-search]'); await search.fill('Alice'); await search.focus();
  capture = {...capture,capturedAt:'2026-10-13T08:02:00Z',byTicker:{TEST:[trade('Bob')]}};
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => window.feed.rows().some(row => row.cells.Insider === 'Bob'));
  assert.equal(await search.inputValue(),'Alice','arrivals preserve search');
  assert.equal(await page.getByLabel('Transaction type',{exact:true}).inputValue(),'Buy');
  assert.match(await page.locator('[data-row-count]').innerText(),/^1 trade/);
  assert.equal(await page.evaluate(() => window.feed.rows().length),2,'a smaller capture retains earlier history');
  await search.fill('');
  captureMode = 'malformed';
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => !!window.feed.meta().snapshotReadError);
  assert.equal(await page.evaluate(() => window.feed.rows().length),2,'an unreadable response retains history');
  const capturedAt = await page.evaluate(() => window.feed.meta().capturedAt);
  captureMode = 'failed'; await page.reload(); await page.waitForFunction(() => window.ready && window.feed.rows().length === 2);
  // Saved insider rows can paint before the independent exchange read settles. Finish that
  // failed opening read before advancing the frozen clock; recovery still comes from the poll.
  await page.evaluate(async () => (await import('/js/data/exchange-deals.js')).refresh());
  assert.equal(await page.evaluate(() => window.feed.meta().capturedAt),capturedAt,'failed reload reuses the validated whole capture and original source time');
  assert(await page.evaluate(() => !!window.feed.meta().snapshotReadError),'saved bytes do not turn a failed check into success');

  exchangeMode = 'ok';
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => window.feed.rows().some(row => row.cells.Insider === 'Official fund'));
  await page.waitForFunction(async () => !!(await (await import('/js/core/store.js')).readEntry('sattva:exchange-deals:api'))?.value);
  exchangeMode = 'failed'; seedMode = 'ok';
  exchangeSeed = {...exchange,checkedAt:'2026-10-13T07:00:00Z',updatedAt:'2026-10-13T07:00:00Z',records:[]};
  await page.reload();
  await page.waitForFunction(() => window.ready && window.feed.rows().some(row => row.cells.Insider === 'Official fund'));
  assert.equal(await page.evaluate(() => window.feed.meta().exchanges.updatedAt),at,'an older committed seed cannot hide newer saved API history');
  await page.waitForFunction(() => window.feed.meta().exchanges?.deliveryError?.includes('unavailable'));
  assert.match(await page.evaluate(() => window.feed.meta().exchanges.deliveryError),/unavailable/);

  // The live exchange route remains down while its independent committed input recovers.
  exchangeSeed = null;
  exchange = {...exchange,updatedAt:'2026-10-13T08:01:00Z',records:[...exchange.records,['nse-bulk',date,'TEST','Test Company','Second official fund','Sell',20,5,'']]};
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => window.feed.rows().some(row => row.cells.Insider === 'Second official fund'));
  assert.match(await page.evaluate(() => window.feed.meta().exchanges.deliveryError),/unavailable/);
  assert.equal(liveWalks,0);
  await page.evaluate(() => window.tab.destroy());
  const stopped = captureReads; await page.clock.fastForward(120000);
  assert.equal(captureReads,stopped,'inactive observers do not keep snapshot polling alive');
  captureMode = 'ok';
  await page.evaluate(() => window.render('portfolio'));
  await page.waitForFunction(() => !window.feed.meta().snapshotReadError);
  assert(captureReads > stopped,'returning to a stale view rechecks automatically');
  await context.close();

  // Real service-worker install, warm immutable modules and controller-change reload.
  upgraded = false;
  const warmContext = await browser.newContext(), warm = await warmContext.newPage();
  warm.on('pageerror', error => errors.push(error.message));
  await warm.goto(origin+'/?upgrade');
  await warm.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await warm.reload(); await warm.waitForFunction(() => window.ready);
  assert.match(await warm.locator('#root').innerText(),/needs the Worker/);
  await warm.evaluate(() => localStorage.setItem('insider-reader-preference','retained'));
  upgraded = true;
  await warm.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await warm.waitForFunction(() => !!document.querySelector('[data-score-table]'),null,{timeout:30000});
  assert.doesNotMatch(await warm.locator('#root').innerText(),/needs the Worker/);
  assert(await warm.getByRole('button',{name:'More filters (5)',exact:true}).isVisible(),'returning readers receive the compact toolbar');
  assert(!await warm.getByLabel('Transaction type',{exact:true}).isVisible());
  assert.equal(await warm.evaluate(() => localStorage.getItem('insider-reader-preference')),'retained');
  assert(!(await warm.evaluate(() => caches.keys())).some(key => key.includes('previous-insider-capture')));
  assert.deepEqual(errors,[]);
  console.log('PASS automatic failed-opening recovery, independent capture arrivals, retained reloads, honest failures, reader controls, inactive cleanup and warm service-worker upgrade.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
