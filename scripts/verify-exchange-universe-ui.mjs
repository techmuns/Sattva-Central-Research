// Real editor, exchange data and service worker; no production calls or shared-list writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { buildExchangeUniverse } from '../public/js/data/exchange-universe.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false, failed = false;
const bse = JSON.parse(readFileSync(resolve(root, 'data/announcement-identities.json')));
const nse = JSON.parse(readFileSync(resolve(root, 'data/filing-capture/nse-identities.json')));
const expected = buildExchangeUniverse(bse, nse).companies;
const harness = `<script type="module">
import { openScopeEditor } from '/js/ui/scope-editor.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
document.querySelector('#app').innerHTML = '<button id="open-universe">Edit Universe</button>';
window.openUniverse = () => openScopeEditor({ scope: 'universe' });
document.querySelector('#open-universe').onclick = window.openUniverse;
watchWorkerChanges(navigator.serviceWorker, () => location.reload());
await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
window.ready = true; window.openUniverse();
</script>`;
const html = readFileSync(resolve(root, 'index.html'), 'utf8').replace('<script type="module" src="js/app.js"></script>', harness);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
    if (path === '/data/announcement-identities.json' || path === '/data/filing-capture/nse-identities.json') {
      if (failed) { res.writeHead(503).end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(path.includes('nse-identities') ? nse : bse)); return;
    }
    if (path.startsWith('/api/')) throw Error('fixture has no API');
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('outside fixture');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-600-company-universe`;');
    }
    if (path === '/js/ui/scope-editor.js' && !upgraded) body = `export function openScopeEditor() { document.querySelector('#modal-content').innerHTML = '<span data-scope-count>600</span>'; }`;
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
  const countIs = count => page.waitForFunction(count => Number(document.querySelector('[data-scope-count]')?.textContent.replace(/,/g, '')) === count, count);
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await countIs(600);
  await page.evaluate(() => localStorage.setItem('sattva:universe-upgrade-proof', 'retained'));
  assert((await page.evaluate(() => caches.keys())).some(k => k.includes('previous-600-company-universe')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await countIs(expected.length);
  assert.equal(await page.evaluate(() => localStorage.getItem('sattva:universe-upgrade-proof')), 'retained');
  assert(!(await page.evaluate(() => caches.keys())).some(k => k.includes('previous-600-company-universe')));
  assert(await page.locator('[data-scope-member]').count() <= 100, 'DOM stays bounded while every company remains reachable');
  await page.locator('[data-scope-members]').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(key => [...document.querySelectorAll('[data-scope-member]')].some(el => el.dataset.scopeMember === key), `ticker:${expected.at(-1).ticker}`);
  const dp = expected.find(c => c.ticker === 'DPABHUSHAN');
  for (const q of ['DP Abhushan', dp.isin, dp.bseCode]) {
    await page.locator('[data-scope-search]').fill(q);
    await page.locator('[data-scope-remove="ticker:DPABHUSHAN"]').waitFor({ state: 'visible' });
  }
  await page.locator('[data-scope-remove="ticker:DPABHUSHAN"]').click(); await countIs(expected.length - 1);
  assert(await page.evaluate(async () => !(await import('/js/data/scope.js')).scopeAllowsTicker('universe', 'DPABHUSHAN')));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload(); await countIs(expected.length - 1);
  await page.locator('[data-scope-search]').fill(dp.isin);
  await page.locator('[data-scope-result="0"]').click(); await countIs(expected.length);
  bse.entries.push({ isin: 'INE999Z01011', ticker: 'NEWLISTED', bseCode: '599999', bseSymbol: 'NEWLISTED', name: 'New Listed Company', status: 'Active' });
  bse.capturedAt = new Date().toISOString();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await countIs(expected.length + 1);
  await page.locator('[data-scope-search]').fill('NEWLISTED');
  assert(await page.locator('[data-scope-remove="ticker:NEWLISTED"]').isVisible(), 'new listings appear on return without manual Refresh');
  assert(/BSE:|NSE main board:|NSE SME:/.test(await page.locator('[data-universe-status]').innerText()));
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => /saved|unavailable|revalidated/i.test(document.querySelector('[data-universe-status]')?.textContent));
  await countIs(expected.length + 1);
  failed = false;
  await page.locator('[data-scope-search]').fill('');
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert(await page.locator('[data-scope-search]').isVisible());
    assert(await page.locator('[data-scope-members]').evaluate(el => el.scrollHeight > el.clientHeight));
    if (process.env.UNIVERSE_SCREENSHOTS) {
      mkdirSync(process.env.UNIVERSE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.UNIVERSE_SCREENSHOTS}/universe-${width}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS returning 600-company session upgrades to ${expected.length} exchange listings; full-list scrolling/search, persisted exclusions, new-listing recovery, source failures and responsive themes.`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
