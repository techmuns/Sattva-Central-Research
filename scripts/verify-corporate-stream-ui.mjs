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
const bodies = {
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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>#modal-overlay.is-open #modal-container{opacity:1}</style><link rel="stylesheet" href="/css/tailwind.css"></head><body class="bg-slate-50 p-4"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/corp-announcements.js';
import * as live from '/js/core/live.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import {corporateAnnouncements as feed} from '/js/data/corporate-announcements.js';
import {startWatchlistCapture,watchlistCapture} from '/js/data/watchlist-capture.js';
coverage.prime({holdings:[{ticker:'TCS',name:'TCS Test Company'}, {isin:'INE564S01019',ticker:null,name:'Vikram Kamats Hospitality'}, {isin:'INE094B01013',ticker:null,name:'Ashika Credit Capital'}]}); watchlist.add('INFY','INFY Test Company');
window.renderScope=(scope)=>{const root=document.querySelector('#root');root.innerHTML='';tab.render({root,scope,live,data:{universe:[{ticker:'TCS'},{ticker:'INFY'}]},params:{}});};
window.stream=feed;window.destroyStream=()=>tab.destroy();window.renderScope('portfolio');
window.addFutureHolding=()=>coverage.prime({holdings:[...coverage.holdings(),{isin:'INE000Z01019',ticker:null,name:'Future SME'}]});
window.addWatch=watchlist.add;window.enrollment=watchlistCapture;startWatchlistCapture();
</script></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  hits.set(path, (hits.get(path) || 0) + 1);
  res.setHeader('cache-control', 'no-store');
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
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
  if (bodies[path]) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(bodies[path])); return; }
  if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
  try {
    const file = resolve(root, `.${path}`); assert(file.startsWith(root + sep));
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 200, body: '{}' }));
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin);
  await page.waitForFunction(() => window.stream?.meta().archive?.loaded && window.stream.rows().some(r => r.title === 'Historical NSE filing'));
  await page.waitForFunction(() => window.enrollment.status().remaining.length === 0);
  assert.deepEqual(enrollments, [{ tickers: ['INFY'] }], 'existing watchlist enrolls automatically without sending its names or membership metadata');
  assert.equal(await page.locator('[data-capture-coverage], [data-announcement-lookup], [data-load-filing-history], [data-watch-toggle], [data-document-tabs]').count(), 0);
  const period = page.getByRole('combobox', { name: 'Announcement period (IST)' });
  assert.equal(await period.inputValue(), 'all');
  assert.deepEqual(await period.locator('option').allTextContents(), ['Today', 'Last 3 days', 'Last 7 days', 'This month', 'All time']);
  assert.match(await page.locator('[data-row-count]').innerText(), /^146 announcements · 3 companies with filings$/);
  assert.equal(await page.evaluate(() => window.stream.rows().filter(r => r.url === 'https://example.test/nse.pdf').length), 1);
  const search = page.locator('[data-table-search]');
  await search.fill('cross-exchange');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'byte-identical BSE/NSE rows render once');
  assert.match(await page.locator('tbody tr[data-row-key]').innerText(), /BSE \/ NSE/);
  assert.deepEqual(await page.evaluate(() => window.stream.rows().find(r => r.documentHash)?.sourceUrls), [
    { source: 'BSE', url: 'https://example.test/TCS/cross-exchange.pdf' },
    { source: 'NSE', url: 'https://nsearchives.nseindia.com/corporate/cross-exchange.pdf' },
  ]);
  await search.fill('');
  assert(await page.locator('tbody tr[data-row-key]').count() <= 160, 'table DOM stays bounded');
  console.log('PASS clean portfolio stream, source deduplication and automatic BSE/company/NSE history');
  await search.fill('KAMATS');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'BSE-only holding matches by ISIN');
  await search.fill('ASHIKAG');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'renamed company matches the old book name through ISIN');
  await search.fill('older-company');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  await search.evaluate(el => { window.activeSearch = el; });
  await page.evaluate(() => window.stream.refresh());
  assert.equal(await search.inputValue(), 'older-company');
  assert(await search.evaluate(el => el === document.activeElement));
  assert(await search.evaluate(el => el === window.activeSearch), 'status-only updates preserve the mounted search field');
  assert.equal(hits.get('/data/filing-capture/announcements/TCS.json'), 1);
  assert.equal(hits.get('/data/announcements-archive/2025-01.json'), 1);
  console.log('PASS history is searchable, polling skips unchanged archives, and search focus survives updates');
  await search.fill('');
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
  await search.fill('Just arrived'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  console.log('PASS automatic arrivals preserve the reading position and join search immediately');
  await search.fill('');
  await page.evaluate(() => window.renderScope('watchlist'));
  assert.match(await page.locator('[data-row-count]').innerText(), /^1 announcement · 1 company with filings$/);
  await page.evaluate(() => window.renderScope('universe'));
  assert(await page.evaluate(() => window.stream.rows().some(r => r.company === 'Unresolved Company')));
  await search.fill('Unresolved Company'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1);
  await page.evaluate(() => window.renderScope('portfolio'));
  await search.fill('Unresolved Company'); assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0);
  console.log('PASS portfolio/watchlist/universe isolation, including unresolved exchange identities');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = hits.get('/api/nse-announcements');
  await page.clock.fastForward(180000);
  assert.equal(hits.get('/api/nse-announcements'), hiddenReads);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => !window.stream.meta().archive.pending);
  await page.evaluate(() => window.stream.refresh());
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
  await page.evaluate(() => window.stream.refresh());
  await search.fill('new-holding');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-row-key]').length === 1);
  assert.match(await page.locator('tbody').innerText(), /FUTURE/);
  await page.evaluate(() => window.renderScope('watchlist'));
  await search.fill('new-holding');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 0);
  await page.evaluate(() => window.addWatch('FUTURE'));
  await page.waitForFunction(() => window.enrollment.status().remaining.length === 0);
  assert(enrollments.some(batch => batch.tickers.includes('FUTURE')), 'a watchlist addition enrolls without reloading the page');
  await page.evaluate(() => { window.addWatch('539659'); window.renderScope('watchlist'); });
  await search.fill('KAMATS');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'a watched BSE code shows the issuer’s filings');
  await search.fill('new-holding');
  await page.evaluate(() => window.renderScope('portfolio'));
  console.log('PASS a new portfolio holding and newly published NSE identity join the live feed without a page reload');
  fail = true; await page.evaluate(() => window.stream.refresh());
  assert(await page.evaluate(() => window.stream.rows().some(r => r.title === 'Just arrived')));
  assert(await page.evaluate(() => !!window.stream.meta().nse.degraded));
  await search.fill('');
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
  await page.evaluate(() => window.stream.refresh());
  await search.fill('Period case');
  const shownCases = () => page.locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(row => row.textContent.match(/Period case (\w+)/)?.[1]).sort());
  const expectCases = async (value, expected) => {
    await period.selectOption(value);
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
  await page.locator('[data-export]').click();
  await page.waitForFunction(() => Array.isArray(window.exportedRows));
  assert.deepEqual(await page.evaluate(() => exportedRows.slice(1).map(row => row.h.match(/Period case (\w+)/)?.[1]).sort()), ['atMidnight', 'today'], 'export uses the selected period and search');
  await page.evaluate(() => window.renderScope('watchlist'));
  assert.equal(await period.inputValue(), 'today');
  assert.deepEqual(await shownCases(), ['watched']);
  await page.evaluate(() => window.renderScope('universe'));
  assert.deepEqual(await shownCases(), ['atMidnight', 'today', 'watched']);
  await page.evaluate(() => window.renderScope('portfolio'));
  fail = true; await page.evaluate(() => window.stream.refresh());
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
  await search.fill('older-company');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 1, 'All time still reaches older captured history');
  console.log('PASS IST time presets, inclusive boundaries, unknown dates, filtered exports, all scopes, failure retention and automatic midnight rollover');

  await page.evaluate(() => window.destroyStream());
  const last = hits.get('/api/nse-announcements');
  await page.clock.fastForward(180000);
  assert.equal(hits.get('/api/nse-announcements'), last, 'the poller stops after navigation away');
  assert.deepEqual(errors, []);
  console.log('PASS source failure retention, details on demand, mobile layout and polling cleanup; no browser errors');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
