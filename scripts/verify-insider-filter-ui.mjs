#!/usr/bin/env node
// Local browser fixture: source actions, legacy malformed cells and exact filter intersections.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = new Date().toISOString();
const date = at.slice(0, 10);
const types = ['Buy', 'Sell', 'Acquisition', 'Disposal', 'Pledge', 'Revoke', 'Invoke', 'Gift'];
const categories = ['Bulk deal', 'Block deal', 'SAST', 'Insider trade'];
const rows = [...types, '1,00,000 Equity', '1,20,00,000 Any Other Instrument', '1290773'].map((Transaction, i) => ({
  ticker: 'TEST', date, cells: { Insider: `Person ${i}`, Transaction, 'Trade Category': categories[i % 4],
    'Trade Shares': String(100 + i), Source: 'Screener.in' },
}));
rows.push({ ticker: 'TEST', date, cells: { Insider: 'Alternate', Transaction: '27,000 Equity', 'Acq/Disp': 'Disposal', 'Trade Category': 'Insider trade' } });
const capture = { kind: 'insider', capturedAt: at, coversUniverse: true, windowDays: 365,
  headers: [...new Set(rows.flatMap(row => Object.keys(row.cells)))], byTicker: { TEST: rows } };
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/insider-trades.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({holdings:[{ticker:'TEST',name:'Test Company'}]});
tab.render({root:document.querySelector('#root'),scope:'universe',data:{universe:[]},params:{},setParamsQuiet(){},
  live:{register(){},start(){},stop(){}}});
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/data/insider-trades.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(capture)); return; }
  if (path.startsWith('/api/') || path.startsWith('/data/')) { res.writeHead(404); res.end('{}'); return; }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('content-type', extname(file) === '.css' ? 'text/css' : 'text/javascript'); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.fulfill({ status: 404, body: '' }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const count = page.locator('[data-row-count]');
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.match(/\d+/)?.[0]) === n, rows.length);
  const select = page.getByLabel('Transaction type', { exact: true });
  const choices = await select.locator('option').evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(choices.slice(1).sort(), [...types].sort());
  for (const type of types) {
    await select.selectOption(type);
    const expected = type === 'Disposal' ? 2 : 1;
    await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.match(/\d+/)?.[0]) === n, expected);
    const names = await page.locator('tbody tr').allTextContents();
    assert(names.some(text => text.includes(`Person ${types.indexOf(type)}`)), `${type} reveals its matching disclosure`);
    if (type === 'Disposal') assert(names.some(text => text.includes('Alternate')));
  }
  await select.selectOption('Buy');
  await page.getByLabel('Trade category', { exact: true }).selectOption('Block deal');
  await page.waitForFunction(() => /^0 trades/.test(document.querySelector('[data-row-count]')?.textContent));
  await select.selectOption('all');
  await page.getByLabel('Trade category', { exact: true }).selectOption('all');
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.match(/\d+/)?.[0]) === n, rows.length);
  assert.match(await count.innerText(), /12 trades/);
  assert.deepEqual(errors, []);
  console.log('PASS exact transaction selections, category intersection and retained malformed disclosures');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
