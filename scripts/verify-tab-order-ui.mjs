// Real pointer/touch gestures, browser preferences and a warm service-worker upgrade.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let previousRelease = false, upgradeFixture = false;
const ids = ['alerts', 'announcements', 'earnings', 'breakouts', 'insider-trades', 'mutual-funds', 'news-section', 'super-investors'];
const labels = ['Alerts', 'Announcements', 'Earnings', 'Breakouts / Technical', 'Bulk/Block Deal', 'Mutual Funds', 'News', 'Super Investors'];
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><style>
${readFileSync(resolve(root, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]}
body { padding: 20px; } #fixture { max-width: 1300px; }
</style><link rel="stylesheet" href="/css/theme.css"></head><body><main id="fixture"></main><div id="reader">Reader unchanged</div><script type="module">
import { tabBar } from '/js/ui/components.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
window.selections = []; window.mount = () => {
  window.dispose?.();
  const bar = tabBar({tabs: ${JSON.stringify(ids.map((id, i) => ({ id, label: labels[i] })))},
    activeId: 'alerts', orderKey: 'research', onSelect: id => { window.selections.push(id); bar.update(id); }});
  fixture.innerHTML = bar.html; window.dispose = bar.wire(fixture);
}; window.mount();
if (location.search.includes('worker')) {
  watchWorkerChanges(navigator.serviceWorker, () => location.reload());
  await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
}
window.ready = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  if (path === '/fixture.html' || (upgradeFixture && ['/', '/index.html'].includes(path))) {
    res.setHeader('content-type', 'text/html'); res.end(fixture); return;
  }
  if (path === '/data/portfolio-companies.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ holdings: [{ ticker: 'SYNTHETIC', name: 'Synthetic company', isin: 'INE000000001', sector: 'Unclassified' }], count: 1, asOf: '2026-10-06' })); return;
  }
  if (path.startsWith('/api/') || path.startsWith('/data/')) { res.writeHead(503).end('{}'); return; }
  if (path === '/sdk-fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end('/* isolated SDK */'); return; }
  try {
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + sep)) throw Error('invalid path');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (previousRelease) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-tab-release`;');
    }
    // Model a warm reader whose previous navigation component had no reorder behavior.
    if (previousRelease && path === '/js/ui/components.js') body = body.toString().replace('const defaults = tabs.map', 'orderKey = null; const defaults = tabs.map');
    res.setHeader('content-type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const order = page => page.locator('[data-tab-list] [data-tab-id]').evaluateAll(tabs => tabs.map(tab => tab.dataset.tabId));
const tab = (page, id) => page.locator(`[data-tab-id="${id}"]`);
async function drag(page, from, to, after = false) {
  const a = await tab(page, from).boundingBox(), b = await tab(page, to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width * (after ? .75 : .25), b.y + b.height / 2, { steps: 12 });
  await page.waitForFunction(() => document.querySelector('[data-tab-drop]'));
  await page.mouse.up();
}
try {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 800 }, colorScheme, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${origin}/fixture.html`); await page.waitForFunction(() => window.ready);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, colorScheme);
    await drag(page, 'news-section', 'alerts');
    assert.deepEqual(await order(page), ['news-section', ...ids.filter(id => id !== 'news-section')]);
    assert.deepEqual(await page.evaluate(() => window.selections), [], 'drop must not open another reader');
    assert.equal(await tab(page, 'alerts').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#reader').textContent(), 'Reader unchanged');
    assert.equal(await page.locator('[data-tab-drop], [data-tab-dragging]').count(), 0);
    await page.reload(); await page.waitForFunction(() => window.ready);
    assert.equal((await order(page))[0], 'news-section', 'saved layout survives reload');
    await tab(page, 'news-section').focus(); await page.keyboard.press('ArrowRight');
    assert(await tab(page, 'alerts').evaluate(node => node === document.activeElement), 'arrow focus follows the visible order');
    await page.keyboard.press('Alt+ArrowRight');
    assert.deepEqual((await order(page)).slice(0, 3), ['news-section', 'announcements', 'alerts']);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.selections), ['alerts'], 'native activation still works');
    await page.keyboard.press('Alt+Home'); assert.deepEqual(await order(page), ids);
    await drag(page, 'alerts', 'earnings', true);
    assert.deepEqual((await order(page)).slice(0, 3), ['announcements', 'earnings', 'alerts']);
    await page.keyboard.press('Alt+Home');
    const a = await tab(page, 'news-section').boundingBox(), b = await tab(page, 'alerts').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + 25, b.y + 20, { steps: 8 }); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await order(page), ids, 'Escape cancels a drag');
    await tab(page, 'earnings').click(); assert.equal(await tab(page, 'earnings').getAttribute('aria-selected'), 'true', 'a deliberate next click is not suppressed');
    // Storage failures remain usable and visibly disclose that persistence is unavailable.
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw Error('disabled'); }; });
    await tab(page, 'earnings').focus(); await page.keyboard.press('Alt+ArrowLeft');
    assert(await page.locator('.tab-order-status[data-unavailable]').isVisible());
    await page.evaluate(() => window.mount());
    assert.deepEqual((await order(page)).slice(0, 3), ['alerts', 'earnings', 'announcements'], 'memory retains the layout during this visit');
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(`${origin}/fixture.html`); await page.waitForFunction(() => window.ready);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
  let a = await tab(page, 'alerts').boundingBox();
  await touch('touchStart', a.x + a.width - 15, a.y + a.height / 2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', a.x + a.width - 15 - i * 8, a.y + a.height / 2);
  await touch('touchEnd');
  await page.waitForFunction(() => document.querySelector('[data-tab-list]').scrollLeft > 20);
  assert.deepEqual(await order(page), ids, 'swiping the label scrolls without reordering');
  // Finish the swipe fixture before measuring a fresh grip; native momentum otherwise
  // moves its hit target between the geometry read and the next touch start.
  await page.evaluate(() => window.mount());
  a = await tab(page, 'announcements').locator('[data-tab-drag-handle]').boundingBox();
  const b = await tab(page, 'alerts').boundingBox();
  await touch('touchStart', a.x + a.width / 2, a.y + a.height / 2);
  for (let i = 1; i <= 8; i++) await touch('touchMove', a.x + a.width / 2 + (b.x + 25 - a.x - a.width / 2) * i / 8, b.y + b.height / 2);
  await touch('touchEnd');
  assert.deepEqual((await order(page)).slice(0, 2), ['announcements', 'alerts'], 'touch grip reorders');
  await tab(page, 'alerts').focus(); await page.keyboard.press('Alt+Home');
  await page.evaluate(() => document.querySelector('[data-tab-list]').scrollLeft = 0);
  a = await tab(page, 'alerts').boundingBox();
  const bounds = await page.locator('[data-tab-list]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 8, a.y + a.height / 2, { steps: 8 });
  await page.waitForFunction(() => document.querySelector('[data-tab-list]').scrollLeft > 180);
  await page.mouse.up();
  assert((await order(page)).indexOf('alerts') > 1, 'edge dragging reaches offscreen destinations');
  await context.close();

  // A saved layout is normalized safely as the catalog grows, with no hidden/missing tab.
  const clean = await browser.newContext({ serviceWorkers: 'block' }), fresh = await clean.newPage();
  await fresh.goto(`${origin}/fixture.html`);
  await fresh.evaluate(() => { localStorage.setItem('dashboard:tab-order:v1:research', JSON.stringify(['news-section', 'obsolete', 'news-section', 'alerts'])); });
  await fresh.reload(); await fresh.waitForFunction(() => window.ready);
  assert.deepEqual(await order(fresh), ['news-section', 'alerts', ...ids.filter(id => !['news-section', 'alerts'].includes(id))]);
  await fresh.evaluate(() => localStorage.setItem('dashboard:tab-order:v1:research', '{broken'));
  await fresh.reload(); await fresh.waitForFunction(() => window.ready); assert.deepEqual(await order(fresh), ids);
  // Exercise the actual shell through grouped routes and scope changes, with source reads denied.
  await fresh.evaluate(order => localStorage.setItem('sattva:shared-workspace:v1', JSON.stringify({version:1,revision:1,updatedAt:null,tabs:[],order})), ['news-section', ...ids.filter(id => id !== 'news-section')]);
  await clean.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  await fresh.goto(`${origin}/#/research/ask-research?scope=universe`);
  await fresh.locator('[data-active-tab="ask-research"]').waitFor();
  assert.equal(await fresh.locator('#tabbar-mount [data-tab-id]').first().getAttribute('data-tab-id'), 'news-section');
  await fresh.locator('#tabbar-mount [data-tab-id="earnings"]').click();
  await fresh.locator('[data-active-tab="earnings-hub"]').waitFor();
  await fresh.evaluate(() => location.hash = '#/research/concall?scope=watchlist');
  await fresh.locator('#subview-mount [data-tab-id="concall"][aria-selected="true"]').waitFor();
  assert.equal(await fresh.locator('#tabbar-mount [data-tab-id]').first().getAttribute('data-tab-id'), 'news-section');
  assert.equal(await fresh.locator('#subview-mount [data-tab-drag-handle]').count(), 0, 'subtabs keep their catalog order');
  await clean.close();

  previousRelease = true; upgradeFixture = true;
  const warm = await browser.newContext({ viewport: { width: 1440, height: 800 } }), returning = await warm.newPage(), errors = [];
  returning.on('pageerror', err => errors.push(err.message));
  await warm.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await returning.goto(`${origin}/fixture.html?worker`);
  await returning.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await returning.reload(); await returning.waitForFunction(() => window.ready);
  assert.equal(await returning.locator('[data-tab-drag-handle]').count(), 0, 'old controlled reader has no grips');
  assert((await returning.evaluate(() => caches.keys())).some(key => key.includes('previous-tab-release')));
  previousRelease = false;
  await returning.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await returning.locator('[data-tab-drag-handle]').first().waitFor();
  await drag(returning, 'news-section', 'alerts');
  await returning.reload(); await returning.waitForFunction(() => window.ready);
  assert.equal((await order(returning))[0], 'news-section', 'upgraded reader retains its layout');
  assert(!(await returning.evaluate(() => caches.keys())).some(key => key.includes('previous-tab-release')));
  assert.deepEqual(errors, []); await warm.close();
  console.log('PASS tab dragging, click isolation, keyboard order/reset, light/dark, touch scrolling/grips, edge scrolling, storage recovery, shell routes and warm-session upgrade');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
