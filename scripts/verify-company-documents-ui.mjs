// Local source fixtures exercise the real document reader, renderer and export column getters.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), at = new Date().toISOString();
const nonExchange = [
  { isin: 'INE0LTR01029', name: 'Everest Fleet equity', reason: 'Private issuer: listed-equity filings unavailable.' },
  { isin: 'INE0LTR03090', name: 'Everest Fleet preference', reason: 'Private issuer: listed-equity filings unavailable.' },
];
const rows = [
  { title: 'Recovered annual report', provider: 'Screener company documents' },
  { title: 'Primary transcript', source: 'Screener.in via Muns' },
  { title: 'Legacy document' },
].map((row, i) => ({ ...row, ticker: 'HEG', form: 'annual_report', date: '2026', url: `https://example.test/${i}.pdf` }));
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main></main><aside></aside><script type="module">
import { renderCompanyFilings } from '/js/tabs/company-filings.js';
import { announcementLookupControls } from '/js/tabs/announcement-lookup.js';
import * as refresh from '/js/core/refresh.js';
import * as coverage from '/js/data/coverage.js';
import { captureCoverageHtml } from '/js/ui/capture-coverage.js';
coverage.prime({ holdings: [{ ticker: 'HEG', name: 'HEG' }, { ticker: null, isin: 'INE0LTR01029', name: 'Everest Fleet equity' },
  { ticker: null, isin: 'INE935Q01015', name: 'Future Supply Chain' },
  { ticker: null, isin: 'INE666D13019', name: 'Borosil Renewables warrants' }] });
