#!/usr/bin/env node
// Focused browser regression for the NSE XBRL filing reader. All data is local and every non-local
// request is blocked, so a run costs the exchange nothing: the stub route answers with the SAME
// shared parser the Worker uses, over the same committed fixture the offline suite reads.
//
// WHAT IT IS PROVING. The reported failure was that a filing link opened SEBI's raw XBRL — the row
// worked, the URL was right, and what arrived was unreadable. So these checks compare what a reader
// SEES against what the filing says, and assert the raw document remains explicitly available in every
// state, including the states where nothing here can render it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filingFacts, parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';
import { renderFilingPage, renderFilingFailure } from '../worker/filing-page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const pwRoot = process.env.PLAYWRIGHT_ROOT;
if (!pwRoot) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${pwRoot}/index.mjs`);

const XBRL_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/REG30_PARA_B_897_WebXMLFile_20260910_180615065.xml';
const PDF_URL = 'https://nsearchives.nseindia.com/corporate/MANINDS_10092026135546_order.pdf';
const xml = readFileSync(resolve(here, 'fixtures/nse-xbrl/reg30-para-b-orders.xml'), 'utf8');

const PB_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/SAIIM_19824_WebXMLFile_20260924_130926074.xml';
const RAIL_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/ChangeInManagement_railtel.xml';
const fixtures = new Map([
  [XBRL_URL, xml],
  [PB_URL, readFileSync(resolve(here, 'fixtures/nse-xbrl/analyst-meet-pbfintech.xml'), 'utf8')],
  [RAIL_URL, readFileSync(resolve(here, 'fixtures/nse-xbrl/change-in-management.xml'), 'utf8')],
]);
const rows = [
  { company: 'Man Industries (India) Limited', ticker: 'MANINDS', publishedAt: '2026-09-24T12:36:16Z',
    subject: 'Bagging/Receiving of orders/contracts  (Sub-para 4-Para B)', description: 'Man Industries has informed the Exchange', url: XBRL_URL },
  { company: 'Man Industries (India) Limited', ticker: 'MANINDS', publishedAt: '2026-09-24T08:25:54Z',
    subject: 'Bagging/Receiving of orders/contracts', description: 'The same event, filed as a PDF', url: PDF_URL },
];

rows.push(
  { company: 'PB Fintech Limited', ticker: 'POLICYBZR', publishedAt: '2026-09-24T07:39:26Z', subject: 'Analyst/Investor Meet Para A-XBRL', url: PB_URL },
  { company: 'RailTel Corporation of India Limited', ticker: 'RAILTEL', publishedAt: '2026-09-24T07:00:00Z', subject: 'Change in Management', url: RAIL_URL },
);

// `workerDown` is the static-origin case: `python3 -m http.server` and the sandbox both answer a
// route that does not exist, and the panel must say THAT rather than blaming the exchange.
let workerDown = false;
let filingReads = 0;
let sourceDown = false;

const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head>
<body class="bg-slate-50 p-6">
  <main id="root"></main>
  <div id="drill-overlay" class="hidden"></div>
  <div id="modal-overlay" class="fixed inset-0 z-[60] hidden items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
    <div id="modal-container" class="relative my-8 w-full max-w-4xl scale-95 overflow-hidden rounded-3xl bg-white opacity-0"><div id="modal-content"></div></div>
  </div>
  <p><a id="loose-link" href="${XBRL_URL}" target="_blank" rel="noopener noreferrer">A filing link outside any table</a></p>
  <p><a id="loose-pdf" href="${PDF_URL}" target="_blank" rel="noopener noreferrer">A PDF link outside any table</a></p>
<script type="module">
import * as tab from '/js/tabs/nse-filings.js';
import * as coverage from '/js/data/coverage.js';
import { installFilingReader, openFilingSource } from '/js/ui/xbrl-filing.js';
coverage.prime({ holdings: [{ ticker: 'MANINDS', name: 'Man Industries (India) Limited' }] });
installFilingReader();
const live = { register() {}, start() {}, stop() {} };
window.testXbrl = { openFilingSource, show: (scope) => tab.render({ root: document.querySelector('#root'), scope, live }) };
window.testXbrl.show('universe');
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }

  if (url.pathname === '/api/nse-filing') {
    filingReads += 1;
    if (workerDown) { res.writeHead(404); res.end('not found'); return; }
    const src = url.searchParams.get('src') || '';
    // The stub reproduces the route's own allow-list, so a test that stopped refusing a foreign URL
    // would fail here rather than passing quietly against a permissive stand-in.
    if (!fixtures.has(src)) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'unsupported', url: src })); return; }
    res.setHeader('content-type', 'application/json');
    if (sourceDown) { res.end(JSON.stringify({ ok: false, reason: 'unreachable' })); return; }
    res.end(JSON.stringify({ ok: true, url: src, fetchedAt: new Date().toISOString(), ...parseXbrlFiling(fixtures.get(src)) }));
    return;
  }

  // THE PAGE A LINK OUT OF THE TEAM BRIEF LANDS ON. The Worker serves it from the same parsed
  // filing as the JSON route above, so the stub renders it the same way — what is under test is
  // that a reader with nothing but a browser can READ the filing, which is the whole complaint.
  if (url.pathname === '/filing') {
    const src = url.searchParams.get('src') || '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(sourceDown || !fixtures.has(src)
      ? renderFilingFailure({ url: src, reason: 'unreachable' })
      : renderFilingPage({ filing: parseXbrlFiling(fixtures.get(src)), url: src, dashboardUrl: 'https://example.test' }));
    return;
  }

  let body;
  if (url.pathname === '/api/nse-announcements') body = { ok: true, capturedAt: '2026-09-10T13:00:00Z', rows };
  else if (url.pathname === '/data/nse-announcements.json') body = { ok: true, capturedAt: '2026-09-10T13:00:00Z', rows };
  else if (url.pathname === '/data/nse-filings/index.json') body = { days: [] };
  if (body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return; }

  const path = resolve(root, `.${url.pathname}`);
  if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const context = await browser.newContext();
// Nothing here may reach the internet. A check that quietly fetched NSE would be testing the
// exchange's availability rather than this code.
await context.route('**', (route) => {
  if (fixtures.has(route.request().url())) return route.fulfill({ contentType: 'text/plain', body: fixtures.get(route.request().url()) });
  return route.request().url().startsWith(base) ? route.continue() : route.abort();
});
await context.addInitScript(() => {
  localStorage.setItem('sattva:watchlist', JSON.stringify([{ ticker: 'POLICYBZR', name: 'PB Fintech Limited' }]));
  localStorage.setItem('sattva:watchlist:shape', '3');
});
const page = await context.newPage();
// Keep the dated filing fixture inside the view's default recent-date window.
await page.clock.setFixedTime(new Date('2026-09-24T14:00:00Z'));

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let checks = 0;
const check = async (label, fn) => { await fn(); checks += 1; console.log(`PASS ${label}`); };
const panel = () => page.locator('[data-xbrl-panel]');
const closePanel = () => page.keyboard.press('Escape');
const openOriginal = async ({ keyboard = false } = {}) => {
  await panel().locator('summary').click();
  const original = panel().locator('[data-xbrl-original]');
  assert.match(await original.innerText(), /View raw XML on NSE \(technical file\)/);
  const textBefore = await panel().innerText();
  const readsBefore = filingReads;
  const sourcePage = page.url();
  const [opened] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    keyboard ? original.press('Enter') : original.click(),
  ]);
  try {
    await opened.waitForLoadState('domcontentloaded');
    assert.equal(opened.url(), XBRL_URL, 'the new tab uses the original NSE URL');
    assert.equal(await opened.evaluate(() => window.opener), null, 'the new tab has no opener access');
    assert.equal(page.url(), sourcePage, 'the dashboard stays in its original tab');
    assert.equal(await panel().innerText(), textBefore, 'the filing popup stays intact');
    assert.equal(filingReads, readsBefore, 'opening the original does not fetch and reopen the reader');
  } finally { await opened.close(); }
};

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-table-scroll] tbody tr');

await check('the XBRL row offers a filing to read, and the PDF row still opens as a link', async () => {
  const labels = await page.locator('td a[data-filing-company]').allInnerTexts();
  assert.equal(labels.length, 4);
  // The arrow means "leaves the page", so only the row that still does keeps it.
  assert.ok(labels.some((t) => t.trim() === 'Read filing'), `expected a Read filing control, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.includes('Open filing')), `expected the PDF row to keep its link, got ${JSON.stringify(labels)}`);
});

