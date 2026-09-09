// Real app with six local fixture companies; all external requests are intercepted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const original = JSON.parse(readFileSync(resolve(root, 'data/technicals.json')));
const book = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json')));
const identities = book.holdings.filter(h => h.ticker).slice(0, 6);
const seed = original.companies.find(c => c.consolidation_breakout && c.above_200dma);
const values = [[1.5, .95, true, 2], [1, .9, false, 1], [3, .8, true, .2], [.7, .99, true, -1], [null, null, null, 1], [1.4999, .9499, true, 1]];
const companies = values.map(([volume, proximity, above, fii], i) => ({ ...structuredClone(seed),
  ticker: identities[i].ticker, name: `Filter fixture ${'ABCDEF'[i]}`, isin: identities[i].isin,
  consolidation_breakout: volume == null ? null : { ...seed.consolidation_breakout, today_volume_ratio: volume },
  volume_ratio_today: 9, high_proximity_pct: proximity, above_200dma: above, chg_fii_hold: fii, chg_dii_hold: .2,
}));
const payload = { ...original, source: 'Local filter fixture', companies, company_count: 6, scored_count: 6, failures: 0 };
const portfolio = { ...book, holdings: identities.slice(0, 3) };
let quoteTickers = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/api/live-prices') {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      quoteTickers = JSON.parse(body).tickers;
      json({ prices: Object.fromEntries(quoteTickers.map(ticker => [ticker, { current: 100, prevClose: 99 }])), generated_at: new Date().toISOString() });
    }); return;
  }
  if (path.startsWith('/api/')) return json({ ok: false, error: 'Local filter fixture' });
  if (path === '/data/technicals.json') return json(payload);
  if (path === '/data/portfolio-companies.json') return json(portfolio);
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'text/plain');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    const type = route.request().resourceType();
    return route.fulfill({ contentType: type === 'script' ? 'text/javascript' : type === 'stylesheet' ? 'text/css' : 'application/json', body: ['script', 'stylesheet'].includes(type) ? '' : '{}' });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const tickers = letters => [...letters].map(letter => identities['ABCDEF'.indexOf(letter)].ticker).sort();
  const rowsAre = async letters => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#content-host tr[data-row-key]')].map(el => el.dataset.rowKey).sort()) === JSON.stringify(expected), tickers(letters));
  const chip = (group, id) => page.locator(`[data-chip-group="${group}"][data-chip-id="${id}"]`);
  const choose = async (group, id, param) => {
    await chip(group, id).click();
    await page.waitForFunction(({ param, id }) => new URLSearchParams(location.hash.split('?')[1]).get(param) === id, { param, id });
  };
  for (const view of ['technical-scanner', 'fii-accumulation']) {
    await page.goto(`${origin}/#/research/breakouts/${view}?scope=universe`);
    await rowsAre(view === 'technical-scanner' ? 'ABCDEF' : 'ABCEF');
    for (const group of ['volume', 'proximity', 'trend']) assert(await chip(group, 'all').isVisible());
    await choose('volume', '1.5', 'vol'); await rowsAre('AC');
    await choose('proximity', '5', 'near'); await rowsAre('A');
    await choose('trend', 'above', 'dma'); await rowsAre('A');
    assert.equal((await chip('proximity', '20').locator('span').last().innerText()).trim(), '2');
    await choose('proximity', '20', 'near'); await rowsAre('AC');
    await page.reload(); await rowsAre('AC');
    assert(await chip('volume', '1.5').evaluate(el => el.classList.contains('bg-indigo-50')));
    await page.evaluate(() => {
      window.exportedRows = null;
      window.ExcelJS = { Workbook: class {
        constructor() { this.xlsx = { writeBuffer: async () => new Uint8Array() }; }
        addWorksheet() { const records = []; window.exportedRows = records; return { addRow: row => records.push(row), getRow: () => ({}) }; }
      } };
    });
    await page.locator('[data-export]').click();
    await page.waitForFunction(() => Array.isArray(window.exportedRows));
    assert.deepEqual(await page.evaluate(() => exportedRows.map(row => row.ticker).sort()), tickers('AC'));
    if (view === 'technical-scanner') {
      assert.equal(await page.locator('[data-top-idx]').count(), 2, 'top cards obey market filters');
      await page.locator('[data-refresh-btn]').click();
      await page.waitForFunction(() => document.querySelector('[data-refresh-label]').textContent === 'Refresh prices');
      assert.deepEqual([...quoteTickers].sort(), tickers('AC'), 'live quotes target the narrowed market set');
      await page.locator('[data-table-filter]').selectOption('below200'); await rowsAre('');
      await choose('volume', 'all', 'vol');
      assert.equal(await page.locator('[data-table-filter]').inputValue(), 'below200', 'score selection survives chip changes');
      await page.locator('[data-table-filter]').selectOption('all');
      await page.locator('[data-table-search]').fill(identities[0].ticker); await rowsAre('A');
      await choose('volume', '1.5', 'vol'); await rowsAre('A');
      assert.equal((await page.locator('[data-table-search]').inputValue()).toUpperCase(), identities[0].ticker);
      await page.locator('[data-table-search]').fill(''); await rowsAre('AC');
    } else {
      await choose('magnitude', '1', 'mag'); await rowsAre('A');
      await choose('magnitude', '0', 'mag'); await rowsAre('AC');
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { if (document.documentElement.dataset.theme !== theme) window.sattvaTheme.toggle(); }, theme);
        assert(await page.locator('[data-chip-bar]').evaluate(el => el.getBoundingClientRect().right <= document.documentElement.clientWidth));
        if (process.env.TECHNICAL_FILTER_SCREENSHOTS) {
          mkdirSync(process.env.TECHNICAL_FILTER_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.TECHNICAL_FILTER_SCREENSHOTS}/${view}-${width}-${theme}.png`, animations: 'disabled' });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { location.hash = location.hash.replace('scope=universe', 'scope=portfolio'); }); await rowsAre('AC');
    await page.evaluate(async ticker => { (await import('/js/core/watchlist.js')).add(ticker); location.hash = location.hash.replace('scope=portfolio', 'scope=watchlist'); }, identities[0].ticker);
    await rowsAre('A');
  }
  await page.goto(`${origin}/#/research/breakouts/technical-scanner?scope=universe&vol=1.5&near=20&dma=above`);
  await rowsAre('AC');
  companies[0].consolidation_breakout.today_volume_ratio = 1.1;
  await page.evaluate(async () => (await import('/js/data/technicals.js')).refresh());
  await rowsAre('C');
  assert(await chip('volume', '1.5').evaluate(el => el.classList.contains('bg-indigo-50')), 'refresh preserves the selected filter');
  assert.deepEqual(errors, []);
  console.log('PASS shared filter UI: intersections, contextual counts, saved URLs, all scopes, score/search and FII controls, cards/export/quotes, refreshed data and responsive themes');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
