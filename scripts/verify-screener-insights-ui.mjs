#!/usr/bin/env node
// Exercise the actual collector and browser cache against intercepted fixtures. No source reads,
// credentials, production dispatches, account mutations, or live holdings are involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPortfolioTargets, readInsightCompany } from './collect-screener-insights.mjs';
import { buildInsightInventory } from './lib/screener-insights-inventory.mjs';
import { mergeScreenerInsightsCapture } from '../public/js/data/screener-insights-shared.js';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public/', import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(2_000);
const origin = 'https://www.screener.in';
const checkedAt = new Date().toISOString();
let mode = 'ok';
let apiMode = 'ok';
let payload;
const table = (periodicity) => `<div id="${periodicity}-insights"><table><thead><tr><th></th><th data-date-key="2026-03-31">Mar 2026</th></tr></thead><tbody><tr><td>Production<br><span class="sub">MT</span></td><td>100</td></tr></tbody></table></div>`;

await context.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === origin) {
    if (url.pathname === '/watchlist/10850427/') return route.fulfill({ contentType: 'text/html', body: '<a href="/dash/10850427/">S Screen</a><form action="/api/export/screen/?sublist_id=10850427" method="post"><button type="submit">Export</button></form><a href="/company/TEST/">One table row only</a>' });
    if (url.pathname === '/api/export/screen/') return route.fulfill({ headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="watchlist.csv"' }, body: 'Name,ISIN Code,NSE Code,BSE Code\nTest,INE000000001,TEST,\nDelisted,INE000000002,,\n' });
    if (url.pathname === '/user/stocks/10850427/') return route.fulfill({ contentType: 'text/html', body: `<h1>Add companies to S Screen</h1><ul><li><span class="shrink-text">Test Ltd</span><button onclick="window.Watchlist.removeCompany('1')" type="button"><i class="icon-trash"></i></button></li>${mode === 'short-inventory' ? '' : '<li><span class="shrink-text">Delisted Ltd</span><button onclick="window.Watchlist.removeCompany(\'1234\')" type="button"><i class="icon-trash"></i></button></li>'}</ul><script>window.removalCalls=0;window.Watchlist={removeCompany:()=>window.removalCalls++};</script>` });
    if (url.pathname.startsWith('/company/')) {
      return route.fulfill({ contentType: 'text/html', body: mode === 'expired-session' ? '<h1>Sign in</h1>' : mode === 'no-insights' ? '<a href="/logout/">Logout</a><h1>Test</h1>' : `<a href="/logout/">Logout</a><section id="insights">${table('yearly')}<button data-tab-id="quarterly-insights" onclick="fetch('/quarter/').then(r=>r.text()).then(html=>this.insertAdjacentHTML('afterend',html))">Quarterly</button></section>` });
    }
    if (url.pathname === '/quarter/') return route.fulfill({ contentType: 'text/html', status: mode === 'failed-quarter' ? 503 : 200, body: mode === 'failed-quarter' ? 'Unavailable' : table('quarterly') });
  }
  if (url.origin === 'http://insights.test') {
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">window.insights=await import("/js/data/screener-insights.js");</script>' });
    if (url.pathname === '/api/screener-insights') return route.fulfill({ contentType: 'application/json', status: apiMode === 'offline' ? 503 : 200, headers: { etag: apiMode === 'invalid' ? 'bad' : 'good' }, body: JSON.stringify(apiMode === 'invalid' ? { invalid: true } : payload) });
    if (url.pathname.startsWith('/js/')) {
      const path = resolve(root, '.' + url.pathname);
      if (path.startsWith(resolve(root) + sep)) return route.fulfill({ contentType: 'text/javascript', body: readFileSync(path, 'utf8') });
    }
  }
  return route.abort();
});

