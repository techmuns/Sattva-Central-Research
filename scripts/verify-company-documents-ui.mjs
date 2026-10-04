// Local source fixtures exercise the real document reader, renderer and export column getters.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), at = new Date().toISOString();
const rows = [
  { title: 'Recovered annual report', provider: 'Screener company documents' },
  { title: 'Primary transcript', source: 'Screener.in via Muns' },
  { title: 'Legacy document' },
].map((row, i) => ({ ...row, ticker: 'HEG', form: 'annual_report', date: '2026', url: `https://example.test/${i}.pdf` }));
const html = `<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main></main><script type="module">
import { renderCompanyFilings } from '/js/tabs/company-filings.js';
import * as refresh from '/js/core/refresh.js';
window.refresh = refresh;
renderCompanyFilings({ root: document.querySelector('main'), scope: 'universe', params: { company: 'HEG' }, data: {} });
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const send = (type, body) => { res.setHeader('content-type', type); res.end(body); };
  const json = body => send('application/json', JSON.stringify(body));
  if (path === '/') return send('text/html', html);
  if (path === '/data/filing-capture/index.json') return json({ version: 1, companies: [{ ticker: 'HEG' }],
    sources: { domestic: { HEG: { lastSuccessAt: at, lastResponseAt: at } } } });
  if (path === '/data/filing-capture/domestic/HEG.json') return json({ rows, fetchedAt: at });
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
  assert.deepEqual(errors, []);
  console.log('PASS document table/export preserve each provider and live failures remain visible with retained documents.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
