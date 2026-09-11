#!/usr/bin/env node
// Focused browser regression for the NSE XBRL filing reader. All data is local and every non-local
// request is blocked, so a run costs the exchange nothing: the stub route answers with the SAME
// shared parser the Worker uses, over the same committed fixture the offline suite reads.
//
// WHAT IT IS PROVING. The reported failure was that a filing link opened SEBI's raw XBRL — the row
// worked, the URL was right, and what arrived was unreadable. So these checks compare what a reader
// SEES against what the filing says, and assert the raw document stays one click away in every
// state, including the states where nothing here can render it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXbrlFiling } from '../public/js/data/nse-xbrl-shared.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../public');
const pwRoot = process.env.PLAYWRIGHT_ROOT;
if (!pwRoot) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${pwRoot}/index.mjs`);

const XBRL_URL = 'https://nsearchives.nseindia.com/corporate/xbrl/REG30_PARA_B_897_WebXMLFile_20260910_180615065.xml';
const PDF_URL = 'https://nsearchives.nseindia.com/corporate/MANINDS_10092026135546_order.pdf';
const xml = readFileSync(resolve(here, 'fixtures/nse-xbrl/reg30-para-b-orders.xml'), 'utf8');

const rows = [
  { company: 'Man Industries (India) Limited', ticker: 'MANINDS', publishedAt: '2026-09-10T12:36:16Z',
    subject: 'Bagging/Receiving of orders/contracts  (Sub-para 4-Para B)', description: 'Man Industries has informed the Exchange', url: XBRL_URL },
  { company: 'Man Industries (India) Limited', ticker: 'MANINDS', publishedAt: '2026-09-10T08:25:54Z',
    subject: 'Bagging/Receiving of orders/contracts', description: 'The same event, filed as a PDF', url: PDF_URL },
];

// `workerDown` is the static-origin case: `python3 -m http.server` and the sandbox both answer a
// route that does not exist, and the panel must say THAT rather than blaming the exchange.
let workerDown = false;

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
import { installFilingReader } from '/js/ui/xbrl-filing.js';
coverage.prime({ holdings: [{ ticker: 'MANINDS', name: 'Man Industries (India) Limited' }] });
installFilingReader();
const live = { register() {}, start() {}, stop() {} };
window.testXbrl = { show: (scope) => tab.render({ root: document.querySelector('#root'), scope, live }) };
window.testXbrl.show('universe');
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }

  if (url.pathname === '/api/nse-filing') {
    if (workerDown) { res.writeHead(404); res.end('not found'); return; }
    const src = url.searchParams.get('src') || '';
    // The stub reproduces the route's own allow-list, so a test that stopped refusing a foreign URL
    // would fail here rather than passing quietly against a permissive stand-in.
    if (src !== XBRL_URL) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'unsupported', url: src })); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: src, fetchedAt: new Date().toISOString(), ...parseXbrlFiling(xml) }));
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
await context.route('**', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

let checks = 0;
const check = async (label, fn) => { await fn(); checks += 1; console.log(`PASS ${label}`); };
const panel = () => page.locator('[data-xbrl-panel]');
const closePanel = () => page.keyboard.press('Escape');

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-table-scroll] tbody tr');

await check('the XBRL row offers a filing to read, and the PDF row still opens as a link', async () => {
  const labels = await page.locator('td a[data-filing-company]').allInnerTexts();
  assert.equal(labels.length, 2);
  // The arrow means "leaves the page", so only the row that still does keeps it.
  assert.ok(labels.some((t) => t.trim() === 'Read filing'), `expected a Read filing control, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.includes('Open filing')), `expected the PDF row to keep its link, got ${JSON.stringify(labels)}`);
});

await check('clicking it opens the filing here, as the filing’s own fields', async () => {
  const before = context.pages().length;
  await page.locator('td a', { hasText: 'Read filing' }).click();
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

await check('the original document stays one click away', async () => {
  const original = panel().locator(`a[href="${XBRL_URL}"]`);
  assert.equal(await original.count(), 1);
  assert.equal(await original.getAttribute('target'), '_blank');
  assert.equal(await original.getAttribute('rel'), 'noopener noreferrer');
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

await check('a modified click still gets the reader the raw document', async () => {
  // Ctrl-click, middle-click and "open in new tab" are how somebody asks for the file itself.
  // Intercepting those would take away the one thing that used to work.
  await page.locator('#loose-link').click({ modifiers: ['ControlOrMeta'] });
  await page.waitForTimeout(300);
  assert.equal(await panel().count(), 0, 'a ctrl-click must not be intercepted');
  for (const extra of context.pages().slice(1)) await extra.close();
});

await check('with no Worker the panel says so and still hands over the document', async () => {
  workerDown = true;
  await page.locator('#loose-link').click();
  await panel().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !/Reading the filing/.test(document.querySelector('[data-xbrl-panel]')?.textContent || ''));
  const text = await panel().innerText();
  // A STATIC ORIGIN IS NOT A BROKEN EXCHANGE, and the words have to separate those two.
  assert.match(text, /without its Worker/i);
  assert.match(text, /The filing itself is fine/i);
  assert.doesNotMatch(text, /unreachable/i);
  assert.equal(await panel().locator(`a[href="${XBRL_URL}"]`).count(), 1);
  await closePanel();
  await panel().waitFor({ state: 'detached' });
  workerDown = false;
});

await check('the whole run produced no console errors', () => {
  const real = errors.filter((e) => !/ERR_FAILED|net::ERR_ABORTED|Failed to load resource/i.test(e));
  assert.deepEqual(real, [], `console errors: ${real.join(' | ')}`);
});

await browser.close();
server.close();
console.log(`\n${checks} NSE XBRL reader UI checks passed.`);