try {
  const { records, manageRows } = await exportPortfolioTargets(page);
  assert.deepEqual(manageRows, [{ companyId: '1', href: '', name: 'Test Ltd' }, { companyId: '1234', href: '', name: 'Delisted Ltd' }], 'production span-only markup yields names and public IDs, not fabricated links');
  assert.equal(await page.evaluate(() => window.removalCalls), 0, 'inventory never invokes mutation controls');
  const inventory = buildInsightInventory([{ Company: 'Test', 'Screener URL': '/company/TEST/' }], records, manageRows);
  assert.equal(inventory.size, 2, 'full export + management list includes the company absent from table view');
  assert.equal(inventory.get('ID:1234').ticker, null);
  assert.equal(inventory.get('ID:1234').isin, 'INE000000002');
  mode = 'short-inventory';
  await assert.rejects(exportPortfolioTargets(page), /count mismatch/);
  mode = 'ok';
  const item = inventory.get('TEST');
  const company = await readInsightCompany(page, item, checkedAt);
  assert.equal(company.rows.length, 2, 'lazy quarterly table is loaded and parsed with yearly data');
  assert.equal((await readInsightCompany(page, { ...item, companyUrl: `${item.companyUrl}consolidated/` }, checkedAt)).rows.length, 2, 'the consolidated page retains the same verified company identity');
  payload = { version: 1, sourceId: 'screener-insights', checkedAt, targetCount: 1, checkedCount: 1, failedCount: 0, fullCoverage: true, targetKeys: ['TEST'], companies: [company] };
  mode = 'failed-quarter';
  await assert.rejects(readInsightCompany(page, item, checkedAt, { tabTimeout: 300 }));
  const retained = mergeScreenerInsightsCapture({ ...payload, companies: [], failedCount: 1, failedKeys: ['TEST'], fullCoverage: false }, payload);
  assert.equal(retained.companies[0].rows.length, 2);
  assert.equal(retained.companies[0].readStatus, 'failed');
  mode = 'expired-session';
  await assert.rejects(readInsightCompany(page, item, checkedAt), /session/);
  mode = 'no-insights';
  assert.equal((await readInsightCompany(page, item, checkedAt)).rows.length, 0, 'a verified page with no section differs from a broken table');
  await assert.rejects(readInsightCompany(page, item, checkedAt, { previousCompany: company }), /disappeared/, 'an unexpectedly vanished section cannot erase captured history');

  await page.goto('http://insights.test/');
  await page.waitForFunction(() => window.insights);
  await page.evaluate(() => window.insights.load());
  apiMode = 'invalid';
  await page.evaluate(() => window.insights.load({ refresh: true }));
  assert.deepEqual(await page.evaluate(() => ({ count: window.insights.all().length, failed: window.insights.meta().latestReadFailed })), { count: 1, failed: true });
  apiMode = 'offline';
  await page.reload();
  await page.waitForFunction(() => window.insights);
  await page.evaluate(() => window.insights.load());
  assert.equal(await page.evaluate(() => window.insights.all()[0].rows.length), 2, 'malformed 200 did not poison last-good IndexedDB data across reload');
  assert.equal(await page.evaluate(() => window.insights.meta().latestReadFailed), true);
  apiMode = 'ok';
  await page.evaluate(() => window.insights.load({ refresh: true }));
  assert.equal(await page.evaluate(() => window.insights.meta().latestReadFailed), false, 'successful revalidation clears the read failure');
  assert.equal(await page.evaluate(async () => {
    const { conditionalJson } = await import('/js/core/store.js');
    let validated = 0;
    await Promise.all([
      conditionalJson('api/screener-insights', { key: 'fixture-validation-boundary' }),
      conditionalJson('api/screener-insights', { key: 'fixture-validation-boundary', validate: () => { validated++; } }),
    ]);
    return validated;
  }), 1, 'a concurrent unvalidated caller cannot bypass a consumer-owned validator');
  console.log('PASS: real browser inventory/export, internal IDs, lazy tabs, session failure, partial retention and invalid-response/offline cache recovery.');
} finally {
  await browser.close();
}
