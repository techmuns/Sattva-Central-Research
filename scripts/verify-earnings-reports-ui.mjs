// Local fixtures only: real renderer, document reader, and returning-session worker upgrade.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { readWorkbook } from './lib/xlsx-read.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const excelBrowser = readFileSync(resolve(process.env.EXCELJS_ROOT || resolve(process.env.PLAYWRIGHT_ROOT, '../exceljs'), 'dist/exceljs.min.js'));
const root = resolve('public');
const results = { meta: { currentPeriod: 'Jun 26', priorPeriod: 'Jun 25', subType: 'yoy', count: 2 },
  rows: ['HORIZONIND', 'RELIANCE'].map((ticker, index) => ({
    ticker, scId: `fixture-${index}`, name: ticker, resultDate: '2026-09-11', basis: 'Standalone',
    revenue: { current: 42, prior: 31, kind: 'normal', pct: 35, direction: 1 },
    netProfit: { current: 63, prior: -12, kind: 'turnaround', pct: null, direction: 1 },
  })) };
let upgraded = false, mode = 'exchange', sourceReads = 0, captureReads = 0, reportingYear = 2026, projectionReads = 0, resultsDegraded = null, filterResults = false;
const resultsFor = subType => {
  const future = reportingYear === 2028;
  const growth = { current: 63, prior: 50, kind: 'normal', pct: 26, direction: 1 };
  const rows = filterResults ? [
    { ...results.rows[0], netProfit: growth },
    { ...results.rows[1], basis: 'Consolidated', netProfit: { ...growth, current: 40, pct: -20, direction: -1 } },
    { ...results.rows[0], ticker: 'FILTERCON', scId: 'fixture-con', name: 'Filter Consolidated', fullName: 'Filter Consolidated', basis: 'Consolidated', netProfit: growth },
  ] : results.rows;
  const meta = { ...results.meta, count: rows.length, subType, structureTag: filterResults ? 'filter-fixture' : 'unchanged-figures',
    quarter: future ? 'Q2 FY28-29' : 'Q1 FY26-27',
    currentPeriod: future ? 'Sep 28' : 'Jun 26',
    priorPeriod: subType === 'qoq' ? (future ? 'Jun 28' : 'Mar 26') : (future ? 'Sep 27' : 'Jun 25') };
  return { rows, meta };
};
const oldReport = ticker => ({ ticker, form: 'earnings_report', date: 'Mar 2026', url: `${origin}/documents/old` });
const currentReport = ticker => ({ ticker, form: 'earnings_report', date: 'Jun 2026', url: `${origin}/documents/${ticker}.pdf` });
const entry = `
import * as tab from '/js/tabs/earnings-hub.js';
import * as coverage from '/js/data/coverage.js';
import * as feed from '/js/data/earnings-live.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
import { enterView, captureTableReading } from '/js/core/view-reading.js';
coverage.prime({holdings:[{ticker:'HORIZONIND',name:'Horizon Ind'}]});
window.ctx={scope:'portfolio',root:document.querySelector('main'),data:{},params:{},
  setParamsQuiet(params){this.params=params},setParams(params){this.params=params;tab.render(this)}};
window.tab=tab;
window.feed=feed;
window.enterView=enterView;
window.captureReading=()=>captureTableReading(ctx.root);
tab.render(ctx);
if(new URL(location.href).searchParams.has('upgrade')) {
  watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
}
window.ready=true;`;
const shellStyles = [...readFileSync(resolve(root, 'index.html'), 'utf8').matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(match => match[0]).join('');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css">${shellStyles}<link rel="stylesheet" href="/css/theme.css"><script src="/js/theme-init.js"></script></head><body style="padding:20px"><main></main><script type="module" src="/js/earnings-test.js"></script></body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  res.setHeader('cache-control', 'no-cache');
  const send = (type, body) => { res.setHeader('content-type', type); res.end(body); };
  const json = body => send('application/json', JSON.stringify(body));
  if (pathname === '/' || pathname === '/index.html') return send('text/html', html);
  if (pathname === '/js/earnings-test.js') return send('text/javascript', entry);
  if (pathname === '/sdk-fixture.js') return send('text/javascript', '');
  if (pathname.startsWith('/documents/')) return send('text/html', `<h1>Original filing ${pathname}</h1>`);
  if (pathname === '/api/earnings') {
    const payload = resultsFor(url.searchParams.get('subType') || 'yoy');
    if (url.searchParams.get('fields') === 'prices') {
      projectionReads++;
      return json({ fields: 'prices', structureTag: payload.meta.structureTag, meta: payload.meta, degraded: resultsDegraded,
        prices: Object.fromEntries(payload.rows.map(row => [row.scId, [null, null]])) });
    }
    return json(payload);
  }
  if (pathname === '/data/earnings-live.json') return json(resultsFor('yoy'));
  if (pathname === '/data/filing-capture/index.json') return json({ version: 1, sources: { domestic: {} } });
  if (pathname.startsWith('/data/filing-capture/announcements/')) {
    const ticker = pathname.split('/').at(-1).replace('.json', '');
    return json({ rows: mode === 'exchange' ? [{ ticker, date: '2026-09-11', category: 'Result',
      title: 'Unaudited financial results for the quarter ended June 30, 2026', url: `${origin}/documents/${ticker}.pdf` }] : [] });
  }
  if (pathname.startsWith('/data/filing-capture/domestic/')) {
    captureReads++;
    const ticker = pathname.split('/').at(-1).replace('.json', '');
    return json({ rows: mode === 'captured' ? [oldReport(ticker), currentReport(ticker)] : [oldReport(ticker)] });
  }
  if (pathname.startsWith('/api/domestic-filings/')) {
    sourceReads++;
    if (mode === 'failed') { res.statusCode = 503; return json({ ok: false }); }
    const ticker = pathname.split('/').at(-1);
    return json({ ok: true, documents: mode === 'live' ? [currentReport(ticker)] : [] });
  }
  try {
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep)) throw new Error('path');
    let body = readFileSync(file);
    if (pathname === '/sw.js') {
      body = body.toString().replace("const APP_ENTRY = '/js/app.js';", "const APP_ENTRY = '/js/earnings-test.js';")
        .replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (!upgraded) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-earnings-release`;');
    }
    if (pathname === '/js/tabs/earnings-hub.js' && !upgraded) {
      body = body.toString().replace('const VIEWS = [', "const VIEWS = [{value:'filings',label:'Company Filings',help:'Documents'},")
        .replace('const cur = reportingPeriodLabel(m?.currentPeriod, \'Current period\');', "const cur = m?.currentPeriod || 'Current';")
        .replace('const pri = reportingPeriodLabel(m?.priorPeriod, \'Comparison period\');', "const pri = m?.priorPeriod || 'Prior';")
        .replace("description: 'Latest reported quarterly results, newest first.',",
          "description: `Every company that has reported this quarter, newest first. ${m?.currentPeriod} against ${m?.priorPeriod}.`,");
    }
    send({ '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'text/plain', body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
async function open(upgrade = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: upgrade ? 'allow' : 'block' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/')
    ? route.continue() : route.fulfill({ status: 200, body: route.request().url().includes('/exceljs@4.4.0/') ? excelBrowser : '' }));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  await page.goto(`${origin}/${upgrade ? '?upgrade=1' : ''}`);
  await page.locator('[data-earnings-report]').first().waitFor();
  return page;
}
async function clickReport(page, ticker = 'HORIZONIND') {
  const popup = page.waitForEvent('popup');
  await page.locator(`[data-earnings-report="${ticker}"]`).click();
  return popup;
}
try {
  const returning = await open(true);
  await returning.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await returning.reload();
  await returning.locator('[data-view="filings"]').waitFor();
  assert.match(await returning.locator('[data-earnings-head]').textContent(), /Jun 26 against Jun 25/);
  const before = await returning.evaluate(() => caches.keys());
  assert(before.some(key => key.includes('previous-earnings-release')));
  upgraded = true;
  await returning.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await returning.waitForFunction(() => window.ready && document.querySelector('[data-view="reported"]') && !document.querySelector('[data-view="filings"]'));
  const after = await returning.evaluate(() => caches.keys());
  assert(after.some(key => !before.includes(key)));
  assert(!after.some(key => key.includes('previous-earnings-release')));
  assert.match(await returning.locator('[data-earnings-head]').textContent(), /Latest reported quarterly results, newest first\./);
  assert(!/against|Sep 26|Sep 25/.test(await returning.locator('[data-earnings-head]').textContent()));
  assert.equal(await returning.locator('th[data-sort="Revenue Jun 2026"]').count(), 1);
  assert.equal(captureReads, 0, 'opening earnings does not fetch every company document');
  const filing = await clickReport(returning);
  await filing.waitForURL(`${origin}/documents/HORIZONIND.pdf`);
  assert.equal(await filing.evaluate(() => window.opener), null);
  assert.equal(await returning.evaluate(() => ctx.params.period), undefined, 'opening a report must not change the YoY/QoQ comparison');
  assert.equal(sourceReads, 0, 'a matching saved report opens without an upstream request');
  assert.equal(await returning.locator('[data-view="filings"]').count(), 0);
  await filing.close();
  await returning.context().close();
  console.log('PASS returning reader loses Company Filings tab automatically and Reports opens the matching filing');

  for (const scenario of ['captured', 'live', 'missing', 'failed']) {
    mode = scenario;
    const page = await open();
    await page.evaluate(() => { ctx.scope = 'universe'; tab.render(ctx); });
    await page.locator('[data-earnings-report="RELIANCE"]').waitFor();
    const popup = await clickReport(page, 'RELIANCE');
    if (['captured', 'live'].includes(scenario)) await popup.waitForURL(`${origin}/documents/RELIANCE.pdf`);
    else {
      await popup.waitForFunction(() => !document.body.textContent.includes('Opening'));
      assert.equal(popup.url(), 'about:blank', 'a different quarter is never opened');
      assert.match(await popup.locator('body').textContent(), scenario === 'missing' ? /not available yet/ : /could not be checked/);
    }
    assert.equal(await page.locator('[data-view="filings"]').count(), 0);
    await page.context().close();
  }
  assert.equal(sourceReads, 3);
  filterResults = true;
  const filtersPage = await open();
  await filtersPage.evaluate(() => { ctx.scope = 'universe'; tab.render(ctx); });
  const rowsShown = () => filtersPage.locator('tr[data-row-key]').count();
  await filtersPage.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 3);
  const more = filtersPage.locator('[data-filter-group-toggle]');
  const resultScreen = filtersPage.getByRole('combobox', { name: 'Result screen', exact: true, includeHidden: true });
  const basis = filtersPage.getByRole('combobox', { name: 'Reporting basis', exact: true, includeHidden: true });
  const filterPanel = filtersPage.locator('[data-filter-group-panel]');
  assert.equal(await more.locator('[data-filter-group-summary]').innerText(), 'More filters');
  assert.equal(await filtersPage.locator('[data-table-toolbar] > div > select').count(), 0, 'no loose dropdowns remain in the toolbar');
  await more.focus();
  await filtersPage.keyboard.press('Enter');
  await filtersPage.locator('[data-filter-group-panel]:popover-open').waitFor();
  assert.deepEqual(await filterPanel.locator('.table-filter-group-field > span').allTextContents(), ['Result screen', 'Reporting basis']);
  assert.equal(await basis.locator('option:checked').innerText(), 'All reporting bases');
  assert.deepEqual(await resultScreen.locator('option[value^="pat-"]').allTextContents(), ['Net profit increased', 'Net profit decreased']);
  await resultScreen.selectOption('pat-up');
  await filtersPage.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 2);
  await basis.selectOption('con');
  await filtersPage.waitForFunction(() => document.querySelectorAll('tr[data-row-key]').length === 1);
  assert.match(await filtersPage.locator('tr[data-row-key]').innerText(), /Filter Consolidated/);
  assert.match(await more.innerText(), /More filters \(2\)/);
  await resultScreen.selectOption('pat-down');
  await filtersPage.waitForFunction(() => document.querySelector('tr[data-row-key]')?.textContent.includes('RELIANCE'));
  assert.equal(await rowsShown(), 1, 'the two performance directions remain distinct within the selected basis');
  await resultScreen.selectOption('pat-up');
  await filterPanel.getByRole('button', { name: 'Done', exact: true }).click();
  await filtersPage.locator('[data-table-search]').fill('filter');
  await filtersPage.locator('th[data-sort="Date"]').click();
  await filtersPage.evaluate(() => feed.refresh());
  await filtersPage.locator('[data-period="qoq"]').click();
  await filtersPage.locator('[data-period="qoq"][aria-pressed="true"]').waitFor();
  assert.equal(await resultScreen.inputValue(), 'pat-up');
  assert.equal(await basis.inputValue(), 'con');
  assert.match(await filtersPage.locator('th[data-sort="Date"]').innerText(), /▴/);
  assert.equal(await filtersPage.locator('[data-table-search]').inputValue(), 'filter');
  const downloadEvent = filtersPage.waitForEvent('download');
  await filtersPage.locator('[data-export]').click();
  const download = await downloadEvent;
  const workbook = readWorkbook(readFileSync(await download.path()))['Latest Results'];
  assert.equal(workbook.length, 3, 'the filtered export contains its header, provenance banner and one eligible result');
  assert.equal(workbook[2][1], 'FILTERCON');
  assert.equal(workbook[2][15], 'Consolidated');
  await filtersPage.getByRole('button', { name: 'Calendar', exact: true }).click();
  await filtersPage.getByRole('heading', { name: 'Earnings Calendar', exact: true }).waitFor();
  await filtersPage.getByRole('button', { name: 'Reported', exact: true }).click();
  await filtersPage.locator('[data-period="qoq"][aria-pressed="true"]').waitFor();
  assert.equal(await resultScreen.inputValue(), 'pat-up');
  assert.equal(await basis.inputValue(), 'con');
  await filtersPage.locator('[data-watch-toggle]').click();
  await more.click();
  await filterPanel.getByRole('button', { name: 'Clear more filters', exact: true }).click();
  const cleared = await filtersPage.evaluate(() => captureReading());
  assert.deepEqual(cleared.filters.map(filter => filter.value), ['all', 'all']);
  assert.equal(cleared.q, 'filter', 'Clear resets only the grouped filters');
  assert.equal(cleared.watchOnly, true, 'Clear preserves the independent Watchlist filter');
  assert.deepEqual(cleared.sort, { key: 'Date', dir: 'asc' });
  await filterPanel.getByRole('button', { name: 'Done', exact: true }).click();
  await filtersPage.evaluate(() => {
    tab.destroy();
    ctx.params = {};
    enterView({ key: 'legacy-saved-results', preset: { reading: { tableKey: 'sattva-earnings', q: 'filter',
      sort: { key: 'Date', dir: 'asc' }, filters: [{ label: 'Result shape', value: 'pat-up' }, { label: 'Reporting basis', value: 'con' }] } } });
    tab.render(ctx);
  });
  await filtersPage.waitForFunction(() => document.querySelector('[data-filter-group-toggle]')?.textContent.includes('More filters (2)'));
  assert.equal(await resultScreen.inputValue(), 'pat-up', 'old saved Result shape screens still restore');
  assert.equal(await basis.inputValue(), 'con');
  const saved = await filtersPage.evaluate(() => captureReading());
  assert.deepEqual(saved.filters, [{ label: 'Result screen', value: 'pat-up' }, { label: 'Reporting basis', value: 'con' }]);
  await filtersPage.evaluate(saved => { tab.destroy(); enterView({ key: 'new-saved-results', preset: { reading: saved } }); tab.render(ctx); }, saved);
  await filtersPage.waitForFunction(() => document.querySelector('[data-filter-group-toggle]')?.textContent.includes('More filters (2)'));
  assert.equal(await resultScreen.inputValue(), 'pat-up', 'new saved screens restore the clearer label');
  assert.equal(await basis.inputValue(), 'con');
  assert.equal(await rowsShown(), 1);
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await filtersPage.setViewportSize({ width, height: 900 });
    await filtersPage.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await more.click();
    assert(await filterPanel.evaluate(panel => {
      const box = panel.getBoundingClientRect();
      return panel.matches(':popover-open') && box.left >= 12 && box.right <= innerWidth - 11 && box.top >= 12 && box.bottom <= innerHeight - 11 &&
        document.documentElement.scrollWidth <= innerWidth + 1 && [...panel.querySelectorAll('select')].every(el => el.getBoundingClientRect().right <= box.right);
    }), `More filters is reachable and unclipped at ${width}px in ${theme}`);
    if (process.env.EARNINGS_SCREENSHOT_DIR) await filtersPage.screenshot({ path: `${process.env.EARNINGS_SCREENSHOT_DIR}/filters-${width}-${theme}.png`, fullPage: true });
    await filtersPage.keyboard.press('Escape');
    assert.equal(await filterPanel.isVisible(), false);
    assert(await more.evaluate(el => el === document.activeElement), 'Escape returns keyboard focus to More filters');
  }
  await filtersPage.context().close();
  filterResults = false;
  console.log('PASS grouped result/basis filters: independent intersections, filtered Excel export, refresh/comparison/navigation retention, scoped Clear, old/new saved views, keyboard and responsive themes');
  // November 2028 cannot relabel an older source. A corrected source period then
  // repaints even with identical rows, figures and price structure tag.
  const future = await open();
  await future.clock.setFixedTime(new Date('2028-11-02T06:00:00Z'));
  assert.equal(await future.locator('th[data-sort="Revenue Jun 2026"]').count(), 1, 'old cached figures retain their reported year');
  await future.locator('[data-table-search]').fill('horizon');
  await future.locator('th[data-sort="Revenue Jun 2026"]').click();
  reportingYear = 2028;
  await future.evaluate(() => feed.refresh());
  await future.locator('th[data-sort="Revenue Sep 2028"]').waitFor();
  assert.match(await future.locator('th[data-sort="Revenue Sep 2028"]').textContent(), /▾/, 'the selected metric sort follows its new period label');
  assert.equal(await future.locator('[data-table-search]').inputValue(), 'horizon');
  assert.equal(await future.locator('th[data-sort="Revenue Sep 2027"]').count(), 1);
  assert.equal(await future.locator('[data-earnings-report]').first().getAttribute('data-report-period'), 'Sep 28', 'report lookup keeps the original source period');
  const header = await future.locator('[data-earnings-head]').textContent();
  assert.equal(await future.locator('[data-view-toggle], [data-period-toggle]').count(), 2);
  assert.deepEqual(await future.locator('[data-view]').allTextContents(), ['Reported', 'Calendar']);
  assert.equal(await future.locator('[data-live-info]').count(), 0);
  assert.equal(await future.locator('[data-results-context]').innerText(), 'Q2 FY28-29 · Figures in ₹ crore');
  assert(!/Universe|Live|reported$/.test(await future.locator('[data-section-controls]').innerText()));
  assert(!/against|this quarter|Sep 26|Sep 25/.test(header));
  await future.locator('[data-period="qoq"]').click();
  await future.locator('[data-period="qoq"][aria-pressed="true"]').waitFor();
  assert.equal(await future.locator('th[data-sort="Revenue Jun 2028"]').count(), 1);
  assert.equal(await future.locator('th[data-sort="Revenue Sep 2028"]').count(), 1);
  assert(projectionReads > 0, 'the ordinary price projection discovers the reporting-period correction');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900, 390, 320]) {
    await future.setViewportSize({ width, height: 900 });
    await future.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert(await future.locator('.earnings-reading-controls').evaluate(el => {
      const groups = [...el.querySelectorAll('.earnings-switch')].map(group => group.getBoundingClientRect());
      const line = el.querySelector('[data-results-context]').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth + 1 && line.height <= 21 && groups.every(group => group.left >= 0 && group.right <= innerWidth && group.bottom <= line.top) &&
        (groups[0].right <= groups[1].left || groups[0].bottom <= groups[1].top);
    }), `two aligned switches and one-line context without overflow at ${width}px in ${theme}`);
    if (process.env.EARNINGS_SCREENSHOT_DIR) await future.screenshot({ path: `${process.env.EARNINGS_SCREENSHOT_DIR}/earnings-${width}-${theme}.png`, fullPage: true });
  }
  await future.getByRole('button', { name: 'Calendar', exact: true }).click();
  await future.getByRole('heading', { name: 'Earnings Calendar', exact: true }).waitFor();
  await future.getByRole('button', { name: 'Reported', exact: true }).click();
  await future.locator('[data-period="qoq"][aria-pressed="true"]').waitFor();
  assert.equal(await future.locator('[data-results-context]').innerText(), 'Q2 FY28-29 · Figures in ₹ crore');
  resultsDegraded = 'Results source unavailable in fixture';
  await future.evaluate(() => feed.refresh());
  assert.match(await future.locator('[data-results-status]').innerText(), /Snapshot · update unavailable/);
  assert.equal(await future.locator('[data-table-search]').inputValue(), 'horizon');
  assert.equal(await future.locator('tr[data-row-key]').count(), 1, 'retained results survive while the failure stays visible');
  resultsDegraded = null;
  await future.evaluate(() => feed.refresh());
  assert.equal(await future.locator('[data-results-status]').count(), 0, 'source recovery clears the failure notice without restoring the Live chip');
  await future.screenshot({ path: '/tmp/sattva-results-periods-2028.png', fullPage: true });
  await future.context().close();
  console.log('PASS evergreen Results copy, source-bound full years, period-only corrections, retained sort/search, future YoY/QoQ and cached-session upgrade');
  assert.deepEqual(errors, []);
  console.log('PASS Universe clicks recover an uncaptured report, preserve the displayed table, and disclose missing/failed reports without opening another quarter');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
