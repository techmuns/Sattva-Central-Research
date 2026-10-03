// A returning dashboard must replace its warm immutable coverage module through the real SW.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false;
const html = `<!doctype html><main id="coverage"></main><script type="module">
import { companyCaptureStatusFromIndex } from '/js/data/company-captures.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
const now = Date.now(), at = new Date(now).toISOString();
const index = { companies: [{ ticker: 'FSC' }], nonExchange: [{ isin: 'INE0LTR01029', exchangeFilings: 'unavailable' }],
  sources: { announcements: { FSC: { error: { reason: 'limited-coverage' }, recovery: { checkedAt: at, rowCount: 0 }, ranges: [] } } } };
const status = companyCaptureStatusFromIndex(index, 'announcements', null, now);
coverage.textContent = JSON.stringify({ failed: status.failed, partial: status.partial || 0, private: status.nonExchange?.length || 0 });
watchWorkerChanges(navigator.serviceWorker, () => location.reload());
await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; window.ready = true;
</script>`;
const previousModule = 'export function companyCaptureStatusFromIndex() { return { failed: 1, partial: 0, nonExchange: [] }; }';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('outside fixture');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-company-feed-release`;');
    }
    if (path === '/js/data/company-captures.js' && !upgraded) body = previousModule;
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForFunction(() => window.ready);
  assert.deepEqual(JSON.parse(await page.locator('#coverage').innerText()), { failed: 1, partial: 0, private: 0 });
  assert((await page.evaluate(() => caches.keys())).some(key => key.includes('previous-company-feed-release')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => JSON.parse(document.querySelector('#coverage').textContent).partial === 1);
  assert.deepEqual(JSON.parse(await page.locator('#coverage').innerText()), { failed: 0, partial: 1, private: 1 });
  assert(!(await page.evaluate(() => caches.keys())).some(key => key.includes('previous-company-feed-release')));
  assert.deepEqual(errors, []);
  console.log('PASS returning dashboard upgrades warm immutable modules and shows partial recent coverage and unavailable private filings without clearing storage.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
