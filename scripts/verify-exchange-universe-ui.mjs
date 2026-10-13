// Real editor, exchange data and service worker; no production calls or shared-list writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { buildExchangeUniverse } from '../public/js/data/exchange-universe.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false, failed = false, delayed = false, releaseReads, onHeldRead;
let heldReads = Promise.resolve();
let directoryReads = 0;
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
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
    if (path === '/data/announcement-identities.json' || path === '/data/filing-capture/nse-identities.json') {
      directoryReads++;
      const body = JSON.stringify(path.includes('nse-identities') ? nse : bse);
      if (delayed) { onHeldRead?.(); await heldReads; }
      if (failed) { res.writeHead(503).end(); return; }
      const tag = `"${createHash('sha256').update(body).digest('hex')}"`;
      res.setHeader('etag', tag);
      if (req.headers['if-none-match'] === tag) { res.writeHead(304).end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(body); return;
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
  const holdOlderDirectoryRead = async () => {
    // Drain initial preparation, then hold both old responses before changing the source.
    await page.evaluate(async () => (await import('/js/data/listed-companies.js')).load());
    delayed = true;
    heldReads = new Promise(resolve => { releaseReads = resolve; });
    const started = new Promise(resolve => {
      let count = 0;
      onHeldRead = () => { if (++count === 2) resolve(); };
    });
    await page.evaluate(() => { void import('/js/data/listed-companies.js').then(listed => { window.olderDirectoryRead = listed.load(); }); });
    await started;
  };
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
  assert(await page.evaluate(async () => {
    const listed = await import('/js/data/listed-companies.js'), before = listed.all();
    await listed.load(); return listed.all() === before;
  }), 'real conditional HTTP reads preserve unchanged company objects');
  // A slower device must still accept keystrokes across the complete directory. Measure the
  // handler and following painted frames inside the browser, excluding automation setup.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (const query of ['a', 'dp abhushan', 'INE266Y01019', '544161', 'zzzz-unmatched', '']) {
    const timing = await page.evaluate(async query => {
      const el = document.querySelector('[data-scope-search]'), start = performance.now();
      el.value = query; el.dispatchEvent(new Event('input', { bubbles: true }));
      const handlerMs = performance.now() - start;
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      return { handlerMs, paintMs: performance.now() - start };
    }, query);
    assert(timing.handlerMs < 150 && timing.paintMs < 250,
      `complete-directory search stays responsive at 4x CPU slowdown (${JSON.stringify(timing)})`);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
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
  // Hold both older HTTP replies before publishing the listing and returning to the editor.
  // The visibility event must schedule a subsequent check, rather than reuse those old replies.
  await holdOlderDirectoryRead();
  bse.entries.push({ isin: 'INE999Z01011', ticker: 'NEWLISTED', bseCode: '599999', bseSymbol: 'NEWLISTED', name: 'New Listed Company', status: 'Active' });
  bse.capturedAt = new Date().toISOString();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  delayed = false; onHeldRead = null; releaseReads();
  await countIs(expected.length + 1);
  await page.locator('[data-scope-search]').fill('NEWLISTED');
  assert(await page.locator('[data-scope-remove="ticker:NEWLISTED"]').isVisible(), 'new listings appear on return without manual Refresh');
  assert(/BSE:|NSE main board:|NSE SME:/.test(await page.locator('[data-universe-status]').innerText()));
  await holdOlderDirectoryRead();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  bse.entries.push({ isin: 'INE999Z01029', ticker: 'REOPENLIST', bseCode: '599998', bseSymbol: 'REOPENLIST', name: 'Listing Published Before Reopen', status: 'Active' });
  bse.capturedAt = new Date().toISOString();
  await page.locator('#open-universe').click();
  delayed = false; onHeldRead = null; releaseReads();
  await countIs(expected.length + 2);
  await page.locator('[data-scope-search]').fill('REOPENLIST');
  assert(await page.locator('[data-scope-remove="ticker:REOPENLIST"]').isVisible(), 'reopening during an older read captures the subsequently published listing');
  failed = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => /saved|unavailable|revalidated/i.test(document.querySelector('[data-universe-status]')?.textContent));
  await countIs(expected.length + 2);
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
  await page.clock.install();
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  const hiddenReads = directoryReads;
  await page.clock.fastForward(90_001);
  assert.equal(directoryReads, hiddenReads, 'a hidden editor does not poll the exchange directories');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !document.querySelector('[data-scope-members]').classList.contains('hidden'));
  await page.evaluate(async () => { await (await import('/js/data/listed-companies.js')).load(); });
  assert(directoryReads > hiddenReads, 'returning to the editor rechecks the sources');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  delayed = true;
  heldReads = new Promise(resolve => { releaseReads = resolve; });
  const warmStart = performance.now();
  await page.evaluate(() => {
    window.openUniverse();
    if (!document.querySelector('[data-scope-member]') || document.querySelector('[data-scope-list-panel]').classList.contains('hidden'))
      throw Error('Warm opening waited for the directory network request');
  });
  const warmMs = performance.now() - warmStart; // Real elapsed time; the page clock is mocked above.
  assert(warmMs < 150, `warm names paint immediately (${warmMs.toFixed(1)}ms)`);
  await page.locator('[data-scope-search]').fill('DP Abhushan');
  await page.locator('[data-scope-remove="ticker:DPABHUSHAN"]').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  delayed = false; releaseReads();
  await page.evaluate(async () => { await (await import('/js/data/listed-companies.js')).load(); });
  // New module instance / returning page restores durable names even while the server is held.
  delayed = true; heldReads = new Promise(resolve => { releaseReads = resolve; });
  await page.reload();
  await countIs(expected.length + 2);
  assert(/Saved company list/.test(await page.locator('[data-universe-status]').innerText()));
  await page.locator('[data-scope-search]').fill('DP Abhushan');
  await page.locator('[data-scope-remove="ticker:DPABHUSHAN"]').waitFor({ state: 'visible' });
  failed = true; delayed = false; releaseReads();
  await page.waitForFunction(() => /unavailable|revalidated/.test(document.querySelector('[data-universe-status]')?.textContent));
  await countIs(expected.length + 2);
  failed = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !/unavailable|revalidated|Saved company/.test(document.querySelector('[data-universe-status]')?.textContent));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const closedReads = directoryReads;
  await page.clock.fastForward(180_001);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(directoryReads, closedReads, 'closing the editor removes its poller and return listener');
  // A fresh reader has no saved directory when both initial reads fail. Returning to the
  // still-open editor must recover automatically, including revealing the previously hidden list.
  failed = true;
  const recovery = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  recovery.on('pageerror', e => errors.push(e.message));
  await recovery.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await recovery.goto(origin);
  await recovery.waitForFunction(() => /Could not read this list/.test(document.querySelector('[data-scope-loading]')?.textContent));
  failed = false;
  await recovery.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await recovery.waitForFunction(count => Number(document.querySelector('[data-scope-count]')?.textContent.replace(/,/g, '')) === count, expected.length + 2);
  assert(await recovery.locator('[data-scope-list-panel]').isVisible(), 'initial outages recover without reopening or manual Refresh');
  await recovery.close();
  assert.deepEqual(errors, []);
  console.log(`PASS returning 600-company session upgrades to ${expected.length} exchange listings; full-list scrolling/search, persisted exclusions, new listings during return/reopen races, source failures, delayed-network cached openings (${warmMs.toFixed(1)}ms), offline reloads and responsive themes.`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
