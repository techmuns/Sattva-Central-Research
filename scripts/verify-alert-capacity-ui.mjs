#!/usr/bin/env node
// Real IndexedDB transactions and reloads, with local synthetic evidence only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const server = createServer((req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Local cache test</title>'); return; }
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'application/json');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
const boot = async () => {
  await page.goto(origin);
  await page.evaluate(async () => {
    window.store = await import('/js/core/store.js');
    window.cacheModule = await import('/js/data/alert-window-cache.js');
    window.cache = window.cacheModule.alertWindowCache;
    window.key = window.cacheModule.ALERT_WINDOW_CACHE_KEY;
    window.value = count => ({ version: 1, day: '2026-09-07', feeds: [], events: Array.from({ length: count }, (_, i) => ({
      id: `event:${i}`, ticker: `CO${i % 600}`, headline: `Material Ω event ${i}`, day: '2026-09-07', feed: 'announcements',
    })) });
    window.diskKeys = async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('sattva-cache'); r.onsuccess = () => resolve(r.result); });
      const keys = await new Promise(resolve => { const r = db.transaction('payloads').objectStore('payloads').getAllKeys(); r.onsuccess = () => resolve(r.result); });
      db.close(); return keys;
    };
  });
};
try {
  await boot();
  const saved = await page.evaluate(async () => {
    await window.store.writeEntry('unrelated:feed', { value: { retained: true } });
    await window.store.writeEntry(`${window.key}0`, { value: { retained: true } });
    await window.store.writeEntry(window.key, { value: window.value(1) }); // Previous format.
    const legacy = (await window.cache.read()).value.events.length;
    const result = await window.cache.write(window.value(100_005));
    return { legacy, ...result, ...window.cache.status(), keys: await window.diskKeys() };
  });
  assert.equal(saved.legacy, 1);
  assert.equal(saved.persistent, true);
  assert.equal(saved.events, 100_005);
  assert(saved.parts > 1);
  await boot();
  const restored = await page.evaluate(async () => {
    const value = (await window.cache.read()).value;
    return { count: value.events.length, last: value.events.at(-1), distinct: new Set(value.events.map(e => e.id)).size };
  });
  assert.equal(restored.count, 100_005);
  assert.equal(restored.distinct, 100_005);
  assert.equal(restored.last.id, 'event:100004');
  assert.equal(restored.last.headline, 'Material Ω event 100004');

  const interrupted = await page.evaluate(async () => {
    const put = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function(...args) {
      if (++calls === 2) throw new DOMException('Injected local quota failure', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let result;
    try { result = await window.cache.write(window.value(2)); }
    finally { IDBObjectStore.prototype.put = put; }
    return { ...result, ...window.cache.status(), memoryCount: (await window.cache.read()).value.events.length };
  });
  assert.equal(interrupted.persistent, false);
  assert.equal(interrupted.status, 'session-only');
  assert.equal(interrupted.memoryCount, 2, 'the complete incoming revision stays usable after the transaction aborts');
  assert.match(interrupted.message, /reopening requires a source check/);
  await boot();
  assert.equal(await page.evaluate(async () => (await window.cache.read()).value.events.length), 100_005,
    'reload sees the previous complete revision, never a half-replaced manifest');

  const compacted = await page.evaluate(async () => {
    await window.cache.write(window.value(3));
    return { keys: await window.diskKeys(), ...window.cache.status() };
  });
  assert.equal(compacted.persistent, true);
  assert.equal(compacted.message, null);
  assert.equal(compacted.keys.filter(key => key.startsWith('ai-alerts:public-window:v1:part:')).length, 1);
  assert(compacted.keys.includes('unrelated:feed'), 'other feed caches cannot be pruned');
  assert(compacted.keys.includes('ai-alerts:public-window:v10'), 'a neighbouring cache namespace cannot be pruned');
  await boot();
  assert.equal(await page.evaluate(async () => (await window.cache.read()).value.events.length), 3);
  assert.deepEqual(errors, []);
  console.log(`PASS: real IndexedDB ${saved.events}-event/${saved.parts}-part reload; mid-transaction quota abort, intact previous disk revision, complete session fallback, legacy migration and fragment cleanup.`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
