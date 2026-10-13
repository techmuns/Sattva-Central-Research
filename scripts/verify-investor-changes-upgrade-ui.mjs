// Real immutable-cache upgrade and automatic capture recovery, with public local fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { indiaDay } from '../public/js/data/investor-changes.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
// 00:10 IST is still the previous UTC date: the upgrade must retain today's captured trades.
const at = '2026-10-13T18:40:00.000Z', today = indiaDay(at), root = resolve('public');
const oldDay = new Date(Date.parse(`${today}T00:00:00Z`) - 120 * 86400000).toISOString().slice(0, 10);
let upgraded = false, failed = false;
const trade = (ticker, date) => ({ ticker, date, cells: { Company: ticker, Insider: 'Example Investor', Transaction: 'Buy', 'Trade Category': 'Bulk deal', 'Trade Shares': '100', Price: '5', Exchange: 'NSE' } });
const capture = { kind: 'insider', capturedAt: at, coversUniverse: true, byTicker: { OWNED: [trade('OWNED', oldDay)], OTHER: [trade('OTHER', today)] }, empty: [], failed: {} };
const snapshot = { capturedAt: at, investors: [{ slug: 'example', name: 'Example Investor' }], books: {} };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><main id="fixture" class="p-4"></main><script type="module">
import { renderChanges } from '/js/investors/changes.js';
import * as investors from '/js/data/super-investors.js';
import * as coverage from '/js/data/coverage.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
coverage.prime({holdings:[{ticker:'OWNED',name:'Owned company'}]}); await investors.load();
const view = renderChanges({scope:'portfolio'}, {view:{audience:'investors',period:'quarter'}}); fixture.innerHTML = view.html; view.wire(fixture, []);
watchWorkerChanges(navigator.serviceWorker, () => location.reload());
await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; window.ready = true;
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/data/super-investors.json') return json(snapshot);
  if (path === '/api/super-investors') return json({ ok: true, investors: snapshot.investors, fetchedAt: at });
  if (path === '/data/holding-evidence.json') return json({ relations: [], holdings: [] });
  if (path === '/data/insider-trades.json') { if (failed) res.statusCode = 503; return json(failed ? {} : capture); }
  if (path === '/api/bulk-block-deals' || path === '/data/exchange-deals.json') return json({ version: 1, checkedAt: at, records: [], sources: [] });
  if (path.startsWith('/api/')) { res.writeHead(503).end(); return; }
  if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
  try {
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error();
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-investor-changes`;');
    }
    // A prior module graph with the former generic empty view stays immutable until SW adoption.
    if (path === '/js/investors/changes.js' && !upgraded) body = "export function renderChanges(){return {html:'<p data-old-changes>No matching trades in the available records for this period.</p>',wire(){}};}";
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForSelector('[data-old-changes]');
  assert((await page.evaluate(() => caches.keys())).some(k => k.includes('previous-investor-changes')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('[data-changes-ready="true"]');
  assert.equal(await page.locator('[data-old-changes]').count(), 0);
  assert.match(await page.locator('[data-changes-context]').innerText(), /Company scope: Portfolio/);
  assert.match(await page.locator('[data-changes-universe]').innerText(), /1 trade in Universe/);
  assert.match(await page.locator('[data-changes-history]').innerText(), /1 retained trade in Portfolio/);
  assert(!(await page.evaluate(() => caches.keys())).some(k => k.includes('previous-investor-changes')));
  await page.locator('[data-changes-history]').click();
  await page.locator('[data-changes-activity] [data-table-search]').fill('owned');
  failed = true;
  await page.clock.fastForward(61000);
  // Join the independent check before advancing time again; a slow failed read cannot
  // turn the next simulated minute into the completion time of this one.
  await page.evaluate(async () => { await (await import('/js/data/filings.js')).insider.refreshSnapshot(); });
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'), '1', 'failed checks retain older evidence');
  failed = false; capture.capturedAt = new Date(Date.parse(at) + 61000).toISOString();
  capture.byTicker.OWNED.push(trade('OWNED', today));
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.querySelector('[data-changes-panel]')?.dataset.activityTotal === '2');
  assert.equal(await page.locator('[data-changes-period]').inputValue(), 'itd');
  assert.equal(await page.locator('[data-changes-activity] [data-table-search]').inputValue(), 'owned');
  assert.equal(await page.locator('[data-changes-activity] [data-row-key]').count(), 2, 'automatic recovery exposes the new trade without losing history or filters');
  assert.deepEqual(errors, []);
  console.log('PASS returning investor Changes: immutable-cache upgrade, scope/history shortcuts, failed-check retention and automatic capture recovery with filters');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