await check('clicking it opens the filing here, as the filing’s own fields', async () => {
  const before = context.pages().length;
  await page.locator('td a', { hasText: 'Read filing' }).first().click();
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !/Reading the filing/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  const text = await panel().innerText();

  // THE FILING, IN WORDS. Every one of these is a field the raw XML carried and a browser did not
  // show; the counterparty and the order value are the two a reader opened the row for.
  assert.match(text, /Man Industries \(India\) Limited/);
  assert.match(text, /NSE symbol/i);
  assert.match(text, /MANINDS/);
  assert.match(text, /Name of the entity awarding the orders or contracts/i);
  assert.match(text, /Domestic and International Customers/);
  assert.match(text, /ISIN INE993A01026/);

  // AND NONE OF THE MARKUP THAT WAS THE COMPLAINT.
  assert.doesNotMatch(text, /in-capmkt:/);
  assert.doesNotMatch(text, /xbrli:/);
  assert.doesNotMatch(text, /contextRef/);
  assert.doesNotMatch(text, /style information/i);

  // It reproduces rather than interprets, and says so.
  assert.match(text, /unchanged/i);
  // Nothing left the page to do it.
  assert.equal(context.pages().length, before);
});

await check('raw XML is an explicit technical source choice, never the main filing action', async () => {
  const original = panel().locator(`a[href="${XBRL_URL}"]`);
  assert.equal(await original.count(), 1);
  assert.equal(await original.getAttribute('target'), '_blank');
  assert.equal(await original.getAttribute('rel'), 'noopener noreferrer');
  await openOriginal();
  await closePanel();
  await panel().waitFor({ state: 'detached' });
});

