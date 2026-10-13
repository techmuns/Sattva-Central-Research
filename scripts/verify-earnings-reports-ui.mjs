// Local fixtures only: real renderer, document reader, and returning-session worker upgrade.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const results = { meta: { currentPeriod: 'Jun 26', priorPeriod: 'Jun 25', subType: 'yoy', count: 2 },
  rows: ['HORIZONIND', 'RELIANCE'].map((ticker, index) => ({
    ticker, scId: `fixture-${index}`, name: ticker, resultDate: '2026-09-11', basis: 'Standalone',
    revenue: { current: 42, prior: 31, kind: 'normal', pct: 35, direction: 1 },
    netProfit: { current: 63, prior: -12, kind: 'turnaround', pct: null, direction: 1 },
  })) };
let upgraded = false, mode = 'exchange', sourceReads = 0, captureReads = 0, reportingYear = 2026, projectionReads = 0, resultsDegraded = null;
const resultsFor = subType => {
  const future = reportingYear === 2028;
  const meta = { ...results.meta, subType, structureTag: 'unchanged-figures',
    quarter: future ? 'Q2 FY28-29' : 'Q1 FY26-27',
    currentPeriod: future ? 'Sep 28' : 'Jun 26',
    priorPeriod: subType === 'qoq' ? (future ? 'Jun 28' : 'Mar 26') : (future ? 'Sep 27' : 'Jun 25') };
  return { ...results, meta };
};
const oldReport = ticker => ({ ticker, form: 'earnings_report', date: 'Mar 2026', url: `${origin}/documents/old` });
const currentReport = ticker => ({ ticker, form: 'earnings_report', date: 'Jun 2026', url: `${origin}/documents/${ticker}.pdf` });
const entry = `
import * as tab from '/js/tabs/earnings-hub.js';
import * as coverage from '/js/data/coverage.js';
import * as feed from '/js/data/earnings-live.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
coverage.prime({holdings:[{ticker:'HORIZONIND',name:'Horizon Ind'}]});
window.ctx={scope:'portfolio',root:document.querySelector('main'),data:{},params:{},
  setParamsQuiet(params){this.params=params},setParams(params){this.params=params;tab.render(this)}};
window.tab=tab;
window.feed=feed;
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
    ? route.continue() : route.fulfill({ status: 200, body: '' }));
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
