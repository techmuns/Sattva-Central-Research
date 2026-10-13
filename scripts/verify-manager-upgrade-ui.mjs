// Warm immutable module upgrade through the shipped SW, with synthetic private data only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false;
const revision = JSON.stringify(Array.from({ length: 60 }, (_, i) => [`workbook-${i}`, `revision-${i}`, '2026-10-01T00:00:00Z', null]));
const fixture = { version: 1, valuation: 'workbook', bookAsOf: '2026-08-31', listedValuationAt: null, listedValuationBasis: null, archiveVersion: 1, sourceRevision: revision,
  coverage: { note: 'Synthetic workbook coverage', transactionAsOf: '2026-08-31', sourceCount: 6, privateCount: 0 },
  managers: [{ id: 'custodian-example', name: 'Example Custodian', kind: 'custodian', asOf: '2026-08-31', positions: [], transactions: [],
    values: { marketValue: 100, costBasis: 80, unrealised: 20, cashValue: 0, positionCount: 0 } }] };
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><main id="fixture" class="p-4"></main><script type="module">
import { renderManagers } from '/js/investors/my-managers.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
const view = renderManagers({scope:'portfolio'}); fixture.innerHTML = view.html; view.wire(fixture, []);
watchWorkerChanges(navigator.serviceWorker, () => location.reload());
await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; window.ready = true;
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (path === '/sdk-fixture.js') { res.end('/* isolated SDK */'); return; }
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error();
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-manager-release`;');
    }
    if (path === '/js/data/managers-contract.js' && !upgraded) body = body.toString().replace('text(v.sourceRevision, MAX_MANAGER_CHARS)', 'text(v.sourceRevision, 1000)');
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
  await page.route('**/*', route => {
    if (route.request().url() === 'https://sattva-family.pages.dev/research-bridge') return route.fulfill({ contentType: 'text/html', body: `<script>
      const fixture = ${JSON.stringify(fixture)};
      const send = m => parent.postMessage({channel:'sattva-portfolio-v1', ...m}, ${JSON.stringify(origin)});
      addEventListener('message', e => {
        if(e.origin !== ${JSON.stringify(origin)} || e.source !== parent || e.data.channel !== 'sattva-portfolio-v1') return;
        const m = e.data;
        if(m.type === 'hello') send({id:m.id,type:'ready',capabilities:['manager-workbook']});
        if(m.type === 'managers') send({id:m.id,type:'result',managers:{...fixture,checkedAt:new Date().toISOString()}});
      });
    </script>` });
    return new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
  });
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForFunction(() => window.ready);
  await page.waitForFunction(() => document.querySelector('[data-manager-unavailable]')?.textContent.includes('revision'));
  assert.equal(await page.locator('[data-open-manager]').count(), 0, 'old cached catalogue bound reproduces the unavailable view');
  const before = await page.evaluate(() => caches.keys()); assert(before.some(k => k.includes('previous-manager-release')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('[data-open-manager="custodian-example"]');
  assert.equal(await page.locator('[data-manager-unavailable]').count(), 0, 'already-open page reloads the new contract and recovers automatically');
  const after = await page.evaluate(() => caches.keys()); assert(!after.some(k => k.includes('previous-manager-release')));
  await page.locator('[data-manager-search]').fill('Example');
  assert.equal(await page.locator('[data-open-manager]').count(), 1);
  const cachedPrivate = await page.evaluate(async () => {
    for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) if (req.url.includes('research-bridge') || req.url.includes('/api/')) return true;
    return false;
  });
  assert.equal(cachedPrivate, false, 'authenticated replies never enter the public static cache');
  assert.deepEqual(errors, []);
  console.log('PASS warm manager session: old catalogue failure, automatic immutable-module upgrade, manager recovery, old-cache eviction and private-cache exclusion');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
