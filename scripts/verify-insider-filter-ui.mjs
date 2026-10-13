#!/usr/bin/env node
// Local browser fixture: source actions, legacy malformed cells and exact filter intersections.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
// Pin the source and Today selector to 00:10 IST, before the UTC day changes.
const at = '2026-10-13T18:40:00.000Z';
// Source dates and the Today selector use the same IST day, including after IST midnight.
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric',
  month: '2-digit', day: '2-digit' }).format(new Date(at));
const types = ['Buy', 'Sell', 'Acquisition', 'Disposal', 'Pledge', 'Revoke', 'Invoke', 'Gift'];
const categories = ['Bulk deal', 'Block deal', 'SAST', 'Insider trade'];
const fullCompany = 'A Very Long Company Name With Investments Manufacturing And Telecommunications Limited';
const fullParty = 'Person 0 And The Complete Name Of An Institutional Investment Partnership And Its Joint Holders';
const rows = [...types, '1,00,000 Equity', '1,20,00,000 Any Other Instrument', '1290773'].map((Transaction, i) => ({
  ticker: 'TEST', date, cells: { Insider: i === 0 ? fullParty : `Person ${i}`, Company: i === 0 ? fullCompany : 'Test Company', Transaction, 'Trade Category': categories[i % 4],
    Exchange: i % 2 ? 'BSE' : 'NSE', Category: i % 2 ? 'Public' : 'Promoter', Mode: i % 2 ? 'Off Market' : 'On Market',
    'Trade Shares': String(100 + i), Source: 'Screener.in' },
}));
rows.push({ ticker: 'TEST', date, cells: { Insider: 'Alternate', Transaction: '27,000 Equity', 'Acq/Disp': 'Disposal', 'Trade Category': 'Insider trade' } });
delete rows[2].cells.Company; rows[2].cells['Company Name'] = 'Company Name Variant Limited';
delete rows[3].cells.Company;
delete rows[5].cells.Company; rows[5].company = 'Issuer Stored On The Row Limited';
delete rows[9].cells.Company; rows[9].cells['Company Name'] = 'Company With No Named Party'; rows[9].cells.Insider = '';
let capture = { kind: 'insider', capturedAt: at, coversUniverse: true, windowDays: 365,
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
  await page.clock.setFixedTime(new Date(at));
  await page.goto(origin);
  const count = page.locator('[data-row-count]');
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.match(/\d+/)?.[0]) === n, rows.length);
  assert.equal(await page.getByRole('columnheader', { name: 'Company', exact: true }).count(), 1, 'company leads without a duplicate source column');
  assert.equal(await page.getByRole('columnheader', { name: 'Insider', exact: true }).count(), 0);
  const assertFullNames = async () => {
    const row = page.locator('tr[data-row-key]').filter({ hasText: fullParty }).first();
    assert.equal(await row.locator('td').first().locator('.font-semibold').innerText(), fullCompany);
    assert.equal(await row.locator('td').first().locator('span[title]').innerText(), fullParty);
    const layout = await row.locator('td').first().evaluate(cell => {
      const company = cell.querySelector('.font-semibold'), party = cell.querySelector('span[title]');
      return { companyFirst: company.getBoundingClientRect().bottom <= party.getBoundingClientRect().top,
        bold: Number(getComputedStyle(company).fontWeight) >= 600,
        full: [company, party].every(el => getComputedStyle(el).whiteSpace === 'normal' &&
          getComputedStyle(el).textOverflow !== 'ellipsis' && el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) };
    });
    assert(layout.companyFirst && layout.bold && layout.full, 'company bold first and complete party below without clipping');
    assert.match(await row.locator('td').first().innerText(), /TEST/);
    assert(await row.locator('[data-watch="TEST"]').count());
    assert(await row.locator('[data-bookmark-key]').count());
    assert(await row.locator('[data-insider-source-link]').count());
  };
  await assertFullNames();
  assert(await page.getByTitle('Company Name Variant Limited', { exact: true }).count());
  assert(await page.getByTitle('Issuer Stored On The Row Limited', { exact: true }).count());
  await page.locator('[data-table-search]').fill('Issuer Stored On The Row');
  await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  await page.locator('[data-table-search]').fill('Person 3');
  await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  assert.equal(await page.locator('tr[data-row-key] td').first().locator('.font-semibold').innerText(), 'TEST', 'missing issuer name keeps its ticker');
  await page.locator('[data-table-search]').fill('Company With No Named Party');
  await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  assert.equal(await page.locator('tr[data-row-key] td').first().locator('span[title]').innerText(), '(not named)', 'issuer-only Name fields cannot become a party');
  await page.locator('[data-table-search]').fill('');
  const more = page.getByRole('button', { name: 'More filters (5)', exact: true });
  const panel = page.getByRole('dialog', { name: 'More filters (5)', exact: true });
  const names = ['Trade category', 'Exchange', 'Category', 'Transaction type', 'Mode'];
  const period = page.getByLabel('Trade period', { exact: true });
  const search = page.locator('[data-table-search]');
  assert(await search.isVisible()); assert(await period.isVisible());
  assert(await page.locator('[data-watch-toggle]').isVisible());
  for (const name of names) assert(!await page.getByLabel(name, { exact: true }).isVisible(), `${name} starts collapsed`);
  const order = await page.locator('[data-table-toolbar]').evaluate(el => {
    const search = el.querySelector('[data-table-search]'), period = el.querySelector('[aria-label="Trade period"]'), more = el.querySelector('[data-filter-group-toggle]');
    return !!(search.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !!(period.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert(order, 'Search and Period lead the compact toolbar');
  await more.click();
  assert.equal(await panel.locator('select').count(), 5);
  for (const name of names) assert(await page.getByLabel(name, { exact: true }).isVisible());
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
  for (const [name, excluded, included] of [['Exchange', 'BSE', 'NSE'], ['Category', 'Public', 'Promoter'], ['Mode', 'Off Market', 'On Market']]) {
    await page.getByLabel(name, { exact: true }).selectOption(excluded);
    await page.waitForFunction(() => /^0 trades/.test(document.querySelector('[data-row-count]')?.textContent));
    await page.getByLabel(name, { exact: true }).selectOption(included);
    await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  }
  await page.getByLabel('Trade category', { exact: true }).selectOption('Block deal');
  await page.waitForFunction(() => /^0 trades/.test(document.querySelector('[data-row-count]')?.textContent));
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  assert(!await select.isVisible());
  assert.equal(await select.inputValue(), 'Buy', 'closing keeps hidden predicates');
  assert.equal(await more.getAttribute('data-active'), 'true');
  await search.fill('Person 0'); await period.selectOption('today');
  await more.focus(); await page.keyboard.press('Enter');
  await panel.getByRole('button', { name: 'Clear more filters (5)', exact: true }).click();
  for (const name of names) assert.equal(await page.getByLabel(name, { exact: true }).inputValue(), 'all');
  assert.equal(await search.inputValue(), 'Person 0');
  assert.equal(await period.inputValue(), 'today', 'Clear affects only the five grouped selectors');
  await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  assert.equal(await more.getAttribute('data-active'), 'false');
  await page.keyboard.press('Escape');
  assert(!await select.isVisible());
  await search.fill(''); await period.selectOption('30');
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.match(/\d+/)?.[0]) === n, rows.length);
  assert.match(await count.innerText(), /12 trades/);
  for (const size of [{ width: 390, height: 844 }, { width: 740, height: 360 }]) {
    await page.setViewportSize(size); await assertFullNames(); await more.scrollIntoViewIfNeeded(); await more.click();
    const box = await panel.boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
      'all five selectors remain in a scrollable panel inside the viewport');
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    assert(!await select.isVisible());
  }
  // The natural-height window must keep wrapped rows bounded and every disclosure searchable.
  capture = { ...capture, capturedAt: new Date(Date.parse(at) + 1000).toISOString(), byTicker: { TEST: Array.from({ length: 250 }, (_, i) => ({
    ...rows[0], cells: { ...rows[0].cells, Insider: `Window party ${i} ${i % 3 ? fullParty : ''}` } })) } };
  await page.setViewportSize({ width: 1440, height: 900 }); await page.reload();
  await page.waitForFunction(() => Number(document.querySelector('[data-score-table]')?.dataset.virtualTotal) >= 250);
  assert(await page.locator('tr[data-row-key]').count() < 160, 'wrapped history keeps a bounded mounted window');
  await page.locator('[data-table-scroll]').evaluate(el => { el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event('scroll')); });
  await page.waitForFunction(() => Number(document.querySelector('[data-score-table]')?.dataset.virtualStart) > 0);
  assert(await page.locator('tr[data-row-key]').count() < 160);
  await page.locator('[data-table-search]').fill('Window party 249');
  await page.waitForFunction(() => /^1 trade /.test(document.querySelector('[data-row-count]')?.textContent));
  assert((await page.locator('tr[data-row-key] td').first().innerText()).includes('Window party 249'));
  assert.deepEqual(errors, []);
  console.log('PASS company-first complete names, issuer fallbacks, bounded wrapped history, compact filters, small viewports and retained disclosures');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