window.refresh = refresh;
window.showCoverage = scope => { document.querySelector('[data-document-coverage]').innerHTML = captureCoverageHtml('announcements', null, { scope }); };
window.lookups = [];
window.showAnnouncementLookup = scope => {
  const control = announcementLookupControls({ rows: () => [{ ticker: 'UNHELD', company: 'Unheld company' }],
    lookup: async request => window.lookups.push(request) });
  const root = document.querySelector('aside'), ctx = { scope, data: {} };
  root.innerHTML = control.html(ctx, { supplement: {} }); control.wire(root, ctx);
};
renderCompanyFilings({ root: document.querySelector('main'), scope: 'portfolio', params: { company: 'HEG' }, data: {} });
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const send = (type, body) => { res.setHeader('content-type', type); res.end(body); };
  const json = body => send('application/json', JSON.stringify(body));
  if (path === '/') return send('text/html', html);
  if (path === '/data/filing-capture/index.json') return json({ version: 1, companies: [{ ticker: 'HEG' },
    { ticker: 'FSC', isin: 'INE935Q01015' }, { ticker: 'BORORENEW', isin: 'INE666D01022' },
    { ticker: 'UNHELD', isin: 'INE000000001' }], nonExchange,
    requestedFrom: at.slice(0, 10), requestedTo: at.slice(0, 10),
    sources: { domestic: { HEG: { lastSuccessAt: at, lastResponseAt: at } },
      announcements: { HEG: { lastSuccessAt: at, ranges: [{ from: at.slice(0, 10), to: at.slice(0, 10) }] } } } });
  if (path === '/data/filing-capture/domestic/HEG.json') return json({ rows, fetchedAt: at });
  if (/^\/data\/filing-capture\/domestic\/(FSC|BORORENEW)\.json$/.test(path)) {
    const ticker = path.split('/').at(-1).replace('.json', '');
    return json({ rows: [{ ...rows[0], ticker, title: ticker + ' retained annual report' }], fetchedAt: at });
  }
  if (path === '/api/domestic-filings/HEG') {
    res.statusCode = 401;
    return json({ ok: false, reason: 'unauthorised', message: 'Fixture session expired' });
  }
  // Capture the rendered tab's actual export contract without downloading a workbook library.
  if (path === '/js/ui/export.js') return send('text/javascript',
    'export function exportRows({rows,columns}) { window.exported=rows.map(r=>Object.fromEntries(columns.map(c=>[c.key,c.get(r)]))); }');
  try {
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw Error('outside fixture');
    send({ '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'text/plain', readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('tbody tr[data-row-key]').length === 3);
  const panel = page.locator('[data-capture-coverage]');
  assert.match(await panel.getAttribute('class'), /bg-amber-50/, 'a private portfolio line prevents green document coverage');
  assert.match(await panel.locator('summary').innerText(), /1 private securities without listed-equity filing coverage/);
  assert.match(await panel.textContent(), /INE0LTR01029/);
  assert.doesNotMatch(await panel.textContent(), /INE0LTR03090/, 'another private security is not in this portfolio');
  assert.match(await panel.locator('summary').innerText(), /1 of 3 companies recently checked/,
    'explicit ticker lists also include this portfolio\'s ISIN-resolved listed holdings');
  assert.match(await panel.textContent(), /FSC: Not registered for automatic capture/);
  assert.match(await panel.textContent(), /BORORENEW: Not registered for automatic capture/);
  assert.doesNotMatch(await panel.textContent(), /UNHELD/);
  const sources = await page.locator('tbody tr[data-row-key]').evaluateAll(rows => {
    const index = [...document.querySelectorAll('thead th')].findIndex(th => th.textContent.trim() === 'Source');
    return rows.map(r => r.children[index].textContent.trim());
  });
  assert.deepEqual(sources, ['Screener company documents', 'Screener.in via Muns', 'Screener.in via Muns']);
  await page.locator('[data-export]').click();
  assert.deepEqual(await page.evaluate(() => exported.map(r => r.source)), sources);
  const result = await page.evaluate(() => refresh.refreshOne('domestic-documents'));
  assert.equal(result.failed, 1, 'an immediate 401 cannot become a successful refresh');
  assert.equal(await page.evaluate(() => refresh.lastRefreshAt('domestic-documents')), null);
  assert.match(await page.locator('[data-document-status]').innerText(), /Refresh failed: Fixture session expired/);
  assert.equal(await page.locator('tbody tr[data-row-key]').count(), 3, 'the failed check retains all documents');
  assert.deepEqual(await page.locator('#filing-companies option').evaluateAll(options => options.map(o => o.value).sort()),
    ['BORORENEW', 'FSC', 'HEG'], 'lookup offers every exact-ISIN listed holding, without private or unheld issuers');
  for (const ticker of ['FSC', 'BORORENEW']) {
    await page.locator('[data-document-search] input[name=ticker]').fill(ticker);
    await page.getByRole('button', { name: 'Show captured filings', exact: true }).click();
    await page.waitForFunction(ticker => document.querySelector('[data-document-status]').textContent.startsWith('1 retained documents for ' + ticker), ticker);
    assert.match(await page.locator('tbody').innerText(), new RegExp(ticker + ' retained annual report'));
  }
  await page.locator('[data-document-search] input[name=ticker]').fill('UNHELD');
  await page.getByRole('button', { name: 'Show captured filings', exact: true }).click();
  assert.match(await page.locator('[data-document-status]').innerText(), /Choose a company in this scope/);
  for (const [scope, count] of [['portfolio', 1], ['universe', 2], ['watchlist', 0]]) {
    await page.evaluate(scope => showCoverage(scope), scope);
    assert.match(await panel.getAttribute('class'), count ? /bg-amber-50/ : /bg-emerald-50/);
    const summary = await panel.locator('summary').innerText();
    assert.match(summary, scope === 'portfolio' ? /1 of 3 companies/ : scope === 'universe' ? /1 of 4 companies/ : /0 of 0 companies/);
    if (count) assert(summary.includes(`${count} private securities without listed-equity filing coverage`));
    else assert(!summary.includes('private securities'), 'unrelated portfolio securities cannot warn on an empty watchlist');
  }
  await page.evaluate(() => showAnnouncementLookup('portfolio'));
  assert.deepEqual(await page.locator('#announcement-companies option').evaluateAll(options => options.map(o => o.value).sort()),
    ['BORORENEW', 'FSC', 'HEG']);
  for (const ticker of ['FSC', 'BORORENEW', 'UNHELD']) {
    await page.locator('[data-announcement-lookup] input[name=ticker]').fill(ticker);
    await page.getByRole('button', { name: 'Fetch additional announcements', exact: true }).click();
  }
  assert.deepEqual(await page.evaluate(() => lookups.map(r => r.ticker)), ['FSC', 'BORORENEW']);
  assert.match(await page.locator('[data-announcement-lookup-status]').innerText(), /Choose a company in this scope/);
  await page.evaluate(() => showAnnouncementLookup('watchlist'));
  assert.equal(await page.locator('#announcement-companies option').count(), 0, 'portfolio identities cannot expand an empty watchlist');
  assert.deepEqual(errors, []);
  console.log('PASS document table/export preserve each provider and live failures remain visible with retained documents.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
