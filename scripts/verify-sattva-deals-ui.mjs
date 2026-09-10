// Real Sattva app and saved portfolio. All requests remain on the local fixture server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const seed = JSON.parse(readFileSync(resolve(root, 'data/exchange-deals.json')));
seed.checkedAt = seed.updatedAt = '2026-09-10T04:00:00Z';
const book = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json')));
const ticker = book.holdings.find(h => h.ticker).ticker;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}'); return; }
  if (path === '/data/exchange-deals.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seed)); return; }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] || 'text/html');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date('2026-09-10T04:00:00Z') });
  let payload = structuredClone(seed), calls = 0;
  await page.route('**/api/bulk-block-deals', route => { calls++; return route.fulfill({ json: payload }); });
  await page.route('**/api/bulk-block-deals/refresh*', route => route.fulfill({ json: { ok: true, dispatched: false } }));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
  await page.goto(`${base}/#/research/insider-trades?scope=portfolio`);
  await page.waitForFunction(() => document.querySelector('[data-exchange-status]')?.textContent.includes('Muns insider'));
  const period = () => page.getByRole('combobox', { name: 'Trade period', exact: true });
  assert.equal(await period().inputValue(), '30');
  for (const name of ['Trade category', 'Exchange', 'Category', 'Transaction type', 'Mode']) assert(await page.getByRole('combobox', { name, exact: true }).isVisible());
  assert.equal(await page.getByRole('columnheader', { name: 'Exchange', exact: true }).count(), 1);
  assert(await page.locator('[data-insider-source-link]').count());
  const expected = async scope => page.evaluate(async scope => {
    const { insider } = await import('/js/data/filings.js');
    const { filterByScope } = await import('/js/data/scope.js');
    const { matchesNewsPeriod } = await import('/js/data/news-window.js');
    return filterByScope(insider.rows(), scope).filter(r => matchesNewsPeriod(r, '30')).length;
  }, scope);
  const count = async () => Number((await page.locator('[data-row-count]').first().innerText()).replace(/,/g, '').match(/\d+/)[0]);
  assert.equal(await count(), await expected('portfolio'), 'Sattva portfolio alone selects the captured trades');
  const portfolioCount = await count();
  for (const [value, range] of [['today', 'today'], ['7', '7d'], ['3m', '3m'], ['1y', '1y'], ['all', 'all']]) {
    await period().selectOption(value);
    assert(page.url().includes(`range=${range}`));
    assert.equal(await period().inputValue(), value);
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Trade period"]')?.value === 'all');
  assert(await count() > portfolioCount, 'all captured exposes older disclosures');
  await period().selectOption('30');
  await page.evaluate(() => { location.hash = location.hash.replace('scope=portfolio', 'scope=universe'); });
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.replace(/,/g, '').match(/\d+/)?.[0]) === n, await expected('universe'));
  assert.equal(await count(), await expected('universe'));
  assert(await count() > portfolioCount, 'Universe is not filtered by Glow holdings or Sattva portfolio');
  await page.evaluate(async ticker => {
    const watchlist = await import('/js/core/watchlist.js'); watchlist.add(ticker, ticker);
    location.hash = location.hash.replace('scope=universe', 'scope=watchlist');
  }, ticker);
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.replace(/,/g, '').match(/\d+/)?.[0]) === n, await expected('watchlist'));
  assert.equal(await count(), await expected('watchlist'));
  await page.evaluate(() => { location.hash = location.hash.replace('scope=watchlist', 'scope=portfolio'); });
  await page.waitForFunction(n => Number(document.querySelector('[data-row-count]')?.textContent.replace(/,/g, '').match(/\d+/)?.[0]) === n, await expected('portfolio'));
  const search = () => page.locator('[data-table-search]');
  await search().fill(ticker);
  await period().selectOption('today');
  payload = { ...payload, updatedAt: '2026-09-10T04:01:00Z', records: [...payload.records,
    ['nse-bulk', '2026-09-10', ticker, 'Sattva fixture company', 'NEW SATTVA DEAL', 'Buy', 100, 50, '']] };
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.body.textContent.includes('NEW SATTVA DEAL'));
  assert.equal((await search().inputValue()).toUpperCase(), ticker, 'new arrivals preserve search');
  assert.equal(await period().inputValue(), 'today', 'new arrivals preserve filters');
  assert(calls >= 2, 'the visible tab polls automatically');
  // Excel must preserve venue and exactly the filtered rows.
  await page.evaluate(() => { window.ExcelJS = { Workbook: class {
    constructor() { this.xlsx = { writeBuffer: async () => new Uint8Array() }; }
    addWorksheet() { window.exportedRows = []; return { addRow: row => window.exportedRows.push(row), getRow: () => ({}) }; }
  } }; });
  await page.locator('[data-export]').click();
  await page.waitForFunction(() => window.exportedRows?.length > 1);
  const exported = await page.evaluate(() => window.exportedRows);
  assert.equal(exported.length, await count() + 1);
  assert(Object.values(exported.at(-1)).includes('NSE'), 'Excel includes exchange');
  payload = { ...payload, updatedAt: '2026-09-10T04:02:00Z', sources: payload.sources.map(s => s.id === 'bse-bulk' ? { ...s, ok: false, error: 'Test outage' } : s) };
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.querySelector('[data-exchange-status]')?.textContent.includes('Test outage'));
  assert(await page.getByText('NEW SATTVA DEAL', { exact: true }).count(), 'failed source retains visible evidence');
  await search().fill(''); await period().selectOption('30');
  await page.screenshot({ path: '/tmp/sattva-deals-desktop.png', fullPage: true });
  await page.evaluate(() => window.sattvaTheme.toggle());
  await page.screenshot({ path: '/tmp/sattva-deals-dark.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: '/tmp/sattva-deals-mobile.png', fullPage: true });
  await period().selectOption('today');
  await page.clock.setSystemTime(new Date('2026-09-11T00:01:00+05:30'));
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => !document.body.textContent.includes('NEW SATTVA DEAL'));
  assert.equal(await period().inputValue(), 'today', 'Today advances at midnight without a new capture revision');
  assert.deepEqual(errors, []);
  console.log('PASS Sattva deals: portfolio/universe/watchlist, six filters, retained history, URL reload, automatic arrivals, Excel, failures, midnight, themes and mobile');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
