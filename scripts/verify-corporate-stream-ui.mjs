// Isolated browser regression: all data and API responses are local synthetic fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const at = '2026-09-04T13:00:00Z';
const company = (ticker) => ({ ticker, name: `${ticker} Test Company` });
const filing = (ticker, id, date = '2026-09-04') => ({ ticker, company: company(ticker).name, title: `${ticker} announcement ${id}`, date, time: '15:00:00', source: 'BSE', url: `https://example.test/${ticker}/${id}.pdf` });
const dualHash = `sha256:${'4c'.repeat(32)}`;
const dualPairId = `sha256:${'7a'.repeat(32)}`;
const bseRows = [
  { ...filing('TCS', 'cross-exchange'), documentHash: dualHash, crossExchangeDocumentId: dualPairId },
  ...Array.from({ length: 139 }, (_, i) => filing('TCS', i)),
];
const nseRow = { ticker: 'TCS', company: 'TCS Test Company', subject: 'NSE meeting', publishedAt: '2026-09-04T12:00:00Z', url: 'https://example.test/nse.pdf' };
let nseRows = [nseRow, { ...nseRow, ticker: null, company: 'Unresolved Company', url: 'https://example.test/unresolved.pdf' }];
let fail = false;
const hits = new Map();
const enrollments = [];
const searches = [];
let failSearch = false;
let failRecovery = false;
let legacy = false;
const bodies = {
  '/data/screener-announcements.json': { version: 1, rows: [], rowCount: 0, pending: [], lastAttemptAt: at, lastPageAt: at, lastSuccessAt: at, updatedAt: at, captureStart: at },
  '/data/filing-capture/nse-identities.json': { version: 1, directories: { sme: { entries: [] }, equity: { entries: [] } } },
  '/data/announcement-identities.json': { version: 1, capturedAt: at, entries: [
    { isin: 'INE564S01019', bseCode: '539659', bseSymbol: 'KAMATS', ticker: 'KAMATS', name: 'Vikram Kamats Hospitality Ltd' },
    { isin: 'INE094B01013', bseCode: '543766', bseSymbol: 'ASHIKAG', ticker: 'ASHIKAG', name: 'Ashika Global Securities Ltd' },
  ] },
  '/data/corp-announcements.json': { kind: 'announcements', capturedAt: at, coversUniverse: true, windowDays: 3, byTicker: { TCS: bseRows, INFY: [filing('INFY', 1)] } },
  '/data/filing-capture/index.json': { version: 1, updatedAt: at, companies: [company('TCS')], sources: { announcements: { TCS: { rowCount: 2, lastSuccessAt: at } } }, unresolved: ['Unresolved Company'] },
  '/data/filing-capture/announcements-recent.json': { rows: [{ ...filing('TCS', 'cross-exchange'), source: 'NSE',
    title: 'Same filing delivered through NSE', time: '15:10:00', url: 'https://nsearchives.nseindia.com/corporate/cross-exchange.pdf',
    documentHash: dualHash, crossExchangeDocumentId: dualPairId }] },
  '/data/filing-capture/announcements/TCS.json': { rows: [{ ...filing('TCS', 'older-company', '2025-01-01'), source: 'DRHP' }] },
  '/data/announcements-archive/index.json': { months: { '2025-01': 1 }, updatedAt: at },
  '/data/announcements-archive/2025-01.json': { rows: [filing('TCS', 'older-bse', '2025-01-02')] },
  '/data/nse-filings/index.json': { days: [{ day: '2026-07-01', revision: 'one', count: 1 }] },
  '/data/nse-filings/2026-07-01.json': { rows: [{ ...nseRow, subject: 'Historical NSE filing', publishedAt: '2026-07-01T12:00:00Z', url: 'https://example.test/historical-nse.pdf' }] },
};
bodies['/data/corp-announcements.json'].byTicker.KAMATS = [{ ...filing('KAMATS', 1), scripCode: '539659' }];
bodies['/data/corp-announcements.json'].byTicker.ASHIKAG = [{ ...filing('ASHIKAG', 1), scripCode: '543766' }];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>#modal-overlay.is-open #modal-container{opacity:1}</style><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head><body class="bg-slate-50 p-4"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/corp-announcements.js';
import * as live from '/js/core/live.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import {corporateAnnouncements as feed} from '/js/data/corporate-announcements.js';
import {startWatchlistCapture,watchlistCapture} from '/js/data/watchlist-capture.js';
coverage.prime({holdings:[{ticker:'TCS',name:'TCS Test Company'}, {isin:'INE564S01019',ticker:null,name:'Vikram Kamats Hospitality'}, {isin:'INE094B01013',ticker:null,name:'Ashika Credit Capital'}]}); watchlist.add('INFY','INFY Test Company');
window.renderScope=(scope)=>{const root=document.querySelector('#root');root.innerHTML='';tab.render({root,scope,live,data:{universe:[{ticker:'TCS'},{ticker:'INFY'}]},params:{}});};
window.stream=feed;window.caQuery=tab.announcementQuery;window.destroyStream=()=>tab.destroy();window.renderScope('portfolio');
window.addFutureHolding=()=>coverage.prime({holdings:[...coverage.holdings(),{isin:'INE000Z01019',ticker:null,name:'Future SME'}]});
window.addWatch=watchlist.add;window.enrollment=watchlistCapture;startWatchlistCapture();
</script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  hits.set(path, (hits.get(path) || 0) + 1);
  res.setHeader('cache-control', 'no-store');
  if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/sdk-fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end('/* isolated SDK */'); return; }
  if (path === '/api/stock-search') {
    const query = new URL(req.url, 'http://localhost').searchParams.get('q');
    searches.push(query);
    res.setHeader('content-type', 'application/json');
    res.statusCode = failSearch ? 503 : 200;
    res.end(JSON.stringify(failSearch ? { ok: false } : { ok: true, results: /^bharat$/i.test(query) ? [
      { ticker: '541096', name: 'Bharat Parenterals Ltd', country: 'India', validTicker: true },
      { ticker: 'INFY', name: 'Infosys Ltd', country: 'India', validTicker: true },
      { ticker: 'FOREIGN', name: 'Foreign listing', country: 'United States', validTicker: true },
      { ticker: 'Invalid symbol', name: 'Not a listed symbol', country: 'India', validTicker: false },
    ] : [] })); return;
  }
  if (path === '/api/capture-registration' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const value = JSON.parse(body); enrollments.push(value);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, registered: value.tickers, unresolved: [], pending: [], capacity: [] }));
    }); return;
  }
  if (path === '/api/nse-announcements' || path === '/data/nse-announcements.json') {
    res.setHeader('content-type', 'application/json');
    res.statusCode = fail ? 503 : 200; res.end(JSON.stringify(fail ? {} : { ok: true, capturedAt: at, rows: nseRows })); return;
  }
  if (path === '/data/screener-announcements.json' && failRecovery) { res.writeHead(503); res.end('{}'); return; }
  if (bodies[path]) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(bodies[path])); return; }
  if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
  try {
    const file = resolve(root, `.${path}`); assert(file.startsWith(root + sep));
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (legacy) body = body.replace('-announcement-company-search-v1', '').replace('-announcement-recovery-v1', '').replace('-announcement-search-clarity-v1', '');
    }
    if (path === '/js/data/announcements-extra.js' && legacy) body = body.toString().replaceAll(', loadRecovery()', '');
    if (path === '/js/tabs/filings-tab.js' && legacy) body = body.toString().replace('      searchControl,', '');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 200, body: '{}' }));
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  // The table is answered a page at a time by the announcement query (in this static fixture, by the
  // browser's own engine over the captures), so every search, filter, scope or refresh is awaited
  // until the query on screen has been answered.
  const settle = () => page.waitForFunction(() => window.caQuery?.meta().state === 'ready' && !window.caQuery.meta().refreshing);
  const fillSearch = async (text) => {
    await search.fill(text);
    await page.waitForFunction((q) => window.caQuery.query().q === q && window.caQuery.meta().state === 'ready' && !window.caQuery.meta().refreshing, text.trim().toLowerCase());
  };
  const rescope = async (scope) => { await page.evaluate((value) => window.renderScope(value), scope); await settle(); };
  const refreshStream = async () => { await page.evaluate(() => window.stream.refresh()); await settle(); };
  const selectPeriod = async (value) => {
    await period.selectOption(value);
    await page.waitForFunction((v) => window.caQuery.query().period === v && window.caQuery.meta().state === 'ready', value);
  };
  const companySettled = (selected) => page.waitForFunction((want) => !!window.caQuery.query().company === want && window.caQuery.meta().state === 'ready', selected);
  let search, period;
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin);
  await page.waitForFunction(() => window.stream?.meta().archive?.loaded && window.stream.rows().some(r => r.title === 'Historical NSE filing'));
  await page.waitForFunction(() => window.enrollment.status().remaining.length === 0);
  assert.deepEqual(enrollments, [{ tickers: ['INFY'] }], 'existing watchlist enrolls automatically without sending its names or membership metadata');
  assert.equal(await page.locator('[data-capture-coverage], [data-announcement-lookup], [data-load-filing-history], [data-watch-toggle], [data-document-tabs]').count(), 0);
  period = page.getByRole('combobox', { name: 'Announcement period (IST)' });
  search = page.locator('[data-table-search]');
  assert.equal(await period.inputValue(), 'all');
  assert.deepEqual(await period.locator('option').allTextContents(), ['Today', 'Last 3 days', 'Last 7 days', 'This month', 'All time']);
  await page.waitForFunction(() => /^146 announcements/.test(document.querySelector('[data-row-count]')?.textContent || ''));
  assert.match(await page.locator('[data-row-count]').innerText(), /^146 announcements · 3 companies with filings$/);
  assert.equal(await page.evaluate(() => window.stream.rows().filter(r => r.url === 'https://example.test/nse.pdf').length), 1);
  await fillSearch('cross-exchange');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'byte-identical BSE/NSE rows render once');
  assert.match(await page.locator('tbody tr[data-row-key]').innerText(), /BSE \/ NSE/);
  assert.deepEqual(await page.evaluate(() => window.stream.rows().find(r => r.documentHash)?.sourceUrls), [
    { source: 'BSE', url: 'https://example.test/TCS/cross-exchange.pdf' },
    { source: 'NSE', url: 'https://nsearchives.nseindia.com/corporate/cross-exchange.pdf' },
  ]);
  await fillSearch('');
  assert(await page.locator('tbody tr[data-row-key]').count() <= 160, 'table DOM stays bounded');
  console.log('PASS clean portfolio stream, source deduplication and automatic BSE/company/NSE history');
  await fillSearch('KAMATS');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'BSE-only holding matches by ISIN');
  await fillSearch('ASHIKAG');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'renamed company matches the old book name through ISIN');
  await fillSearch('older-company');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  await search.evaluate(el => { window.activeSearch = el; });
  await refreshStream();
  assert.equal(await search.inputValue(), 'older-company');
  assert(await search.evaluate(el => el === document.activeElement));
  assert(await search.evaluate(el => el === window.activeSearch), 'status-only updates preserve the mounted search field');
  assert.equal(hits.get('/data/filing-capture/announcements/TCS.json'), 1);
  assert.equal(hits.get('/data/announcements-archive/2025-01.json'), 1);
  bodies['/data/corp-announcements.json'].lastError = { message: 'Latest BSE request failed.' };
  bodies['/data/corp-announcements.json'].lastAttemptAt = '2026-09-04T13:01:00Z';
  bodies['/data/corp-announcements.json'].coversUniverse = false;
  await refreshStream();
  assert.equal(await page.evaluate(() => window.stream.meta().sourceCheck.error.message), 'Latest BSE request failed.', 'a newer failed attempt is adopted even when the last successful capture time did not move');
  assert.match(await page.locator('[data-filings-info]').innerText(), /Some announcements may be missing/);
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'outage notices preserve matching retained history');
  bodies['/data/corp-announcements.json'].lastError = null;
  bodies['/data/corp-announcements.json'].coversUniverse = true;
  console.log('PASS history is searchable, polling skips unchanged archives, and search focus survives updates');
  await fillSearch('');
  await page.locator('[data-table-scroll]').evaluate(el => { el.scrollTop = 600; });
  await page.waitForTimeout(50);
  const anchor = await page.locator('[data-table-scroll]').evaluate(el => {
    const row = [...el.querySelectorAll('tbody tr')].find(row => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top + 40);
    return { key: row.dataset.rowKey, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
  });
  nseRows = [{ ...nseRow, subject: 'Just arrived', publishedAt: '2026-09-04T13:00:00Z', url: 'https://example.test/new.pdf' }, ...nseRows];
  await page.clock.fastForward(90100);
  await page.waitForFunction(() => document.querySelector('tbody tr[data-row-key]')?.textContent.includes('Just arrived') && !window.stream.meta().archive.pending);
  const after = await page.locator('[data-table-scroll]').evaluate((el, key) => {
    const row = [...el.querySelectorAll('tbody tr')].find(row => row.dataset.rowKey === key);
    return row?.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, anchor.key);
  assert(Math.abs(after - anchor.offset) < 3, `reader position moved by ${after - anchor.offset}`);
  await fillSearch('Just arrived'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  console.log('PASS automatic arrivals preserve the reading position and join search immediately');
  await fillSearch('');
  await rescope('watchlist');
  assert.match(await page.locator('[data-row-count]').innerText(), /^1 announcement · 1 company with filings$/);
  await rescope('universe');
  assert(await page.evaluate(() => window.stream.rows().some(r => r.company === 'Unresolved Company')));
  await fillSearch('Unresolved Company'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  await rescope('portfolio');
  await fillSearch('Unresolved Company'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0);
  console.log('PASS portfolio/watchlist/universe isolation, including unresolved exchange identities');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = hits.get('/api/nse-announcements');
  await page.clock.fastForward(180000);
  assert.equal(hits.get('/api/nse-announcements'), hiddenReads);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !window.stream.meta().archive.pending);
  await refreshStream();
  assert(hits.get('/api/nse-announcements') > hiddenReads);
  console.log('PASS polling pauses while hidden and refreshes on return');
  await page.evaluate(() => window.stream.loadArchive());
  const companyReads = hits.get('/data/filing-capture/announcements/TCS.json');
  const monthReads = hits.get('/data/announcements-archive/2025-01.json');
  bodies['/data/filing-capture/index.json'].sources.announcements.TCS.bse = {
    bseCode: '500001', lastSuccessAt: '2026-09-04T13:04:00Z', lastResponseAt: '2026-09-04T13:04:00Z',
  };
  bodies['/data/filing-capture/announcements/TCS.json'].rows[0].summary = 'BSE-only same-count revision';
  await page.clock.fastForward(61000);
  await page.evaluate(() => window.stream.loadArchive({ onlyChanged: true }));
  await page.waitForFunction(() => window.stream.rows().some(r => r.summary === 'BSE-only same-count revision'));
  assert.equal(hits.get('/data/filing-capture/announcements/TCS.json'), companyReads + 1,
    'a BSE-only revision reloads the company file when its aggregate row count is unchanged');
  const afterBseReads = hits.get('/data/filing-capture/announcements/TCS.json');
  bodies['/data/filing-capture/index.json'].sources.announcements.TCS.lastSuccessAt = '2026-09-04T13:05:00Z';
  bodies['/data/filing-capture/announcements/TCS.json'].rows.push(filing('TCS', 'new-company-history', '2025-02-01'));
  bodies['/data/announcements-archive/index.json'].updatedAt = '2026-09-04T13:05:00Z';
  bodies['/data/announcements-archive/2025-01.json'].rows = [filing('TCS', 'revised-month-history', '2025-01-03')];
  await page.clock.fastForward(90100);
  await page.waitForFunction(() => window.stream.rows().some(r => r.title === 'TCS announcement revised-month-history') && window.stream.rows().some(r => r.title === 'TCS announcement new-company-history'));
  assert.equal(hits.get('/data/filing-capture/announcements/TCS.json'), afterBseReads + 1);
  assert.equal(hits.get('/data/announcements-archive/2025-01.json'), monthReads + 1);
  assert(await page.evaluate(() => window.stream.rows().some(r => r.title === 'TCS announcement older-bse')));
  console.log('PASS changed archive revisions refresh automatically, including unchanged row counts');
  bodies['/data/filing-capture/nse-identities.json'].directories.sme.entries.push({ isin: 'INE000Z01019', ticker: 'FUTURE', aliases: ['FUTURE-SM'], name: 'Future SME' });
  bodies['/data/filing-capture/announcements-recent.json'].rows.push({ ...filing('FUTURE-SM', 'new-holding'), source: 'NSE' });
  await page.evaluate(() => { window.addFutureHolding(); window.renderScope('portfolio'); });
  await settle();
  await refreshStream();
  await fillSearch('new-holding');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-row-key]').length === 1);
  assert.match(await page.locator('tbody').innerText(), /FUTURE/);
  await rescope('watchlist');
  await fillSearch('new-holding');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0);
  await page.evaluate(() => window.addWatch('FUTURE'));
  await page.waitForFunction(() => window.enrollment.status().remaining.length === 0);
  assert(enrollments.some(batch => batch.tickers.includes('FUTURE')), 'a watchlist addition enrolls without reloading the page');
  await page.evaluate(() => { window.addWatch('539659'); window.renderScope('watchlist'); });
  await settle();
  await fillSearch('KAMATS');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'a watched BSE code shows the issuer’s filings');
  await fillSearch('new-holding');
  await rescope('portfolio');
  console.log('PASS a new portfolio holding and newly published NSE identity join the live feed without a page reload');
  fail = true; await refreshStream();
  assert(await page.evaluate(() => window.stream.rows().some(r => r.title === 'Just arrived')));
  assert(await page.evaluate(() => !!window.stream.meta().nse.degraded));
  await fillSearch('');
  await page.locator('[data-filings-method]').click();
  assert(await page.locator('#modal-content [data-capture-coverage]').isVisible());
  assert.match(await page.locator('#modal-content').innerText(), /live exchange feed|live NSE/i);
  await page.locator('[data-modal-close]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await search.isVisible());
  assert(await period.isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // Date presets narrow source publication dates, including the exact IST boundaries.
  fail = false;
  const periodDates = {
    today: '2026-09-04', third: '2026-09-02', fourth: '2026-09-01',
    seventh: '2026-08-29', eighth: '2026-08-28', priorMonth: '2026-08-31',
    future: '2026-09-05', undated: null, invalid: '2026-02-30',
  };
  for (const [id, date] of Object.entries(periodDates)) bseRows.push(filing('TCS', `Period case ${id}`, date));
  nseRows.push(...[
    ['beforeMidnight', '2026-09-03T18:29:59Z'], ['atMidnight', '2026-09-03T18:30:00Z'],
  ].map(([id, publishedAt]) => ({ ...nseRow, subject: `Period case ${id}`, publishedAt, url: `https://example.test/period-${id}.pdf` })));
  bodies['/data/corp-announcements.json'].byTicker.INFY.push(filing('INFY', 'Period case watched', '2026-09-04'));
  bodies['/data/corp-announcements.json'].capturedAt = await page.evaluate(() => new Date().toISOString());
  await refreshStream();
  await fillSearch('Period case');
  const shownCases = () => page.locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(row => row.textContent.match(/Period case (\w+)/)?.[1]).sort());
  const expectCases = async (value, expected) => {
    await selectPeriod(value);
    assert.deepEqual(await shownCases(), [...expected].sort(), `inclusive IST period ${value}`);
  };
  await expectCases('today', ['today', 'atMidnight']);
  await expectCases('3', ['today', 'third', 'beforeMidnight', 'atMidnight']);
  await expectCases('7', ['today', 'third', 'fourth', 'seventh', 'priorMonth', 'beforeMidnight', 'atMidnight']);
  await expectCases('month', ['today', 'third', 'fourth', 'beforeMidnight', 'atMidnight']);
  await expectCases('all', [...Object.keys(periodDates), 'beforeMidnight', 'atMidnight']);
  await expectCases('today', ['today', 'atMidnight']);
  await page.evaluate(() => {
    window.exportedRows = null;
    window.ExcelJS = { Workbook: class {
      constructor() { this.xlsx = { writeBuffer: async () => new Uint8Array() }; }
      addWorksheet() { const records = []; window.exportedRows = records; return { addRow: row => records.push(row), getRow: () => ({}) }; }
    } };
  });
  await search.press('Escape');
  await page.locator('[data-export]').click();
  await page.waitForFunction(() => Array.isArray(window.exportedRows));
  assert.deepEqual(await page.evaluate(() => exportedRows.slice(1).map(row => row.h.match(/Period case (\w+)/)?.[1]).sort()), ['atMidnight', 'today'], 'export uses the selected period and search');
  await rescope('watchlist');
  assert.equal(await period.inputValue(), 'today');
  assert.deepEqual(await shownCases(), ['watched']);
  await rescope('universe');
  assert.deepEqual(await shownCases(), ['atMidnight', 'today', 'watched']);
  await rescope('portfolio');
  fail = true; await refreshStream();
  assert.equal(await period.inputValue(), 'today');
  assert.deepEqual(await shownCases(), ['atMidnight', 'today'], 'failed refresh preserves the selected period and retained rows');
  fail = false;
  // No new records: advancing the IST day alone must invalidate the unchanged-row paint shortcut.
  await page.clock.setSystemTime(new Date('2026-09-04T18:30:01Z'));
  await page.clock.fastForward(90100);
  await page.waitForFunction(() => document.querySelector('tbody tr[data-row-key]')?.textContent.includes('Period case future'));
  assert.equal(await period.inputValue(), 'today');
  assert.deepEqual(await shownCases(), ['future'], 'Today rolls over on the existing automatic poll');
  assert.equal(await search.inputValue(), 'period case');
  await expectCases('all', [...Object.keys(periodDates), 'beforeMidnight', 'atMidnight']);
  await fillSearch('older-company');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'All time still reaches older captured history');
  console.log('PASS IST time presets, inclusive boundaries, unknown dates, filtered exports, all scopes, failure retention and automatic midnight rollover');

  // The reported case: an exchange code, provider ticker and portfolio name identify one issuer.
  const bharat = { isin: 'INE365Y01019', bseCode: '541096', ticker: 'BPLPHARMA', bseSymbol: 'BPLPHARMA', name: 'Bharat Parenterals Ltd' };
  bodies['/data/announcement-identities.json'].entries.push(bharat);
  bodies['/data/announcement-identities.json'].capturedAt = '2026-09-05T08:00:00Z';
  const bharatFiling = (id, date) => ({ ...filing('541096', id, date), scripCode: '541096', company: bharat.name, category: 'Company Update', subCategory: 'General Updates' });
  bodies['/data/corp-announcements.json'].byTicker['541096'] = [bharatFiling('board outcome', '2026-09-05'), bharatFiling('older history', '2025-01-01')];
  bodies['/data/corp-announcements.json'].capturedAt = '2026-09-05T08:00:00Z';
  bseRows.push({ ...filing('TCS', 'mentions-bharat', '2026-09-05'), title: 'Bharat Parenterals mentioned by another company' });
  await page.clock.fastForward(61000);
  await page.evaluate(async () => {
    const coverage = await import('/js/data/coverage.js');
    coverage.prime({ holdings: [...coverage.holdings(), { isin: 'INE365Y01019', ticker: 'BPLPHARMA', name: 'Bharat Parenteral' }] });
    window.renderScope('portfolio'); await window.stream.refresh();
  });
  await settle();
  assert.equal(await page.evaluate(() => window.stream.companyIdentity({ ticker: 'BPLPHARMA' }).name), bharat.name, 'the updated exchange directory is loaded before company selection');
  await period.selectOption('all');
  await search.fill('Bharat');
  await page.clock.fastForward(300);
  await page.waitForFunction(() => document.querySelector('[data-search-status]')?.textContent === 'Choose a company');
  assert(searches.includes('Bharat'), 'typed names use the existing Worker search endpoint');
  const menu = page.locator('[data-announcement-search-menu]:visible');
  assert.equal(await menu.getByRole('option', { name: /Bharat Parenterals/ }).count(), 1, 'BSE code and symbol suggestions deduplicate by verified issuer');
  assert.equal(await menu.getByRole('option', { name: /Foreign listing|Not a listed symbol/ }).count(), 0);
  assert(await menu.getByRole('option', { name: /Infosys/ }).isDisabled(), 'outside-scope results explain the scope without bypassing it');
  await search.press('ArrowDown'); await search.press('Enter');
  await companySettled(true);
  assert.equal(await search.inputValue(), '');
  assert.match(await page.locator('[data-announcement-company-chip]').innerText(), /Bharat Parenterals.*BPLPHARMA/s);
  assert.match(await page.locator('[data-row-count]').innerText(), /^2 announcements · 1 company with filings$/);
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 2, 'selection shows only the issuer');
  assert.doesNotMatch(await page.locator('tbody').innerText(), /mentioned by another/);
  await fillSearch('older');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'free text narrows the selected company');
  await page.locator('[data-export]').click();
  await page.waitForFunction(() => exportedRows?.[1]?.h?.includes('older history'));
  assert.deepEqual(await page.evaluate(() => exportedRows.slice(1).map(r => r.t)), ['BPLPHARMA']);
  await fillSearch(''); await selectPeriod('today');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'date filter remains effective after selecting a company');
  await selectPeriod('all');
  const recovered = { ...bharatFiling('recovered arrival', '2026-09-05'), providers: ['Screener announcements'] };
  Object.assign(bodies['/data/screener-announcements.json'], { rows: [recovered], rowCount: 1, pending: [{ from: at, to: '2026-09-05T08:01:00Z' }], lastPageAt: '2026-09-05T08:01:00Z' });
  await refreshStream();
  await page.waitForFunction(() => document.querySelector('[data-row-count]')?.textContent.startsWith('3 announcements'));
  assert.match(await page.locator('[data-announcement-company-chip]').innerText(), /Bharat Parenterals/);
  assert(await page.evaluate(() => window.stream.rows().some(r => r.ticker === 'BPLPHARMA' && r.providers.includes('Screener announcements'))), 'recovery joins exact issuer search while BSE capture time stays unchanged');
  failRecovery = true;
  await refreshStream();
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3, 'a failed backup refresh preserves the recovered filing');
  assert(await page.evaluate(() => !!window.stream.meta().recovery.error));
  failRecovery = false;
  await rescope('watchlist');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0);
  assert.match(await page.locator('[data-announcement-search-hint]').innerText(), /outside Watchlist/);
  await rescope('portfolio');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3);
  await page.getByRole('button', { name: 'Clear selected company' }).click();
  await companySettled(false);
  assert.equal(await page.locator('[data-announcement-company-chip]').innerText(), '');
  assert(await page.locator('tbody tr[data-row-key]').count() > 3);
  failSearch = true;
  await search.fill('Parenterals'); await page.clock.fastForward(300);
  await page.waitForFunction(() => document.querySelector('[data-search-status]')?.textContent.includes('unavailable'));
  assert(await menu.getByRole('option', { name: /Bharat Parenterals/ }).isEnabled(), 'saved companies remain selectable during search failures');
  await menu.getByRole('option', { name: /Bharat Parenterals/ }).click();
  await companySettled(true);
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3);
  await page.getByRole('button', { name: 'Clear selected company' }).click();
  await fillSearch('Bharat');
  assert.equal(await menu.count(), 1);
  assert(await page.evaluate(() => {
    const r = document.querySelector('[data-announcement-search-menu]').getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
  }), 'company dropdown fits the mobile viewport');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.ANNOUNCEMENT_SEARCH_SCREENSHOT) {
        await page.screenshot({ path: `${process.env.ANNOUNCEMENT_SEARCH_SCREENSHOT}-${width}-${theme}.png` });
        await menu.getByRole('option', { name: /Bharat Parenterals/ }).click();
        await page.screenshot({ path: `${process.env.ANNOUNCEMENT_SEARCH_SCREENSHOT}-${width}-${theme}-selected.png` });
        await page.getByRole('button', { name: 'Clear selected company' }).click();
        await fillSearch('Bharat');
      }
    }
  }
  await search.press('Escape'); assert.equal(await menu.count(), 0);
  console.log('PASS company dropdown, Worker lookup, BSE identities, exact company selection, filters/export, refresh retention, scope and offline fallback');

  const referenceOnly = { ...filing('TCS', 'Missing attachment notice', '2026-09-05'), url: null,
    referenceUrl: 'https://www.screener.in/company/id/123456/', documentUnavailable: true,
    source: 'Screener', providers: ['Screener announcements'] };
  bodies['/data/screener-announcements.json'].rows.push(referenceOnly);
  bodies['/data/screener-announcements.json'].rowCount++;
  bodies['/data/screener-announcements.json'].lastPageAt = '2026-09-05T08:02:00Z';
  await refreshStream();
  await fillSearch('Missing attachment');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  assert.match(await page.locator('tbody tr[data-row-key]').innerText(), /Source supplied no document link/);
  assert.equal(await page.locator('tbody tr[data-row-key] a[href="https://www.screener.in/company/id/123456/"]').count(), 1);
  await page.locator('[data-export]').click();
  await page.waitForFunction(() => exportedRows?.[1]?.ref === 'https://www.screener.in/company/id/123456/');
  assert.equal(await page.evaluate(() => exportedRows[1].u), '', 'the issuer page is never exported as a document URL');
  console.log('PASS notices without attachments retain explicit source references and honest export fields');

  await page.evaluate(() => window.destroyStream());
  assert.equal(await page.locator('[data-announcement-search-menu]').count(), 0, 'navigation disposes the dropdown');
  const last = hits.get('/api/nse-announcements');
  await page.clock.fastForward(180000);
  assert.equal(hits.get('/api/nse-announcements'), last, 'the poller stops after navigation away');
  assert.deepEqual(errors, []);
  console.log('PASS source failure retention, details on demand, mobile layout and polling cleanup; no browser errors');

  // Prove a returning, controlled session receives the company picker through the release marker.
  legacy = true; failSearch = false;
  const returning = await browser.newPage();
  returning.on('pageerror', error => errors.push(error.message));
  await returning.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await returning.goto(origin);
  await returning.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await returning.waitForFunction(() => !!navigator.serviceWorker.controller);
  await returning.reload(); await returning.locator('[data-table-search]').waitFor();
  assert.equal(await returning.evaluate(() => window.stream.rows().some(r => r.title.includes('recovered arrival'))), false);
  assert.equal(await returning.locator('[data-announcement-search]').count(), 0, 'the previous immutable module still serves plain text search');
  await returning.evaluate(async () => {
    const { watchWorkerChanges } = await import('/js/core/app-updates.js');
    watchWorkerChanges(navigator.serviceWorker, () => location.reload());
  });
  legacy = false;
  await returning.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await returning.locator('[data-announcement-search]').waitFor();
  await returning.evaluate(() => window.renderScope('universe'));
  await returning.locator('[data-table-search]').fill('Bharat');
  await returning.getByRole('option', { name: /Bharat Parenterals/ }).click();
  assert.match(await returning.locator('[data-announcement-company-chip]').innerText(), /Bharat Parenterals/);
  assert((await returning.evaluate(() => caches.keys())).every(key => key.includes('announcement-company-search-v1') && key.includes('announcement-recovery-v1') && key.includes('announcement-search-clarity-v1')));
  assert(await returning.evaluate(() => window.stream.rows().some(r => r.title.includes('recovered arrival'))), 'the returning session adopts the new recovery reader');
  assert.deepEqual(errors, []);
  await returning.close();
  console.log('PASS returning session upgrades its cached filing modules and can select a company without clearing browser storage');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
