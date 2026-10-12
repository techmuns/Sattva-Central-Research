#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWatchlistInventory, watchlistFailureReason } from './lib/screener-watchlist-browser.mjs';
import { matchRemovalButtons } from './lib/screener-watchlist.mjs';

const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
const browser = await chromium.launch({ headless: true });
const options = { origin: 'https://screener-fixture.invalid', watchlistId: '99000001', watchlistName: 'Sattva test watchlist' };
const controls = '<input id="watchlist-search"><a href="/watchlist/import/99000001/">Import companies from any file</a>';
const company = '<li><a href="/company/ALPHA/">Alpha Ltd</a><button onclick="Watchlist.removeCompany(\'11\')">Remove</button></li>';
const exportForm = '<form action="/api/export/screen/?sublist_id=99000001"><button type="submit">Export</button></form>';
const csv = 'Name,NSE Code,ISIN Code\nAlpha Ltd,ALPHA,INE000A01001\n';

async function inventory({ rows = '', table = '', form = '', management = controls, title = options.watchlistName, exported = csv, status = 200 } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  // Every request is intercepted: these checks never contact Screener or log in.
  await context.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    assert.equal(route.request().method(), 'GET', 'inventory must be read-only');
    if (path === '/api/export/screen/') return route.fulfill({
      contentType: 'text/csv', headers: { 'content-disposition': 'attachment; filename="watchlist.csv"' }, body: exported,
    });
    const body = path.startsWith('/user/stocks/')
      ? `<h1>Add companies to ${title}</h1>${management}<ul>${rows}</ul>`
      : `<a href="/user/stocks/99000001/?next=/watchlist/99000001/">Companies</a>${table}${form}`;
    return route.fulfill({ status, contentType: 'text/html', body });
  });
  try { return await readWatchlistInventory(page, options); }
  finally { await context.close(); }
}

try {
  assert.deepEqual(await inventory(), { current: [], manageRows: [] }, 'a verified new watchlist needs no export');
  const populated = await inventory({ rows: company, form: exportForm });
  assert.equal(populated.current[0].isin, 'INE000A01001', 'populated lists must still read the downloaded export');
  assert.equal(populated.manageRows[0].companyId, '11');
  const spanOnly = await inventory({ rows: company.replace('<a href="/company/ALPHA/">Alpha Ltd</a>', '<span class="shrink-text">Alpha Ltd</span>'), form: exportForm });
  assert.equal(spanOnly.manageRows[0].name, 'Alpha Ltd');
  assert.equal(matchRemovalButtons(spanOnly.current, spanOnly.manageRows)[0].companyId, '11');
  assert.equal(watchlistFailureReason(Error('Export and manage counts differ')), 'inventory-count');
  assert.equal(watchlistFailureReason(Error('account-secret@example.test / private holding')), 'unclassified', 'unexpected errors never enter public diagnostics');
  await assert.rejects(inventory({ rows: company }), /Nonempty watchlist export/);
  await assert.rejects(inventory({ table: '<a href="/company/ALPHA/">Alpha</a>' }), /Nonempty watchlist export/);
  await assert.rejects(inventory({ rows: '<a href="/company/ALPHA/">Alpha</a>' }), /Nonempty watchlist export/);
  await assert.rejects(inventory({ management: '' }), /management controls/);
  await assert.rejects(inventory({ title: 'Different watchlist' }), /identity/);
  await assert.rejects(inventory({ rows: company.replace("'11'", '11') }), /Unrecognized company removal/);
  await assert.rejects(inventory({ rows: company, form: exportForm.replace('99000001', '99000002') }), /export target/);
  await assert.rejects(inventory({ form: exportForm }), /counts differ/);
  await assert.rejects(inventory({ rows: company, form: exportForm + exportForm }), /Ambiguous/);
  await assert.rejects(inventory({ rows: company + company, form: exportForm }), /Unrecognized/);
  await assert.rejects(inventory({ rows: company, form: exportForm, exported: 'x'.repeat(8 * 1024 * 1024 + 1) }), /oversized/);
  await assert.rejects(inventory({ status: 503 }), /page unavailable/);
  console.log('Screener inventory browser checks passed: empty, populated, unavailable export, identity and count guards.');
} finally {
  await browser.close();
}