await check('a filing link anywhere in the app is read the same way, and a PDF link is untouched', async () => {
  // The Link column's arrow, an AI Alerts card and a drill panel all offer these as plain anchors.
  // One delegated listener is what makes them behave alike, so this asserts it outside any table.
  await page.locator('#loose-link').click();
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !/Reading the filing/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  assert.match(await panel().innerText(), /Domestic and International Customers/);
  await closePanel();
  await panel().waitFor({ state: 'detached' });

  // A PDF is already readable and must keep its ordinary behaviour: a new tab, not a panel.
  await page.locator('#loose-pdf').click();
  await page.waitForTimeout(400);
  assert.equal(await panel().count(), 0, 'a PDF must not open the XBRL panel');
  for (const extra of context.pages().slice(1)) await extra.close();
});

await check('a modified click opens the complete readable page', async () => {
  for (const options of [{ modifiers: ['ControlOrMeta'] }, { button: 'middle' }]) {
    const [opened] = await Promise.all([context.waitForEvent('page'), page.locator('#loose-link').click(options)]);
    await opened.waitForLoadState('domcontentloaded');
    assert.equal(new URL(opened.url()).pathname, '/filing');
    assert.equal(new URL(opened.url()).searchParams.get('src'), XBRL_URL);
    assert.match(await opened.locator('body').innerText(), /Domestic and International Customers/);
    assert.equal(await panel().count(), 0);
    await opened.close();
  }
});

await check('with no Worker the panel says so and still hands over the document', async () => {
  workerDown = true;
  await page.locator('#loose-link').click();
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !/Reading the filing/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  const text = await panel().innerText();
  // A STATIC ORIGIN IS NOT A BROKEN EXCHANGE, and the words have to separate those two.
  assert.match(text, /readable filing is unavailable on this copy/i);
  assert.equal(await panel().locator('[data-filing-retry]').count(), 1);
  assert.doesNotMatch(text, /unreachable/i);
  assert.equal(await panel().locator(`a[href="${XBRL_URL}"]`).count(), 1);
  await openOriginal({ keyboard: true });
  await closePanel();
  await panel().waitFor({ state: 'detached' });
  workerDown = false;
});

