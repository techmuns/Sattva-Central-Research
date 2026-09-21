// Exercise the shipped worker's immutable module cache from an already-open tab.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let upgraded = false;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><output id="reading"></output><script type="module">
import { readableOwnership } from '/js/data/mutual-funds-ownership.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
const row=readableOwnership({companyPct:10,denominator:{shares:1000,checkedAt:'2000-01-01'}});
document.querySelector('output').textContent=row.companyPct===null?'—':row.companyPct+'%';
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');
await navigator.serviceWorker.ready;
window.ready=true;
</script></body></html>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (pathname === '/' || pathname === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (pathname === '/sdk-fixture.js') { res.end('/* isolated SDK fixture */'); return; }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) throw new Error('path');
    let body = readFileSync(file);
    if (pathname === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-ownership-release`;');
    }
    // Model the previous normalizer's behavior inside a genuinely controlled,
    // warm session. Every other module and the update lifecycle are real.
    if (pathname === '/js/data/mutual-funds-ownership.js' && !upgraded)
      body = body.toString().replace('if(!row?.denominator || freshShareCount(row.denominator,now))return row;', 'return row;');
    const type = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)];
    res.setHeader('content-type', type || 'application/octet-stream'); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('output').innerText(), '10%');
  const before = await page.evaluate(() => caches.keys());
  assert(before.some(key => key.includes('previous-ownership-release')));
  upgraded = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => document.querySelector('output')?.textContent === '—', { timeout: 30000 });
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
  const after = await page.evaluate(() => caches.keys());
  assert(after.some(key => key.startsWith('sattva-dashboard-') && !before.includes(key)));
  assert(!after.some(key => key.includes('previous-ownership-release')), 'old immutable module cache is removed');
  assert.deepEqual(errors, []);
  console.log('PASS already-open controlled dashboard upgrades and withholds expired ownership and evicts its old module cache without a manual reload');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
