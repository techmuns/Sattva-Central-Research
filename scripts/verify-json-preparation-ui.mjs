// One local browser, no live APIs: input latency during large reads/writes, exact durable replay,
// overlapping corrections and old cache compatibility. The test leaves no browser/server behind.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const value = { capturedAt: '2026-10-12T12:00:00Z', records: Array.from({ length: 12000 }, (_, i) => ({
  id: `source-${i}`, ticker: `COMPANY${i % 500}`, headline: `Retained historical record ${i}`,
  day: i < 100 ? '2026-10-12' : '2024-01-01', body: 'Full source evidence stays available. '.repeat(24),
  amount: i / 100, correction: false, nested: { source: 'Original source', note: 'Source check and publication stay separate.' },
})), special: JSON.parse('{"__proto__":{"source":"own field"},"text":"\\ud800"}') };
const body = JSON.stringify(value);
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  if (req.method !== 'GET' || path.startsWith('/api/')) { res.writeHead(503).end('{}'); return; }
  if (path === '/large.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(body); return; }
  if (path === '/fixture') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><input id="search" aria-label="Search"><output id="echo"></output>
      <script type="module">
        import { readJsonResponse, jsonPreparationState } from '/js/core/json-reader.js';
        import { writeEntry, readEntry, readEntries } from '/js/core/store.js';
        window.cache = { writeEntry, readEntry, readEntries }; window.preparationState = jsonPreparationState;
        document.querySelector('input').addEventListener('input', event => {
          document.querySelector('output').textContent = event.target.value;
          requestAnimationFrame(() => window.inputLatencies.push(performance.now() - event.timeStamp));
        });
        window.runRead = () => {
          window.finished = false;
          window.readJob = fetch('/large.json').then(response => readJsonResponse(response))
            .then(async value => { value.records[0].validated = true; window.value = value; const result = await writeEntry('news-history:json-worker-fixture',
              { tag: 'verified-v1', savedAt: 1791806400000, value }); if (!result) throw Error('Cache write did not commit'); })
            .then(() => window.finished = true).catch(error => window.readError = error.message);
        };
        window.ready = true;
      </script>`); return;
  }
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'application/octet-stream' }).end(readFileSync(file)); }
  catch { res.writeHead(404).end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript(() => {
    window.inputLatencies = []; window.largeParses = 0; window.largeWrites = 0;
    const parse = JSON.parse;
    JSON.parse = function(text, ...args) { if (typeof text === 'string' && text.length > 128 * 1024) window.largeParses++; return parse.call(this, text, ...args); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(row, ...args) { if (row?.value?.records?.length > 1000) window.largeWrites++; return put.call(this, row, ...args); };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.ready);
  await page.evaluate(() => window.runRead());
  await page.getByRole('textbox', { name: 'Search' }).pressSequentially('history remains searchable');
  assert.equal(await page.locator('#echo').innerText(), 'history remains searchable');
  await page.waitForFunction(() => window.finished || window.readError, null, { timeout: 60000 });
  const reading = await page.evaluate(() => ({ error: window.readError, count: window.value?.records.length,
    last: window.value?.records.at(-1), largeParses: window.largeParses, largeWrites: window.largeWrites,
    maxInputMs: Math.max(...window.inputLatencies) }));
  assert.equal(reading.error, undefined); assert.equal(reading.count, value.records.length);
  assert.deepEqual(reading.last, value.records.at(-1));
  assert.equal(reading.largeParses, 0, 'large JSON is never parsed on the page thread');
  assert.equal(reading.largeWrites, 0, 'large record graphs are never cloned into IndexedDB on the page thread');
  assert(reading.maxInputMs < 250, `input paints during preparation (${Math.round(reading.maxInputMs)}ms)`);
  await page.reload(); await page.waitForFunction(() => window.ready);
  const restored = await page.evaluate(async () => {
    const entry = await window.cache.readEntry('news-history:json-worker-fixture');
    return { tag: entry.tag, savedAt: entry.savedAt, count: entry.value.records.length,
      first: entry.value.records[0], last: entry.value.records.at(-1), specialJson: JSON.stringify(entry.value.special),
      ownPrototypeField: Object.hasOwn(entry.value.special, '__proto__') };
  });
  assert.deepEqual(restored, { tag: 'verified-v1', savedAt: 1791806400000, count: value.records.length,
    first: { ...value.records[0], validated: true }, last: value.records.at(-1), specialJson: JSON.stringify(value.special), ownPrototypeField: true }, 'durable replay preserves original and offscreen history, validated corrections, fields and source times');
  await page.evaluate(async () => {
    const first = await window.cache.readEntry('news-history:json-worker-fixture');
    const old = window.cache.writeEntry('news-history:json-worker-fixture', { tag: 'old', value: first.value });
    const corrected = window.cache.writeEntry('news-history:json-worker-fixture', { tag: 'new', savedAt: 42,
      value: { records: [{ id: 'corrected-record', correction: true }] } });
    await Promise.all([old, corrected]);
    await window.cache.writeEntry('fixture-legacy', { tag: 'legacy', savedAt: 7, value: { intact: true } });
  });
  await page.reload(); await page.waitForFunction(() => window.ready);
  const replay = await page.evaluate(async () => [...await window.cache.readEntries(['news-history:json-worker-fixture', 'fixture-legacy'])]);
  assert.deepEqual(replay, [['news-history:json-worker-fixture', { tag: 'new', savedAt: 42, value: { records: [{ id: 'corrected-record', correction: true }] } }],
    ['fixture-legacy', { tag: 'legacy', savedAt: 7, value: { intact: true } }]], 'overlapping revisions commit in order and legacy entries remain readable');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ bytes: Buffer.byteLength(body), ...reading }));
  console.log('PASS: responsive input, worker parsing/persistence, exact complete durable history, corrections, source timestamps and legacy cache replay.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
