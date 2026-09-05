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
const bseRows = Array.from({ length: 140 }, (_, i) => filing('TCS', i));
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
  '/data/filing-capture/announcements-recent.json': { rows: [{ ...filing('TCS', 'meeting'), source: 'NSE', title: 'NSE meeting', time: '17:30:00', url: nseRow.url }] },
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
  assert.equal(await page.locator('[data-capture-coverage], [data-announcement-lookup], [data-load-filing-history], [data-table-filter], [data-watch-toggle], [data-document-tabs]').count(), 0);
  assert.match(await page.locator('[data-row-count]').innerText(), /^146 announcements · 3 companies with filings$/);
  assert.equal(await page.evaluate(() => window.stream.rows().filter(r => r.url === 'https://example.test/nse.pdf').length), 1);
  assert.equal(await page.locator('[data-scroll-paged]').count(), 1);
  console.log('PASS clean portfolio stream, source deduplication and automatic BSE/company/NSE history');
  const search = page.locator('[data-table-search]');
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
  bodies['/data/filing-capture/index.json'].sources.announcements.TCS.lastSuccessAt = '2026-09-04T13:05:00Z';
  bodies['/data/filing-capture/announcements/TCS.json'].rows.push(filing('TCS', 'new-company-history', '2025-02-01'));
  bodies['/data/announcements-archive/index.json'].updatedAt = '2026-09-04T13:05:00Z';
  bodies['/data/announcements-archive/2025-01.json'].rows = [filing('TCS', 'revised-month-history', '2025-01-03')];
  await page.clock.fastForward(90100);
  await page.waitForFunction(() => window.stream.rows().some(r => r.title === 'TCS announcement revised-month-history') && window.stream.rows().some(r => r.title === 'TCS announcement new-company-history'));
  assert.equal(hits.get('/data/filing-capture/announcements/TCS.json'), companyReads + 1);
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
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.destroyStream());
  const last = hits.get('/api/nse-announcements');
  await page.clock.fastForward(180000);
  assert.equal(hits.get('/api/nse-announcements'), last, 'the poller stops after navigation away');
  assert.deepEqual(errors, []);
  console.log('PASS source failure retention, details on demand, mobile layout and polling cleanup; no browser errors');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
