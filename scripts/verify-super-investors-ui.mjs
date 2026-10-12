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
let holdPublic = null;
const books = {
  one: b('one', [h('Aavas Financiers Ltd.', 'AAVAS', 2.13, 1.65), h('Portfolio Only Ltd.', 'ONLY', 1.2, 1), h('Pending Ltd.', 'PENDING', 'Filing Due', 1, 0)]),
  two: b('two', [h('Aavas Financiers Limited', 'AAVAS', 1.1, null), h('Portfolio Only Other Ltd.', 'OTHER', 1.5, 1)]),
  old: { ...b('old', []), quarters: ['Jun 2025', 'Mar 2025'] },
};
const investors = [...Object.keys(books), 'missing'].map(slug => ({ slug, name: slug }));
const snapshot = { capturedAt: at, investors, books };
const managerFixture = { version: 1, valuation: 'workbook', bookAsOf: '2026-08-31', listedValuationAt: '2026-09-04', listedValuationBasis: 'stated', checkedAt: at, archiveVersion: 1, sourceRevision: 'fixture-book',
  privateWorkbook: { source: 'fixture.xlsx', received: '2026-09-02', saved: null }, coverage: { transactionAsOf: '2026-08-31', sourceCount: 6, privateCount: 1, note: 'Fixture custodians, retained ledger events and private funds; no PMS statement return series.' },
  managers: [{ id: 'custodian-example', name: 'Example Custodian', kind: 'custodian', asOf: '2026-08-31',
    values: { marketValue: 1000, costBasis: 800, unrealised: 200, cashValue: 0, positionCount: 2 },
    positions: [{ isin: 'INE000A01001', security: 'Portfolio Only Ltd.', ticker: 'ONLY', assetClass: 'Equity', quantity: 10, marketValue: 500, costBasis: 400, weightPct: 50 }, { isin: 'INF000000001', security: 'Example ETF', ticker: null, assetClass: 'ETF', quantity: 10, marketValue: 500, costBasis: 400, weightPct: 50 }],
    transactions: [1, 2].map(i => ({ id: `ledger-${i}`, date: '2026-09-05', dateSheet: i === 2 ? '2026-03-31' : null, security: 'Portfolio Only Ltd.', isin: 'INE000A01001', ticker: 'ONLY', side: i === 1 ? 'buy' : 'sell', quantity: 10, amount: i === 1 ? 0 : 500, unitPrice: i === 1 ? 0 : 50, transfer: i === 2 })) },
  { id: 'fund-example-1', name: 'Example Private Fund', kind: 'fund', asOf: null, positions: [], transactions: [], values: { marketValue: 200, costBasis: null, unrealised: null, cashValue: null, positionCount: 1 },
    capital: { committed: 100, drawn: 120, distributed: 20, currentValue: 200, tvpi: 220 / 120, dpi: 20 / 120, firstInvest: '2020-01-01' } }] };
