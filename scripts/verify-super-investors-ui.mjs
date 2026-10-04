// Real browser and device cache; local fixtures only, no production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePortfolio } from '../public/js/data/finology-shared.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const at = '2026-09-06T00:00:00Z';
const h = (company, companySlug, latest, prior, valueCr = 10) => ({ company, companySlug,
  quarterlyHoldings: { 'Aug 2026': 'Filing Due', 'Jun 2026': latest, 'Mar 2026': prior }, valueCr });
const b = (slug, holdings) => ({ ...normalisePortfolio({ name: slug, slug, quarters: ['Aug 2026', 'Jun 2026', 'Mar 2026'], holdings }, slug), ok: true, fetchedAt: at });
let fail = false, publicFail = false, publicReads = 0;
const books = {
  one: b('one', [h('Aavas Financiers Ltd.', 'AAVAS', 2.13, 1.65), h('Portfolio Only Ltd.', 'ONLY', 1.2, 1), h('Pending Ltd.', 'PENDING', 'Filing Due', 1, 0)]),
  two: b('two', [h('Aavas Financiers Limited', 'AAVAS', 1.1, null), h('Portfolio Only Other Ltd.', 'OTHER', 1.5, 1)]),
  old: { ...b('old', []), quarters: ['Jun 2025', 'Mar 2025'] },
};
const investors = [...Object.keys(books), 'missing'].map(slug => ({ slug, name: slug }));
const snapshot = { capturedAt: at, investors, books };
const trade = (ticker, person, side = 'Buy', exchange = 'NSE') => ({ ticker, sourceId: `${exchange.toLowerCase()}-bulk`, date: '2026-09-05', url: 'https://www.screener.in/trades/bulk/', cells: { Company: ticker === 'ONLY' ? 'Portfolio Only Ltd.' : 'Aavas Financiers Ltd.', Insider: person, Transaction: side, 'Trade Category': 'Bulk deal', 'Trade Shares': '1000', Price: '50', Exchange: exchange } });
const trades = { kind: 'insider', capturedAt: at, coversUniverse: true, byTicker: { ONLY: [trade('ONLY', 'one'), trade('ONLY', 'one'), trade('ONLY', 'one', 'Sell'), trade('ONLY', 'one', 'Buy', 'BSE')], AAVAS: [trade('AAVAS', 'two'), trade('AAVAS', 'one and others')] }, empty: [], failed: {} };
const publicRow = (id, company, isin) => ({ id, personId: 'one', person: 'one', kind: 'investor', company, isin, legalHolder: 'one', asOf: '2026-06-30', shares: 1000, stakePct: 1.2, state: 'latest-disclosure', comparison: 'agrees', sources: [{ source: 'bse', url: 'https://www.bseindia.com/example.xml', filedAt: at, checkedAt: at, shares: 1000, stakePct: 1.2 }] });
let publicPayload = { version: 1, checkedAt: at, captureCheckedAt: at, complete: false, holdings: [publicRow('one-only', 'Portfolio Only Ltd.', 'INE000A01001'), publicRow('one-aavas', 'Aavas Financiers Ltd.', 'INE000A01002')], issues: [], candidates: [], profiles: [], sources: [], coverage: { indexed: 2, parsed: 2, pending: 0, partial: 0, securities: 2, profiles: 1 } };
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css">
<body class="bg-slate-50"><main id="test-root" class="mx-auto max-w-7xl p-4"></main>
<div id="modal-overlay" class="hidden fixed inset-0 z-50 overflow-y-auto bg-slate-900/30 p-4"><div id="modal-container"><div id="modal-content"></div></div></div>
<div id="workspace-overlay" class="hidden fixed inset-0 z-40 bg-slate-900/30 p-4"><div id="workspace-container"><div id="workspace-content"></div></div></div>
<script type="module">
import * as feed from '/js/data/super-investors.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import { renderLive, openInvestor } from '/js/investors/live.js';
coverage.prime({ holdings: [{ ticker: 'ONLY', name: 'Portfolio Only' }] });
let disposers = [], scope = 'portfolio', section = 'quarterly-changes', changesView = { period: 'quarter' }; window.openInvestor = openInvestor;
window.paint = (nextScope = scope, nextSection = section) => {
  scope = nextScope; section = nextSection;
  disposers.forEach(fn => fn()); disposers = [];
  renderLive({ root: document.querySelector('#test-root'), scope }, { disposers, section, changesView, onChangesView: (v) => changesView = v });
};
window.addEventListener('hashchange', () => paint(new URLSearchParams(location.hash.split('?')[1]).get('scope') || 'portfolio'));
feed.onChange(() => paint());
await feed.load(); paint(); window.testSI = { feed, watchlist };
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/data/public-holdings.json') { publicReads++; if (publicFail) res.statusCode = 503; return json(publicFail ? {} : publicPayload); }
  if (path === '/data/holding-evidence.json') return json({ relations: [], holdings: [] });
  if (path === '/data/insider-trades.json') return json(trades);
  if (path === '/data/exchange-deals.json' || path.startsWith('/api/exchange-deals')) return json({ version: 1, records: [], sources: [], checkedAt: at });
  if (path === '/data/super-investors.json') return json(snapshot);
  if (path === '/api/super-investors') return json({ ok: true, investors, fetchedAt: at });
  if (path.startsWith('/api/super-investors/')) return json(fail ? { ok: false, reason: 'fixture outage' } : books[path.split('/').at(-1)] || { ok: false, reason: 'missing fixture' });
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'text/plain'); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin + '/#/research/super-investors?scope=portfolio');
  await page.waitForFunction(() => window.testSI && !window.testSI.feed.meta().confirming);
  await page.waitForSelector('[data-changes-ready="true"]');
  assert.doesNotMatch(await page.locator('[data-si-freshness]').innerText(), /up to date/i, 'an incomplete source never claims complete freshness');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'), '3', 'scope excludes another company; duplicate reports group but exchange and side stay separate');
  await page.locator('[data-changes-period]').selectOption('6m');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-holdings-total'), '1', 'only the scoped confirmed change appears');
  await page.locator('[data-changes-holdings] summary').click();
  assert.match(await page.locator('[data-changes-observations]').innerText(), /31 Mar 2026|Mar 31, 2026|31\/03\/2026/);
  assert.match(await page.locator('[data-changes-observations]').innerText(), /30 Jun 2026|Jun 30, 2026|30\/06\/2026/);
  assert.match(await page.locator('[data-changes-holdings]').innerText(), /not trade dates/);
  await page.evaluate(() => paint('universe'));
  await page.waitForSelector('[data-changes-ready="true"]');
  assert.equal(await page.locator('[data-changes-period]').inputValue(), '6m', 'period survives scope and source repaint');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'), '4', 'ambiguous substring name is excluded');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-holdings-total'), '3', 'unknown prior stake is not a newly bought holding');
  await page.locator('[data-changes-activity] [data-row-key]').first().click();
  assert.match(await page.locator('#modal-content').innerText(), /Trade Shares|Trade Category/);
  assert(await page.locator('#modal-content a[href^="https://www.screener.in/"]').count() > 0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => paint('watchlist'));
  await page.waitForSelector('[data-changes-ready="true"]');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'), '0');
  await page.evaluate(() => { testSI.watchlist.add('PENDING', 'Pending'); paint('watchlist', 'data-table'); });
  assert.match(await page.locator('#test-root').innerText(), /Filing due|Incomplete data/i);
  assert.doesNotMatch(await page.locator('#test-root').innerText(), /Undisclosed/);
  await page.evaluate(() => paint('portfolio', 'quarterly-changes'));
  if (process.env.SI_SCREENSHOT) await page.screenshot({ path: process.env.SI_SCREENSHOT, fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no page overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => openInvestor('one'));
  await page.locator('[data-ws-tab="exchange"]').click();
  await page.locator('[data-public-search]').fill('Portfolio Only');
  assert.equal(await page.locator('[data-public-row]:visible').count(), 1);
  assert.equal(await page.locator('[data-public-row]:visible a[href="https://www.bseindia.com/example.xml"]').count(), 1);
  await page.evaluate(() => {
    window.exportedEvidence = [];
    window.ExcelJS = { Workbook: class { constructor() { this.xlsx = { writeBuffer: async () => new Uint8Array([1]) }; } addWorksheet() { return { addRow: (r) => window.exportedEvidence.push(r), getRow: () => ({}) }; } } };
  });
  await page.locator('[data-public-export]').click();
  await page.waitForFunction(() => window.exportedEvidence.length > 0);
  assert.equal(await page.evaluate(() => window.exportedEvidence.length), 1, 'export uses exactly the searched disclosure rows');
  assert.equal(await page.evaluate(() => window.exportedEvidence[0]['Filing URL']), 'https://www.bseindia.com/example.xml');
  publicPayload = structuredClone(publicPayload);
  publicPayload.checkedAt = '2026-09-06T00:06:00Z';
  publicPayload.holdings.push({ ...publicPayload.holdings[0], id: 'later-only', asOf: '2026-08-31', shares: 1500 });
  const readsBefore = publicReads;
  await page.clock.fastForward(360000);
  await page.waitForFunction(() => document.querySelectorAll('[data-public-row]:not([hidden])').length === 2);
  assert(publicReads > readsBefore, 'original evidence refreshes while visible');
  assert.equal(await page.locator('[data-public-search]').inputValue(), 'Portfolio Only', 'source arrival retains search');
  publicFail = true;
  await page.clock.fastForward(360000);
  await page.waitForFunction(() => document.querySelector('[data-public-disclosures]')?.textContent.includes('Latest check failed'));
  assert.equal(await page.locator('[data-public-row]:visible').count(), 2, 'outage retains original evidence');
  await page.keyboard.press('Escape');
  await page.evaluate(() => testSI.feed.refresh());
  fail = true;
  await page.evaluate(() => testSI.feed.refresh());
  assert.equal(await page.evaluate(async () => (await (await import('/js/core/store.js')).readEntry('investor:one')).value.ok), true, 'failed response cannot poison the device cache');
  assert.equal(await page.evaluate(() => testSI.feed.books().length), 3, 'failed refresh retains evidence');

  // A FAILED RE-CHECK MUST NOT BE PAINTED OVER THE BOOK IT FAILED TO RE-CHECK.
  //
  // Three books are retained and one investor genuinely has none. The counts must split the same
  // way, and the cards must show the figures they hold: the shipped bug printed "This book could
  // not be read" on all ninety cards, directly under each card's own "as of Jun 2026" line, while
  // every book sat in memory. Counting rows would never have caught it — compare what is DRAWN
  // against what the feed HOLDS.
  assert.equal(await page.evaluate(() => testSI.feed.meta().failedBooks), 1, 'only a book with no copy at all counts as failed');
  assert.equal(await page.evaluate(() => testSI.feed.meta().uncheckedBooks), 3, 'retained books whose re-check failed are counted apart');
  assert.deepEqual(await page.evaluate(() => testSI.feed.list().filter((i) => testSI.feed.failureFor(i.slug)).map((i) => i.slug)), ['missing'],
    'failureFor reports a gap, never a retained book');
  await page.evaluate(() => paint('universe', 'investors'));
  assert.equal(await page.locator('[data-open-investor]:has-text("could not be read")').count(), 0, 'no failure notice over a retained book');
  assert.equal(await page.locator('[data-open-investor]:has-text("quarter disclosures")').count(), 3, 'every retained book still shows its figures during an outage');
  assert.equal(await page.locator('[data-open-investor]:has-text("No book published")').count(), 1, 'an investor with no book still says so');

  // The amber block and the raw upstream error string are out of the chrome — and NOT deleted:
  // the age is on the page and the mechanism is behind the panel's own provenance door.
  assert.equal(await page.locator('#test-root .bg-amber-50').count(), 0, 'no amber caveat block over real filed holdings');
  assert.doesNotMatch(await page.locator('#test-root').innerText(), /Showing the last good read|fixture outage|book reads failed/,
    'internal retry states stay out of customer chrome');
  await page.evaluate(() => paint('universe', 'quarterly-changes'));
  assert.match(await page.locator('[data-si-freshness]').first().innerText(), /Ticker Finology · partial · read /, 'one quiet freshness label states the age');
  await page.locator('[data-summary-help]').click();
  assert.match(await page.locator('#modal-content').innerText(), /could not be re-checked just now/, 'the provenance modal still carries what the chrome stopped printing');
  await page.keyboard.press('Escape');

  fail = false;
  await page.evaluate(() => testSI.feed.refresh());
  assert.equal(await page.evaluate(() => testSI.feed.meta().failedBooks), 1, 'successful retry clears retained-book failures');
  assert.equal(await page.evaluate(() => testSI.feed.meta().uncheckedBooks), 0, 'a successful re-check clears the retained mark');
  await page.evaluate(() => paint('portfolio', 'quarterly-changes'));
  await page.reload();
  await page.waitForFunction(() => !!window.testSI);
  assert.equal(await page.evaluate(() => testSI.feed.books().length), 3, 'repeat visit restores validated device books');
  assert.equal(await page.evaluate(() => testSI.feed.book('one').holdings.find(h => h.companySlug === 'PENDING').quarterlyNotes['Jun 2026']), 'Filing Due');
  books.one.holdings.find(h => h.companySlug === 'ONLY').quarterlyHoldings['Jun 2026'] = 1.8;
  await page.clock.setSystemTime(new Date(Date.parse(at) + 7 * 3600000));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !testSI.feed.meta().confirming &&
    testSI.feed.book('one').holdings.find(h => h.companySlug === 'ONLY').quarterlyHoldings['Jun 2026'] === 1.8);
  await page.waitForSelector('[data-changes-ready="true"]');
  await page.locator('[data-changes-period]').selectOption('6m');
  await page.locator('[data-changes-holdings]').evaluate(el => el.open = true);
  // The source event may schedule a replacement table after the corrected book is in memory.
  await page.waitForFunction(() => document.querySelector('[data-changes-observations]')?.textContent.includes('0.80 pp'));
  assert.match(await page.locator('[data-changes-observations]').innerText(), /0.80 pp/, 'resume automatically picks up late corrections');
  await page.evaluate(() => {
    const b = testSI.feed.book('one');
    b.quarters.unshift('Sep 2026');
    b.holdings.find(h => h.companySlug === 'ONLY').quarterlyHoldings['Sep 2026'] = 2.4;
    // Populate the memo before the calendar boundary, without a new network payload.
    testSI.feed.allMoves();
  });
  await page.clock.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  assert.equal(await page.evaluate(() => testSI.feed.allMoves().find(m => m.companySlug === 'ONLY').latest), 'Sep 2026', 'quarter rollover invalidates derived cache');
  assert.deepEqual(errors, []);
  console.log('PASS investor scope, identity, disclosure notes, shared changes, drill evidence, missing books, outages and mobile layout');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
