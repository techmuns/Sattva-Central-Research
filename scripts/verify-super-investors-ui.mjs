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
let fail = false;
const books = {
  one: b('one', [h('Aavas Financiers Ltd.', 'AAVAS', 2.13, 1.65), h('Portfolio Only Ltd.', 'ONLY', 1.2, 1), h('Pending Ltd.', 'PENDING', 'Filing Due', 1, 0)]),
  two: b('two', [h('Aavas Financiers Limited', 'AAVAS', 1.1, null), h('Portfolio Only Other Ltd.', 'OTHER', 1.5, 1)]),
  old: { ...b('old', []), quarters: ['Jun 2025', 'Mar 2025'] },
};
const investors = [...Object.keys(books), 'missing'].map(slug => ({ slug, name: slug }));
const snapshot = { capturedAt: at, investors, books };
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css">
<body class="bg-slate-50"><main id="test-root" class="mx-auto max-w-7xl p-4"></main>
<div id="modal-overlay" class="hidden fixed inset-0 z-50 overflow-y-auto bg-slate-900/30 p-4"><div id="modal-container"><div id="modal-content"></div></div></div>
<script type="module">
import * as feed from '/js/data/super-investors.js';
import * as coverage from '/js/data/coverage.js';
import * as watchlist from '/js/core/watchlist.js';
import { renderLive } from '/js/investors/live.js';
coverage.prime({ holdings: [{ ticker: 'ONLY', name: 'Portfolio Only' }] });
let disposers = [], scope = 'portfolio', section = 'quarterly-changes';
window.paint = (nextScope = scope, nextSection = section) => {
  scope = nextScope; section = nextSection;
  disposers.forEach(fn => fn()); disposers = [];
  renderLive({ root: document.querySelector('#test-root'), scope }, { disposers, section });
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
  const buys = page.locator('[data-ranked-list="si-consensus-buys"]');
  assert.match(await buys.innerText(), /available Portfolio disclosures/);
  assert.doesNotMatch(await page.locator('[data-quarter-summary]').innerText(), /No company was bought|No company was sold|Every position disclosed/);
  assert.match(await page.locator('[data-si-coverage]').innerText(), /2 of 4 tracked books/);
  assert.match(await page.locator('[data-si-coverage]').innerText(), /1 unavailable/);
  assert.match(await page.locator('[data-si-universe]').innerText(), /1 company/);
  assert.equal(await page.evaluate(() => testSI.feed.quarterSummary({ include: (company) => company === 'Portfolio Only Ltd.' }).counts.added), 1);
  await page.locator('[data-si-universe]').click();
  await page.waitForFunction(() => document.querySelector('[data-quarter-summary] h2').textContent.includes('Universe'));
  assert.equal(await buys.locator('button').count(), 1);
  await buys.locator('button').click();
  const detail = page.locator('[data-company-investor-detail]');
  assert.equal(await detail.locator('[data-company-investor-row]').count(), 2);
  assert.match(await detail.innerText(), /1.65%/); assert.match(await detail.innerText(), /2.13%/);
  assert.match(await detail.innerText(), /1.10%/); assert.doesNotMatch(await detail.innerText(), /Aug 2026/);
  assert.equal(await detail.locator('a[href^="https://ticker.finology.in/investor/"]').count(), 2);
  await page.keyboard.press('Escape');
  await page.evaluate(() => paint('watchlist'));
  assert.match(await buys.innerText(), /available Watchlist disclosures/);
  await page.evaluate(() => { testSI.watchlist.add('PENDING', 'Pending'); paint('watchlist', 'data-table'); });
  assert.match(await page.locator('#test-root').innerText(), /Incomplete data/i);
  assert.doesNotMatch(await page.locator('#test-root').innerText(), /Undisclosed/);
  await page.evaluate(() => paint('portfolio', 'quarterly-changes'));
  if (process.env.SI_SCREENSHOT) await page.screenshot({ path: process.env.SI_SCREENSHOT, fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no page overflow at ${width}`);
  }
  await page.evaluate(() => testSI.feed.refresh());
  fail = true;
  await page.evaluate(() => testSI.feed.refresh());
  assert.equal(await page.evaluate(async () => (await (await import('/js/core/store.js')).readEntry('investor:one')).value.ok), true, 'failed response cannot poison the device cache');
  assert.match(await page.locator('[data-si-coverage]').innerText(), /book reads failed/);
  assert.equal(await page.evaluate(() => testSI.feed.books().length), 3, 'failed refresh retains evidence');
  fail = false;
  await page.evaluate(() => testSI.feed.refresh());
  assert.equal(await page.evaluate(() => testSI.feed.meta().failedBooks), 1, 'successful retry clears retained-book failures');
  await page.reload();
  await page.waitForFunction(() => !!window.testSI);
  assert.equal(await page.evaluate(() => testSI.feed.books().length), 3, 'repeat visit restores validated device books');
  assert.equal(await page.evaluate(() => testSI.feed.book('one').holdings.find(h => h.companySlug === 'PENDING').quarterlyNotes['Jun 2026']), 'Filing Due');
  books.one.holdings.find(h => h.companySlug === 'ONLY').quarterlyHoldings['Jun 2026'] = 1.8;
  await page.clock.setSystemTime(new Date(Date.parse(at) + 7 * 3600000));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => testSI.feed.book('one').holdings.find(h => h.companySlug === 'ONLY').quarterlyHoldings['Jun 2026'] === 1.8);
  assert.match(await page.locator('[data-ranked-list="si-adds"]').innerText(), /0.80 pp/, 'resume automatically picks up late corrections');
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