const trade = (ticker, person, side = 'Buy', exchange = 'NSE') => ({ ticker, sourceId: `${exchange.toLowerCase()}-bulk`, date: '2026-09-05', url: 'https://www.screener.in/trades/bulk/', cells: { Company: ticker === 'ONLY' ? 'Portfolio Only Ltd.' : 'Aavas Financiers Ltd.', Insider: person, Transaction: side, 'Trade Category': 'Bulk deal', 'Trade Shares': '1000', Price: '50', Exchange: exchange } });
const trades = { kind: 'insider', capturedAt: at, coversUniverse: true, byTicker: { ONLY: [trade('ONLY', 'one'), trade('ONLY', 'one'), trade('ONLY', 'one', 'Sell'), trade('ONLY', 'one', 'Buy', 'BSE')], AAVAS: [trade('AAVAS', 'two'), trade('AAVAS', 'one and others')] }, empty: [], failed: {} };
const publicRow = (id, company, isin) => ({ id, personId: 'one', person: 'one', kind: 'investor', company, isin, legalHolder: 'one', asOf: '2026-06-30', shares: 1000, stakePct: 1.2, state: 'latest-disclosure', comparison: 'agrees', sources: [{ source: 'bse', url: 'https://www.bseindia.com/example.xml', filedAt: at, checkedAt: at, shares: 1000, stakePct: 1.2 }] });
let publicPayload = { version: 1, checkedAt: at, captureCheckedAt: at, complete: false, holdings: [publicRow('one-only', 'Portfolio Only Ltd.', 'INE000A01001'), publicRow('one-aavas', 'Aavas Financiers Ltd.', 'INE000A01002')], issues: [], candidates: [], profiles: [], sources: [], coverage: { indexed: 2, parsed: 2, pending: 0, partial: 0, securities: 2, profiles: 1 } };
const inlineStyles = readFileSync(resolve(root, 'index.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/g).join('\n');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">${inlineStyles}
<body class="bg-slate-50"><main id="test-root" class="mx-auto max-w-7xl p-4"></main>
<div id="modal-overlay" class="hidden fixed inset-0 z-50 overflow-y-auto bg-slate-900/30 p-4"><div id="modal-container"><div id="modal-content"></div></div></div>
<div id="workspace-overlay" class="fixed inset-0 z-[55] hidden items-start justify-center overflow-y-auto bg-slate-900/70 p-0 sm:p-6"><div id="workspace-container" class="relative w-full max-w-[1200px] translate-y-4 scale-[0.98] overflow-hidden rounded-none bg-white opacity-0 shadow-2xl transition-all duration-200 sm:my-4 sm:rounded-3xl"><div id="workspace-content"></div></div></div>
<script type="module">
import * as feed from '/js/data/super-investors.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import { renderLive, openInvestor } from '/js/investors/live.js';
coverage.prime({ holdings: [{ ticker: 'ONLY', name: 'Portfolio Only' }] });
let disposers = [], scope = 'portfolio', section = 'quarterly-changes', changesView = { audience: 'investors', period: 'quarter' }, managersView = {}; window.openInvestor = openInvestor;
window.paint = (nextScope = scope, nextSection = section) => {
  scope = nextScope; section = nextSection;
  disposers.forEach(fn => fn()); disposers = [];
  renderLive({ root: document.querySelector('#test-root'), scope }, { disposers, section, changesView, onChangesView: (v) => changesView = v, managersView, onManagersView: v => managersView = v });
};
window.addEventListener('hashchange', () => paint(new URLSearchParams(location.hash.split('?')[1]).get('scope') || 'portfolio'));
feed.onChange(() => paint());
await feed.load(); paint(); window.testSI = { feed, watchlist };
</script>`;
const dispatcherHtml = html.replace(/<script type="module">[\s\S]*?<\/script>/, `<script type="module">
  import * as tab from '/js/tabs/super-investors.js';
  import * as coverage from '/js/data/coverage.js';
  coverage.prime({ holdings: [{ticker:'ONLY',name:'Portfolio Only'}] });
  let scope = 'portfolio';
  window.paint = next => { scope = next || scope; tab.render({root:document.querySelector('#test-root'),scope,subview:'superstar-investors',params:{}}); };
  paint(); window.testDispatcher = tab;
</script>`);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/dispatcher') { res.setHeader('content-type', 'text/html'); res.end(dispatcherHtml); return; }
  if (path === '/data/public-holdings.json') { publicReads++; if (publicFail) res.statusCode = 503; return json(publicFail ? {} : publicPayload); }
  if (path === '/data/holding-evidence.json') return json({ relations: [], holdings: [] });
  if (path === '/data/insider-trades.json') return json(trades);
  if (path === '/data/exchange-deals.json' || path.startsWith('/api/exchange-deals')) return json({ version: 1, records: [], sources: [], checkedAt: at });
  if (path === '/data/super-investors.json') { if (holdPublic) await holdPublic; return json(snapshot); }
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
  const fixtureRoute = route => {
    if (route.request().url() === 'https://sattva-family.pages.dev/research-bridge') return route.fulfill({ contentType: 'text/html', body: `<script>
      window.fixture = ${JSON.stringify(managerFixture)};
      const send = m => parent.postMessage({channel:'sattva-portfolio-v1', ...m}, ${JSON.stringify(origin)});
      window.send = send;
      addEventListener('message', e => { if(e.origin !== ${JSON.stringify(origin)} || e.source !== parent || e.data.channel !== 'sattva-portfolio-v1') return;
        const m=e.data; if(m.type==='hello') send({id:m.id,type:'ready',capabilities:['manager-workbook']});
        if(m.type==='managers') send({id:m.id,type:'result',managers:{...fixture,checkedAt:new Date().toISOString()}});
      }); send({type:'available'});
    </script>` });
    return route.request().url().startsWith(origin + '/') ? route.continue() : route.abort();
  };
  await context.route('**/*', fixtureRoute);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin + '/#/research/super-investors?scope=portfolio');
  await page.waitForFunction(() => window.testSI && !window.testSI.feed.meta().confirming);
  await page.waitForSelector('[data-changes-ready="true"]');
  for (const section of ['investors', 'data-table', 'quarterly-changes']) {
    await page.evaluate(section => paint('portfolio', section), section);
    assert.equal(await page.locator('[data-si-freshness], [data-summary-help]').count(), 0, `${section} omits the source-status chip and derivation control`);
  }
  await page.waitForSelector('[data-changes-ready="true"]');
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

  // Operational details stay out of the customer heading, including during an outage.
  assert.equal(await page.locator('#test-root .bg-amber-50').count(), 0, 'no amber caveat block over real filed holdings');
  assert.doesNotMatch(await page.locator('#test-root').innerText(), /Showing the last good read|fixture outage|book reads failed/,
    'internal retry states stay out of customer chrome');
  await page.evaluate(() => paint('universe', 'quarterly-changes'));
  assert.equal(await page.locator('[data-si-freshness], [data-summary-help]').count(), 0, 'failed source checks do not restore the removed heading details');
  const source = await page.evaluate(async () => (await import('/js/ui/sources.js')).sourceGroups().flatMap(g => g.items)
    .find(item => item.name === 'Ticker Finology — superstar investors'));
  assert.equal(source.readState, 'partial', 'Sources still exposes incomplete coverage during an outage');
  assert.match(source.cadence, /3 of 4 tracked books available · 1 unavailable · 3 retained books could not be re-checked/);
  assert.match(source.cadence, /Oldest source check: 2026-09-06T00:00:00.000Z/, 'Sources retains the actual check time');

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
  await page.evaluate(() => paint('portfolio', 'my-managers'));
  await page.waitForSelector('[data-open-manager="custodian-example"]');
  assert.equal(await page.locator('[data-open-manager]').count(), 3);
  assert.equal(await page.locator('[data-si-freshness], [data-summary-help]').count(), 0, 'manager view preserves heading cleanup');
  await page.locator('[data-manager-search]').fill('private');
  assert.equal(await page.locator('[data-open-manager]').count(), 1);
  assert.equal(await page.locator('[data-manager-kind]:visible').count(), 1, 'search hides unrelated empty categories');
  await page.locator('[data-manager-sources] summary').click();
  assert.deepEqual(await page.evaluate(() => {
    const input = document.querySelector('[data-manager-search]'); input.focus(); input.setSelectionRange(2, 4);
    input.setRangeText('i', 2, 4, 'end'); input.dispatchEvent(new Event('input', { bubbles:true }));
    const current = document.querySelector('[data-manager-search]');
    return { same: input === current, start: current.selectionStart, end: current.selectionEnd };
  }), { same: true, start: 3, end: 3 }, 'filtering retains the composing input node and edited caret');
  await page.locator('[data-manager-search]').fill('private');
  await page.locator('[data-manager-search]').evaluate(el => el.setSelectionRange(2, 4));
  await page.evaluate(async () => (await import('/js/data/managers.js')).load({ force:true }));
  assert.deepEqual(await page.locator('[data-manager-search]').evaluate(el => [el.selectionStart, el.selectionEnd, el === document.activeElement]), [2, 4, true], 'fresh workbook retains focus and selection');
  assert(await page.locator('[data-manager-sources]').evaluate(el => el.open), 'source refresh retains expanded coverage');
  await page.evaluate(() => paint('universe'));
  assert.equal(await page.locator('[data-manager-search]').inputValue(), 'private', 'scope repaint retains manager query');
  assert(await page.locator('[data-manager-sources]').evaluate(el => el.open));
  await page.locator('[data-manager-search]').fill('nothing matches');
  assert.equal(await page.locator('[data-manager-empty]').count(), 1, 'one helpful empty result replaces three empty grids');
  await page.locator('[data-manager-search]').fill('');
  if (process.env.SI_QA_DIR) await page.screenshot({ path: `${process.env.SI_QA_DIR}/managers-light.png`, fullPage: true });
  await page.locator('[data-open-manager="custodian-example"]').click();
  assert.equal(await page.locator('#workspace-content [data-bookmark-key]').count(), 0, 'private holdings cannot be saved to the public notebook');
  assert.equal(await page.locator('#workspace-content [data-row-key]').count(), 2);
  await page.locator('[data-ws-tab="trades"]').click();
  assert.equal(await page.locator('#workspace-content [data-row-key]').count(), 2, 'distinct ledger lots survive');
  assert.match(await page.locator('#workspace-content').innerText(), /Earliest ledger sighting/);
  await page.locator('[data-ws-tab="period"]').click();
  assert.equal(await page.locator('[data-ws-tab][tabindex="0"]').count(), 1, 'workspace has one tab stop');
  await page.locator('[data-ws-tab="period"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.wsTab), 'trades');
  assert.equal(await page.locator('[data-ws-tab="period"]').getAttribute('aria-selected'), 'true', 'arrows move focus before activation');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-ws-tab="trades"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-ws-tab="profile"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await page.locator('[data-ws-tab="period"]').click();
  await page.locator('[data-manager-period]').selectOption('itd');
  assert.equal(await page.locator('#workspace-content [data-row-key]').count(), 2);
  await page.keyboard.press('Escape');
  await page.locator('[data-open-manager="scheme-INF000000001"]').click();
  assert.equal(await page.locator('[data-ws-tab="holdings"]').innerText(), 'Units');
  assert.equal(await page.locator('#workspace-content [data-row-key]').count(), 1);
  assert.equal(await page.locator('#workspace-content th').filter({ hasText: /^Weight$/ }).count(), 0, 'units omit unavailable custodian weights');
  assert.match(await page.locator('#workspace-content').innerText(), /combined across custodians/);
  await page.keyboard.press('Escape');
  await page.locator('[data-open-manager^="fund-example-1-"]').click();
  assert.match(await page.locator('#workspace-content').innerText(), /Drawn|Distributed/);
  assert.match(await page.locator('#workspace-content').innerText(), /This fund investment/);
  assert.doesNotMatch(await page.locator('#workspace-content').innerText(), /Whole Family book, combined/);
  await page.locator('[data-ws-tab="performance"]').click();
  assert.match(await page.locator('#workspace-content').innerText(), /capital multiples/);
  await page.locator('[data-ws-tab="performance"]').focus();
  await page.keyboard.press('Tab');
  assert(await page.locator('[data-ws-close]').evaluate(el => el === document.activeElement), 'Tab wraps inside a workspace with a static panel');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.wsTab), 'performance', 'reverse Tab skips inactive workspace tabs');
  const family = page.frames().find(f => f.url() === 'https://sattva-family.pages.dev/research-bridge');
  await family.evaluate(() => send({ type: 'auth-required' }));
  await page.waitForSelector('[data-manager-unlock]');
  assert.equal(await page.locator('#workspace-content').innerText(), '', 'expired access clears the open private workspace');
  assert.equal(await page.locator('[data-open-manager]').count(), 0, 'expired access clears private cards');
  await family.evaluate(() => { send({ type: 'available' }); send({ type: 'positions-ready', version: 1 }); });
  await page.evaluate(async () => (await import('/js/data/managers.js')).load({ force: true }));
  await page.waitForSelector('[data-open-manager="custodian-example"]');
  await page.evaluate(() => paint('portfolio', 'quarterly-changes'));
  await page.locator('[data-changes-audience] [role="tab"]').filter({ hasText: 'My Managers' }).click();
  await page.locator('[data-changes-period]').selectOption('itd');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'), '2');
  await page.locator('[data-changes-activity] [data-table-search]').fill('Portfolio');
  await page.locator('[data-changes-activity] [data-table-search]').evaluate(el => el.setSelectionRange(2, 5));
  await page.evaluate(async () => (await import('/js/data/managers.js')).load({force:true}));
  assert.deepEqual(await page.locator('[data-changes-activity] [data-table-search]').evaluate(el => [el.selectionStart, el.selectionEnd, el === document.activeElement]), [2, 5, true], 'Changes retains the active search selection on source refresh');
  assert.equal(await page.locator('[data-changes-activity] [data-bookmark-key]').count(), 0);
  await page.locator('[data-changes-activity] [data-row-key]').last().click();
  assert.match(await page.locator('#modal-content').innerText(), /not a verified execution date/);
  await family.evaluate(() => send({ type: 'invalidated', version: 2 }));
  // postMessage queues work in the parent; child evaluate completion is not its acknowledgement.
  await page.waitForFunction(async () => !(await import('/js/data/managers.js')).meta() && !document.querySelector('#modal-content')?.textContent.trim(), null, { timeout: 5000 });
  assert.equal(await page.locator('#modal-content').innerText(), '', 'archive change revokes private evidence');
  await page.locator('[data-changes-audience] [role="tab"]').filter({ hasText: 'All Investors' }).click();
  assert(await page.locator('[data-changes-activity] [data-row-key]').count() > 0, 'public history stays available after private revocation');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => paint('portfolio', 'my-managers'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `manager view has no page overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  // A slow public directory cannot hide private navigation or reset a live query.
  let releasePublic;
  holdPublic = new Promise(done => releasePublic = done);
  const cold = await browser.newContext({ viewport: { width:320, height:900 }, serviceWorkers:'block' });
  await cold.route('**/*', fixtureRoute);
  const coldPage = await cold.newPage(), coldErrors = [];
  coldPage.on('pageerror', e => coldErrors.push(e.message));
  await coldPage.clock.install({ time:new Date(at) });
  await coldPage.goto(origin + '/dispatcher', { waitUntil:'domcontentloaded' });
  await coldPage.locator('[data-changes-audience] [data-tab-id="investors"]').click();
  assert.match(await coldPage.locator('[data-changes-panel]').innerText(), /Investor directory is loading/);
  assert.doesNotMatch(await coldPage.locator('[data-changes-panel]').innerText(), /0 buys · 0 sells/);
  await coldPage.locator('[data-live-section-tabs] [data-tab-id="data-table"]').click();
  assert.equal(await coldPage.locator('[data-live-panel] [aria-busy="true"]').count(), 1);
  await coldPage.locator('[data-live-section-tabs] [data-tab-id="my-managers"]').click();
  await coldPage.waitForSelector('[data-open-manager="custodian-example"]');
  assert.equal(await coldPage.evaluate(async () => (await import('/js/data/super-investors.js')).isLoaded()), false, 'private book opens before delayed public data');
  await coldPage.locator('[data-manager-search]').fill('Example');
  await coldPage.locator('[data-manager-sources] summary').click();
  releasePublic(); holdPublic = null;
  await coldPage.waitForFunction(async () => (await import('/js/data/super-investors.js')).isLoaded());
  assert.equal(await coldPage.locator('[data-manager-search]').inputValue(), 'Example', 'public arrival leaves private query intact');
  await coldPage.evaluate(() => paint('watchlist'));
  assert.equal(await coldPage.locator('[data-manager-search]').inputValue(), 'Example');
  await coldPage.evaluate(() => paint('portfolio'));
  await coldPage.locator('[data-open-manager="custodian-example"]').click();
  assert(await coldPage.locator('[data-workspace-navigation] [data-tab-scroll-controls]').isVisible(), 'narrow workspace reveals tab scrolling controls');
  for (const theme of ['light', 'dark']) {
    await coldPage.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert(await coldPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const close = await coldPage.locator('[data-ws-close]').boundingBox();
    assert(close.width >= 44 && close.height >= 44 && close.x >= 0 && close.x + close.width <= 320, 'close control stays visible and touch sized');
    if (process.env.SI_QA_DIR) await coldPage.screenshot({ path:`${process.env.SI_QA_DIR}/workspace-mobile-${theme}.png`, fullPage:true, animations:'disabled' });
  }
  await coldPage.keyboard.press('Escape');
  assert.equal(await coldPage.evaluate(() => document.activeElement.dataset.openManager), 'custodian-example', 'closing restores keyboard focus to the manager card');
  assert.deepEqual(coldErrors, []);
  await cold.close();
  const unavailable = await browser.newContext({ serviceWorkers:'block' });
  await unavailable.route('**/*', fixtureRoute);
  await unavailable.route('**/data/super-investors.json', route => route.fulfill({status:503,body:'{}'}));
  await unavailable.route('**/api/super-investors', route => route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,reason:'no-token',message:'npx wrangler secret put MUNS_TOKEN'})}));
  const unavailablePage = await unavailable.newPage();
  await unavailablePage.goto(origin + '/dispatcher');
  await unavailablePage.locator('[data-live-section-tabs] [data-tab-id="investors"]').click();
  await unavailablePage.waitForFunction(() => document.querySelector('[data-live-panel]')?.textContent.includes('Investor source access unavailable'));
  const customerText = await unavailablePage.locator('[data-live-panel]').innerText();
  assert.doesNotMatch(customerText, /npx|wrangler|MUNS_TOKEN|\/api\/|bearer token/);
  assert.match(customerText, /does not establish that an investor has no holdings/);
  await unavailable.close();
  console.log('PASS investor scope, identity, disclosure notes, shared changes, drill evidence, missing books, outages and mobile layout');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
