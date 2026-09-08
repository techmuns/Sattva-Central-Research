// Real calendar renderer, persistent store and live poller; local source fixtures only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const DATE = '2026-09-08';
const NEXT = '2026-09-09';
const checkedAt = '2026-09-08T06:00:00Z';
const event = (ticker, name, date = DATE) => ({
  eventId: `result:${date}:${name}`, scId: name, eventType: 'Result', eventSource: 'Moneycontrol',
  ticker, name, resultDate: date, exchange: 'N', quarter: 'Q1 FY27',
});
let mode = 'failed', revision = 1, calendarReads = 0, earningsBlocked = false;
const rows = [event('STLTECH', 'Sterlite Technologies'), event('RELIANCE', 'Reliance Industries'), event(null, 'Unresolved issuer')];
const payload = (date) => ({
  ok: true, date, from: DATE, to: NEXT, listRequested: true, listSource: 'snapshot',
  listCapturedAt: checkedAt, countSource: 'live', screenerUpcomingSource: 'artifact',
  screenerUpcomingCheckedAt: checkedAt, resultComplete: true, concallComplete: true, complete: true,
  scheduledCount: mode === 'empty' ? 0 : rows.length, pagesFetched: 1,
  days: [DATE, NEXT].map(date => ({ date, count: mode === 'empty' ? 0 : rows.length })),
  rows: mode === 'empty' ? [] : rows.map(row => ({ ...row, resultDate: date })),
  meta: { fetchedAt: checkedAt },
});
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head><body>
<button id="portfolio">Portfolio</button><button id="universe">Universe</button><main id="calendar"></main>
<script type="module">
import * as tab from '/js/tabs/earnings-hub.js';
import * as calendar from '/js/data/earnings-calendar.js';
import * as coverage from '/js/data/coverage.js';
import * as live from '/js/core/live.js';
coverage.prime({ holdings: [{ ticker: 'STLTECH', name: 'Sterlite Technologies' }] });
window.calendar = calendar;
const ctx = { scope: new URL(location.href).searchParams.get('scope') || 'portfolio',
  root: document.querySelector('#calendar'), live, data: {}, params: { view: 'calendar', date: '${DATE}' },
  setParamsQuiet(params) { this.params = params; },
  setParams(params) { this.params = params; tab.render(this); } };
