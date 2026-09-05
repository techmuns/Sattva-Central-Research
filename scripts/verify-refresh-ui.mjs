#!/usr/bin/env node
// Real browser + service worker. Every request stays on this local fixture server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
let revision = 1, unavailable = false, held = null, reads = 0;
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head><body>
<div id="status"></div><input id="search" aria-label="Company search" value="Jayaswal"><div id="rows"></div>
<script type="module">
import { statusControl } from '/js/ui/components.js';
import * as registry from '/js/core/refresh.js';
import { conditionalJson } from '/js/core/store.js';
let context='news', changed=null, unregister=null;
window.calls=0;
const control=statusControl({getTimestamp:()=>null,getRefreshKey:()=>context,subscribeContext:fn=>{changed=fn;return()=>{};},
 onRefresh:async()=>registry.summarize((await registry.refreshAll()).results)});
document.querySelector('#status').innerHTML=control.html;control.wire(document);
window.attach=(name)=>{
 unregister?.();context=name;
 unregister=registry.register(name,{label:name,refresh:async()=>{
  window.calls++;
  const out=await conditionalJson('/data/refresh-fixture.json',{key:'refresh-test'});
  if(context===name) document.querySelector('#rows').textContent=out.value.headline;
  return {checked:1};
 }});
 changed?.();
};
window.attach('news');
window.read=()=>registry.refreshOne(context);
window.ready=true;
</script></body></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/refresh-test') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (url.pathname === '/data/refresh-fixture.json') {
    reads++;
    if (held) await held;
    if (unavailable) { res.writeHead(503); res.end('offline'); return; }
    res.writeHead(200, { 'content-type': 'application/json', etag: `"revision-${revision}"`, 'cache-control': 'public, max-age=0, must-revalidate' });
    res.end(JSON.stringify({ headline: `Jayaswal source revision ${revision}` })); return;
  }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(file);
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate'); res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext(); const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(`${origin}/refresh-test`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(done => navigator.serviceWorker.addEventListener('controllerchange', done, { once: true }));
    await window.read();
  });
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).count(), 1, 'Refresh keeps a stable accessible name while its status changes');
  assert.equal(await page.locator('#rows').textContent(), 'Jayaswal source revision 1');
  revision = 2;
  await page.locator('[data-header-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-header-refresh-label]').textContent === 'Latest available');
  assert.equal(await page.locator('#rows').textContent(), 'Jayaswal source revision 2', 'first click displays new server data, not the service-worker saved response');
  assert.equal(await page.locator('#search').inputValue(), 'Jayaswal', 'refresh preserves company search');
  unavailable = true;
  await page.locator('[data-header-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-header-refresh-label]').textContent === 'Couldn’t refresh');
  assert.equal(await page.locator('#rows').textContent(), 'Jayaswal source revision 2', 'outage retains the good rows without claiming success');
  unavailable = false;
  let release; held = new Promise(done => { release = done; }); revision = 3;
  const before = reads;
  await page.locator('[data-header-refresh]').click();
  await page.waitForFunction(() => window.calls === 4);
  await page.evaluate(() => document.querySelector('[data-header-refresh]').dispatchEvent(new Event('click')));
  await page.waitForFunction(() => document.querySelector('[data-header-refresh-label]').textContent === 'Still updating…', null, { timeout: 15000 });
  assert.equal(reads - before, 1, 'repeated clicks do not duplicate a pending read');
  await page.evaluate(() => window.attach('ipos'));
  assert.equal(await page.locator('[data-header-refresh]').isEnabled(), true, 'another view can refresh while the old one is pending');
  release(); held = null;
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-header-refresh-label]').textContent(), 'Refresh', 'old-view completion does not overwrite current status');
  await page.locator('[data-header-refresh]').click();
  await page.waitForFunction(() => document.querySelector('#rows').textContent === 'Jayaswal source revision 3');
  assert.deepEqual(errors, []);
  console.log('PASS actual service-worker freshness, outage retention, search preservation, duplicate clicks, pending feedback and navigation isolation');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