await check('the filing page preserves every filed fact and keeps technical XML separately labelled', async () => {
  // This is the email's destination: no dashboard, no script, no stylesheet — just the document.
  const filing = parseXbrlFiling(xml);
  const reader = await context.newPage();
  await reader.goto(`${base}filing?src=${encodeURIComponent(XBRL_URL)}`, { waitUntil: 'load' });
  const text = await reader.locator('body').innerText();
  assert.match(text, /Man Industries \(India\) Limited/);
  assert.doesNotMatch(text, /does not appear to have any style information/i, 'the reader never sees the XML tree');
  assert.doesNotMatch(text, /<in-capmkt:/, 'no markup reaches the page as text');
  // Every field the filing carries is on the page, under the exchange's own label.
  for (const fact of filingFacts(filing)) {
    assert.ok(text.includes(fact.label), `missing label ${fact.label}`);
    assert.ok(text.includes(fact.value), `missing value ${fact.value}`);
  }
  assert.equal(await reader.locator(`a[href="${XBRL_URL}"]`).count(), 1, 'the original document stays reachable');
  assert.equal(await reader.locator('script').count(), 0);
  // It must be legible on the phone an email is read on, without sideways scrolling.
  await reader.setViewportSize({ width: 390, height: 800 });
  assert.equal(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scroll at 390px');
  await reader.close();
});

await check('Portfolio, Watchlist and Universe use the same reader for every eligible filing', async () => {
  const expected = { portfolio: [XBRL_URL], watchlist: [PB_URL], universe: [XBRL_URL, PB_URL, RAIL_URL] };
  for (const [scope, urls] of Object.entries(expected)) {
    await page.evaluate(scope => window.testXbrl.show(scope), scope);
    await page.waitForFunction(count => document.querySelectorAll('td a[data-filing-company][href*="/filing?"]').length === count, urls.length);
    const links = page.locator('td a[data-filing-company][href*="/filing?"]');
    assert.deepEqual((await links.evaluateAll(nodes => nodes.map(a => new URL(a.href).searchParams.get('src')))).sort(), [...urls].sort());
    for (let i = 0; i < urls.length; i++) {
      const link = links.nth(i), href = await link.getAttribute('href');
      const src = new URL(href, base).searchParams.get('src');
      const filing = parseXbrlFiling(fixtures.get(src));
      await link.press('Enter');
      await page.waitForFunction(() => !!document.querySelector('[data-xbrl-panel] [data-xbrl-page]'));
      const text = await panel().innerText();
      for (const fact of filingFacts(filing)) assert.ok(text.includes(fact.value), `${scope}: missing ${fact.value}`);
      assert.doesNotMatch(text, /Open the original file on NSE|contextRef|xbrli:/);
      assert.equal(await panel().locator('[data-xbrl-original]').isVisible(), false);
      const [opened] = await Promise.all([page.waitForEvent('popup'), panel().locator('[data-xbrl-page]').click()]);
      await opened.waitForLoadState('domcontentloaded');
      assert.equal(new URL(opened.url()).searchParams.get('src'), src);
      const full = await opened.locator('body').innerText();
      for (const fact of filingFacts(filing)) assert.ok(full.includes(fact.value), `${scope} full page: missing ${fact.value}`);
      assert.equal(await opened.evaluate(() => window.opener), null);
      await opened.close();
      await closePanel();
      await panel().waitFor({ state: 'detached' });
    }
  }
});

await check('new and recycled source anchors keep native new-tab and copy destinations readable', async () => {
  await page.evaluate(src => {
    const a = document.createElement('a'); a.id = 'dynamic-filing'; a.href = src;
    a.textContent = 'New source'; document.body.append(a);
  }, PB_URL);
  const link = page.locator('#dynamic-filing');
  await page.waitForFunction(() => document.querySelector('#dynamic-filing').pathname === '/filing');
  assert.equal(new URL(await link.getAttribute('href'), base).searchParams.get('src'), PB_URL);
  await link.click({ button: 'right' });
  assert.equal(new URL(await link.getAttribute('href'), base).pathname, '/filing');
  await page.keyboard.press('Escape');
  await link.evaluate((a, src) => { a.href = src; }, RAIL_URL);
  await page.waitForFunction(src => new URL(document.querySelector('#dynamic-filing').href).searchParams.get('src') === src, RAIL_URL);
  await link.click();
  await page.waitForFunction(() => /RAILTEL CORPORATION/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  await closePanel();
  await panel().waitFor({ state: 'detached' });
  await link.evaluate((a, src) => { a.href = src; }, PDF_URL);
  assert.equal(await link.getAttribute('href'), PDF_URL, 'a recycled PDF never reopens its former XBRL');
});

await check('row actions in All Alerts and Company Filings share the readable policy', async () => {
  await page.evaluate(src => window.testXbrl.openFilingSource(src), PB_URL);
  await page.waitForFunction(() => /25 fields as filed/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  assert.match(await panel().innerText(), /Sell side Analyst Call/);
  await closePanel();
  await panel().waitFor({ state: 'detached' });
});

await check('an unavailable source offers a readable retry and recovers without opening XML', async () => {
  sourceDown = true;
  await page.locator('#loose-link').click();
  await page.locator('[data-filing-retry]').waitFor();
  assert.equal(await panel().locator('[data-xbrl-original]').isVisible(), false);
  sourceDown = false;
  await page.locator('[data-filing-retry]').click();
  await page.waitForFunction(() => !!document.querySelector('[data-xbrl-page]'));
  assert.match(await panel().innerText(), /Domestic and International Customers/);
  await closePanel();
  await panel().waitFor({ state: 'detached' });
  sourceDown = true;
  const failed = await context.newPage();
  await failed.goto(`${base}filing?src=${encodeURIComponent(PB_URL)}`);
  assert.match(await failed.locator('body').innerText(), /Please try again shortly/);
  assert.equal(await failed.locator(`a[href="${PB_URL}"]`).isVisible(), false);
  sourceDown = false;
  const [retried] = await Promise.all([failed.waitForEvent('popup'), failed.getByRole('link', { name: 'Try readable filing again' }).click()]);
  await retried.waitForLoadState('domcontentloaded');
  assert.match(await retried.locator('body').innerText(), /Sell side Analyst Call/);
  await retried.close(); await failed.close();
});

await check('the whole run produced no console errors', () => {
  const real = errors.filter((e) => !/ERR_FAILED|net::ERR_ABORTED|Failed to load resource/i.test(e));
  assert.deepEqual(real, [], `console errors: ${real.join(' | ')}`);
});

await browser.close();
server.close();
console.log(`\n${checks} NSE XBRL reader UI checks passed.`);
