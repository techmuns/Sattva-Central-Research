// A returning reader must replace warm immutable modules before the new link policy is visible.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';
import { renderFilingPage } from '../worker/filing-page.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const src = 'https://nsearchives.nseindia.com/corporate/xbrl/SAIIM_19824_WebXMLFile_20260924_130926074.xml';
const filing = parseXbrlFiling(readFileSync('scripts/fixtures/nse-xbrl/analyst-meet-pbfintech.xml', 'utf8'));
let upgraded = false;
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css">
<button id="open">Read filing</button><a id="source" href="${src}" target="_blank">Source</a>
<div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div>
<script type="module">
import { installFilingReader, openFilingReader } from '/js/ui/xbrl-filing.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
installFilingReader();document.querySelector('#open').onclick=()=>openFilingReader(${JSON.stringify(src)});
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
// Model the prior footer while serving the real dependency graph and real service worker.
const previousReader = `export function installFilingReader() {};
export function openFilingReader(url) { document.querySelector('#modal-content').innerHTML =
  '<a data-old-original target="_blank" href="'+url+'">Open the original file on NSE</a>'; }`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-cache');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/nse-filing') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...filing, url: src })); return; }
    if (url.pathname === '/filing') { res.setHeader('content-type', 'text/html'); res.end(renderFilingPage({ filing, url: src })); return; }
    if (url.pathname === '/sdk-fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end('/* isolated SDK */'); return; }
    const file = resolve(root, '.' + url.pathname); if (!file.startsWith(root + sep)) throw Error();
    let body = readFileSync(file);
    if (url.pathname === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-nse-release`;');
    }
    if (url.pathname === '/js/ui/xbrl-filing.js' && !upgraded) body = previousReader;
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForFunction(() => window.ready);
  await page.locator('#open').click();
  assert.equal(await page.locator('[data-old-original]').getAttribute('href'), src);
  assert.ok((await page.evaluate(() => caches.keys())).some(key => key.includes('previous-nse-release')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => window.ready && document.querySelector('#source').pathname === '/filing');
  await page.locator('#open').click(); await page.locator('[data-xbrl-page]').waitFor();
  assert.match(await page.locator('[data-xbrl-panel]').innerText(), /25 fields as filed/);
  const [opened] = await Promise.all([page.waitForEvent('popup'), page.locator('[data-xbrl-page]').click()]);
  await opened.waitForLoadState('domcontentloaded');
  assert.equal(new URL(opened.url()).pathname, '/filing');
  assert.match(await opened.locator('body').innerText(), /Sell side Analyst Call/);
  assert.equal(await opened.getByRole('link', { name: /raw XML/ }).isVisible(), false);
  assert.ok(!(await page.evaluate(() => caches.keys())).some(key => key.includes('previous-nse-release')));
  await opened.close();
  await page.reload(); await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('#open').innerText(), 'Read filing', 'the filing must not replace the cached dashboard shell');
  await context.setOffline(true); await page.reload(); await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('#open').innerText(), 'Read filing', 'the dashboard shell remains available offline');
  assert.deepEqual(errors, []);
  console.log('PASS a warm returning session upgrades automatically and opens the reported PB Fintech filing as a readable page');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