window.ctx = ctx;
window.tab = tab;
window.refresh = () => live.refreshAll({ ids: ['earnings-calendar'] });
for (const scope of ['portfolio', 'universe']) document.getElementById(scope).onclick = () => {
  ctx.scope = scope; tab.render(ctx);
};
tab.render(ctx);
</script></body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-cache');
  if (url.pathname === '/calendar-test') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (url.pathname === '/api/earnings-calendar') {
    calendarReads++;
    if (mode === 'failed') { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.setHeader('etag', `"calendar-${url.searchParams.get('date')}-${revision}-${mode}"`);
    res.end(JSON.stringify(mode === 'invalid' ? { ok: false, degraded: 'Unavailable' } : payload(url.searchParams.get('date')))); return;
  }
  if (earningsBlocked && (url.pathname === '/api/earnings' || url.pathname === '/data/earnings-live.json')) {
    res.writeHead(503); res.end('{}'); return;
  }
  const api = url.pathname === '/api/earnings' ? '/data/earnings-live.json' : null;
  const file = resolve(root, `.${api || (url.pathname === '/' ? '/index.html' : url.pathname)}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'text/plain');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
async function open(scope = 'portfolio', fullApp = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({
    status: 200, contentType: 'text/javascript', body: '',
  }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(checkedAt) });
  await page.goto(fullApp ? `${origin}/#/research/earnings-hub?scope=${scope}&view=calendar&date=${DATE}` : `${origin}/calendar-test?scope=${scope}`);
  return page;
}
const renderedNames = page => page.locator('tr[data-row-key]').allTextContents();
try {
  for (const scope of ['portfolio', 'universe']) {
    mode = 'failed';
    const page = await open(scope);
    await page.getByText('The results calendar could not be loaded', { exact: true }).waitFor();
    mode = 'healthy';
    await page.clock.fastForward(60_001);
    await page.waitForFunction(date => window.calendar.forDate(date), DATE);
    assert.equal(await page.locator('tr[data-row-key]').count(), scope === 'portfolio' ? 1 : 3,
      `${scope}: a successful automatic retry must replace the first-load 503 without a click`);
    assert.match((await renderedNames(page)).join(' '), /Sterlite Technologies/);
    assert.equal(await page.getByText('The results calendar could not be loaded', { exact: true }).count(), 0);
    assert.match(await page.locator('[data-cal-info]').textContent(), /Schedule updated/,
      'the failure is cleared before recovery subscribers repaint');
    await page.context().close();
  }
  console.log('PASS Portfolio and Universe automatically recover from an initial calendar 503');

  // A later outage must notify the renderer without discarding rows or the reader's table view.
  const page = await open('universe');
  await page.locator('tr[data-row-key]').first().waitFor();
  await page.locator('[data-table-search]').fill('Sterlite');
  await page.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 1);
  mode = 'failed';
  await page.clock.fastForward(60_001);
  await page.waitForFunction(date => window.calendar.errorFor(date), DATE);
  assert.match(await page.locator('[data-cal-info]').textContent(), /Saved schedule · retrying/);
  assert.equal(await page.locator('[data-table-search]').inputValue(), 'sterlite');
  assert.equal((await renderedNames(page)).length, 1);
  assert.equal(await page.evaluate(date => calendar.forDate(date).listCapturedAt, DATE), checkedAt);

  // An unchanged ETag still clears the failure. The same rows alone are not the whole UI state.
  mode = 'healthy';
  await page.clock.fastForward(60_001);
  await page.waitForFunction(date => !calendar.errorFor(date), DATE);
  assert.match(await page.locator('[data-cal-info]').textContent(), /Schedule updated/);
  assert.equal(await page.locator('[data-table-search]').inputValue(), 'sterlite');

  mode = 'invalid';
  await page.clock.fastForward(60_001);
  await page.waitForFunction(date => calendar.errorFor(date), DATE);
  assert.equal((await renderedNames(page)).length, 1, 'malformed success cannot erase the last valid schedule');
  mode = 'failed';
  await page.reload();
  await page.locator('tr[data-row-key]').first().waitFor();
  assert.equal((await renderedNames(page)).length, 3, 'a reload during a 503 restores the saved full schedule');
  assert.match(await page.locator('[data-cal-info]').textContent(), /Saved schedule · retrying/);
  assert.equal(await page.evaluate(date => calendar.forDate(date).listCapturedAt, DATE), checkedAt);
  mode = 'healthy';
  await page.clock.fastForward(60_001);
  await page.waitForFunction(date => !calendar.errorFor(date), DATE);
  assert.match(await page.locator('[data-cal-info]').textContent(), /Schedule updated/);
  console.log('PASS failed checks retain rows, filters and source times; reload and unchanged recovery stay truthful');

  // A scope change must keep the poller attached to the visible renderer.
  await page.locator('#portfolio').click();
  assert.equal((await renderedNames(page)).length, 1);
  rows.push(event('STLTECH', 'Sterlite new call'));
  revision++;
  await page.clock.fastForward(60_001);
  await page.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 2);
  await page.locator('#universe').click();
  assert.equal((await renderedNames(page)).length, 4, 'Universe also retains unresolved issuers');
  await page.locator(`[data-date="${NEXT}"]`).click();
  await page.waitForFunction(date => calendar.forDate(date), NEXT);
  assert.equal(await page.locator('[aria-current="date"]').getAttribute('data-date'), NEXT);
  mode = 'failed';
  await page.clock.fastForward(60_001);
  await page.waitForFunction(date => calendar.errorFor(date), NEXT);
  assert.match(await page.locator('[data-cal-info]').textContent(), /Saved schedule · retrying/);
  assert.equal(await page.evaluate(date => calendar.errorFor(date), DATE), null, 'the selected date owns its error');
  mode = 'empty';
  await page.clock.fastForward(60_001);
  await page.getByText('Nothing scheduled on this date', { exact: true }).waitFor();
  assert.equal((await renderedNames(page)).length, 0, 'a verified empty read clears an old schedule');
  assert.match(await page.locator('[data-cal-info]').textContent(), /Schedule updated/);
  console.log('PASS scope switches, newly published rows, selected-date polling and verified empty schedules');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const beforeHidden = calendarReads;
  mode = 'healthy';
  await page.clock.fastForward(120_001);
  assert.equal(calendarReads, beforeHidden, 'hidden calendars pause their requests');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(1);
  await page.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 4);
  assert.equal(await page.locator('[aria-current="date"]').getAttribute('data-date'), NEXT);
  console.log('PASS returning after inactivity refreshes the selected schedule automatically');
  await page.context().close();

  // Opening Calendar cannot depend on the separate Earnings Reported route or its capture.
  earningsBlocked = true;
  mode = 'healthy';
  const independent = await open();
  await independent.locator('tr[data-row-key]').first().waitFor();
  assert.equal((await renderedNames(independent)).length, 2);
  assert.match(await independent.locator('[data-cal-info]').textContent(), /Schedule updated/);

  let captureRoute;
  const oldRequest = new Promise(done => { captureRoute = done; });
  await independent.route('**/api/earnings-calendar?*', route => captureRoute(route));
  await independent.evaluate(date => {
    tab.destroy();
    window.oldRead = calendar.loadDate(date).catch(() => null);
  }, NEXT);
  const heldRoute = await oldRequest;
  await independent.evaluate(() => calendar.reset());
  await heldRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload(NEXT)) });
  await independent.evaluate(() => window.oldRead);
  assert.equal(await independent.evaluate(date => calendar.forDate(date), NEXT), null,
    'a response from an ended visit cannot populate the new visit');
  assert.equal(await independent.evaluate(async date => {
    const { readEntry, KEYS } = await import('/js/core/store.js');
    return readEntry(KEYS.calendar(date));
  }, NEXT), null, 'the ended visit cannot overwrite persisted calendar state either');
  await independent.context().close();
  assert(calendarReads > 10, 'the regression exercised actual requests across automatic ticks');
  console.log('PASS Calendar loads even when Earnings Reported and its snapshot are unavailable');

  // Finally exercise the complete application shell and real names-only portfolio, including
  // the global scope controls used in the customer's embedded dashboard.
  earningsBlocked = false;
  const heldCompany = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'))).holdings.find(row => row.ticker);
  rows.push(event(heldCompany.ticker, heldCompany.name));
  revision++;
  mode = 'failed';
  const app = await open('portfolio', true);
  await app.getByText('The results calendar could not be loaded', { exact: true }).waitFor();
  mode = 'healthy';
  await app.clock.fastForward(60_001);
  await app.locator('tr[data-row-key]').first().waitFor();
  const portfolioRows = await renderedNames(app);
  assert(portfolioRows.some(text => text.includes(heldCompany.name)));
  assert(!portfolioRows.some(text => text.includes('Unresolved issuer')));
  await app.locator('#scope-toggle-mount').getByRole('button', { name: 'Universe', exact: true }).click();
  await app.waitForFunction(count => document.querySelectorAll('#content-host tr[data-row-key]').length === count, rows.length);
  assert.match((await renderedNames(app)).join(' '), /Unresolved issuer/);
  assert.match(await app.locator('[data-cal-info]').textContent(), /Schedule updated/);
  await app.context().close();
  console.log('PASS the full dashboard recovers automatically and its Portfolio / Universe controls retain the correct events');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
