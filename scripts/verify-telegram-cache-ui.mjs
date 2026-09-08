// Real browser cache upgrade: a separate Telegram revision and a later shared marker
// both warm a fresh module graph before replacing the previous app cache. Local only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let nextRelease = false, moduleRequested = false, releaseModule, markModuleRequested;
const heldModule = new Promise(done => { releaseModule = done; });
const requestedModule = new Promise(done => { markModuleRequested = done; });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (pathname === '/cache-fixture') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local cache verification</title>'); return; }
  if (pathname === '/sdk-fixture') { res.setHeader('content-type', 'text/javascript'); res.end('// Public SDK cache fixture'); return; }
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    let body = readFileSync(path);
    if (pathname === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = '[^']+';/, `const MUNSHOT_SDK = '${origin}/sdk-fixture';`);
      if (nextRelease) body = body.replace(/(const CACHE_NAME = `\$\{CACHE_PREFIX\})[^`]+(`;)/, '$1fixture-next-release$2');
    }
    if (nextRelease && pathname === '/js/tabs/public-chatter.js') { moduleRequested = true; markModuleRequested(); await heldModule; }
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${origin}/cache-fixture`);
  await page.evaluate(async () => {
    await caches.open('sattva-dashboard-legacy-fixture');
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const before = await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('sattva-dashboard-')));
  assert.equal(before.length, 1, 'legacy app caches are removed after activation');
  assert(before[0].endsWith('-telegram-content-v1'), 'the Telegram revision creates its own cache');
  assert((await page.evaluate(async name => (await (await caches.open(name)).match('/js/tabs/public-chatter.js')).text(), before[0])).includes('telegramMediaLabel'));

  nextRelease = true;
  await page.evaluate(() => {
    window.controllerChanges = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => { window.controllerChanges++; });
    navigator.serviceWorker.getRegistration().then(registration => registration.update());
  });
  await page.waitForFunction(async () => (await caches.keys()).some(name => name.includes('fixture-next-release')));
  await Promise.race([requestedModule, new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('The next worker did not request its Telegram module')), 10000);
    timeout.unref();
  })]);
  assert((await page.evaluate(() => caches.keys())).includes(before[0]), 'the previous cache survives while the next module graph warms');
  assert.equal(await page.evaluate(() => window.controllerChanges), 0, 'an incomplete module graph cannot activate');
  releaseModule();
  // controllerchange can fire as activation starts, before its waitUntil eviction finishes.
  await page.waitForFunction(() => window.controllerChanges === 1 && navigator.serviceWorker.controller.state === 'activated');
  assert(moduleRequested, 'the new release re-reads the Telegram module');
  const after = await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('sattva-dashboard-')));
  assert.deepEqual(after, ['sattva-dashboard-fixture-next-release-telegram-content-v1'], 'a later shared marker upgrades and evicts the previous combined cache');
  console.log('PASS Telegram cache revision, legacy eviction, atomic module warm-up and subsequent shared release upgrade.');
} finally {
  releaseModule();
  await browser.close();
  await new Promise(done => server.close(done));
}
