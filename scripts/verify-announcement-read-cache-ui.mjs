// Returning reader upgrade from a pre-stream cached module graph to the current release. Local only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const current = readFileSync(resolve(root, 'sw.js'), 'utf8');
// Model the old dependency graph: no streaming-client module, and a previous service-worker revision.
// No Git history or network fetch is needed on a shallow CI checkout.
const previous = new Map([
  ['/sw.js', current.replace(/(const CACHE_NAME = `\$\{CACHE_PREFIX\})[^`]+(`;)/, '$1fixture-before-stream$2')],
  ['/js/ui/announcement-read.js', readFileSync(resolve(root, 'js/ui/announcement-read.js'), 'utf8')
    .replace("import { requestAnnouncementRead } from '../data/announcement-read-client.js';", "async function requestAnnouncementRead() { return (await fetch('api/announcement-read', {method:'POST'})).json(); }")],
]);
let next = false, releaseModule, requestedModule;
const held = new Promise(done => { releaseModule = done; });
const requested = new Promise(done => { requestedModule = done; });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (pathname === '/cache-fixture') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>AI Read cache verification</title>'); return; }
  if (pathname === '/sdk-fixture') { res.setHeader('content-type', 'text/javascript'); res.end('// SDK fixture'); return; }
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    let body = !next && previous.has(pathname) ? previous.get(pathname) : readFileSync(path);
    if (pathname === '/sw.js') body = String(body).replace(/const MUNSHOT_SDK = '[^']+';/, `const MUNSHOT_SDK = '${origin}/sdk-fixture';`);
    if (next && pathname === '/js/data/announcement-read-client.js') { requestedModule(); await held; }
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${origin}/cache-fixture`);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const oldCache = await page.evaluate(async () => (await caches.keys()).find(k => k.startsWith('sattva-dashboard-')));
  assert.equal(await page.evaluate(async name => (await (await caches.open(name)).match('/js/ui/announcement-read.js')).text(), oldCache), previous.get('/js/ui/announcement-read.js'));
  next = true;
  await page.evaluate(() => {
    window.upgrades = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.upgrades++);
    navigator.serviceWorker.getRegistration().then(r => r.update());
  });
  await requested;
  assert.equal(await page.evaluate(() => window.upgrades), 0, 'new transport must warm before activating');
  assert((await page.evaluate(() => caches.keys())).includes(oldCache), 'old session remains usable during warm-up');
  releaseModule();
  await page.waitForFunction(() => window.upgrades === 1 && navigator.serviceWorker.controller.state === 'activated');
  await page.waitForFunction(async old => !(await caches.keys()).includes(old), oldCache);
  const newCache = await page.evaluate(async () => (await caches.keys()).find(k => k.startsWith('sattva-dashboard-')));
  const marker = current.match(/const CACHE_NAME = `\$\{CACHE_PREFIX\}([^`]+)`;/)[1];
  assert(newCache.includes(marker));
  for (const path of ['/js/ui/announcement-read.js', '/js/data/announcement-read-client.js', '/js/data/announcement-read-shared.js']) {
    assert.equal(await page.evaluate(async path => (await fetch(path)).text(), path), readFileSync(resolve(root, `.${path}`), 'utf8'), `returning reader receives released bytes: ${path}`);
  }
  console.log('PASS pre-stream cached popup graph upgrades atomically to the released popup, client and contract.');
} finally { releaseModule(); await browser.close(); await new Promise(done => server.close(done)); }
