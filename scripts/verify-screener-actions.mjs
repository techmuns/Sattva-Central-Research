#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mergeCorporateActionRows,
  mergeScreenerActionRows,
  normaliseNseCorporateActions,
  screenerActionDetails,
  validateScreenerActionRows,
} from '../public/js/data/corporate-actions-shared.js';
import { parseScreenerActionPage, screenerActionDay } from './lib/screener-actions.mjs';

const observedAt = '2026-09-05T01:00:00.000Z';
const table = (rows, totalLabel, pages = 1) => `<!doctype html><main><table id="result_list"><tbody>${rows}</tbody></table>${pages > 1 ? `<a href="?p=${pages}">${pages}</a>` : ''}<p>${totalLabel}</p></main>`;
const company = (ticker, name) => `<th class="field-company_display"><a href="/company/${ticker}/consolidated/"></a><a href="/company/${ticker}/consolidated/">${name}</a></th>`;

assert.equal(screenerActionDay('4 September 2026'), '2026-09-04');
assert.equal(screenerActionDay('29 February 2023'), null);

const dividendHtml = table(`
  <tr>${company('ALPHA', 'Alpha Ltd')}<td>4 September 2026</td><td>Interim</td><td>250.00</td></tr>
  <tr>${company('GAMMA', 'Gamma Ltd')}<td>5 September 2026</td><td>Final</td><td>100.00</td></tr>`, '2 dividends');
const dividend = parseScreenerActionPage(dividendHtml, { kind: 'dividend', observedAt, catalogueKey: 'dividend:2026' });
assert.equal(dividend.publishedTotal, 2);
assert.equal(dividend.rows[0].ticker, 'ALPHA');
assert.equal(dividend.rows[0].dividendType, 'Interim');
assert.equal(screenerActionDetails(dividend.rows[0]), 'Interim · 250.00%');
const legacy = parseScreenerActionPage(table(
  '<tr><th class="field-company_display"><a href="/company/id/992580/"></a><a href="/company/id/992580/">Apollo Tricoat</a></th><td>16 September 2021</td><td>1:1</td></tr>',
  '1 bonuses',
), { kind: 'bonus', observedAt });
assert.equal(legacy.rows[0].companyKey, 'ID:992580');
assert.equal(legacy.rows[0].ticker, null);

const rights = parseScreenerActionPage(table(
  `<tr>${company('BETA', 'Beta Ltd')}<td>10 September 2026</td><td>5.00</td><td>2:5</td></tr>`,
  '26 rights', 2,
), { kind: 'right', observedAt });
assert.equal(rights.lastPage, 2);
assert.deepEqual([rights.rows[0].premium, rights.rows[0].ratio], ['5.00', '2:5']);

const empty = parseScreenerActionPage(table('', '0 dividends'), { kind: 'dividend', observedAt, catalogueKey: 'dividend:2027' });
assert.deepEqual(empty.rows, []);
assert.deepEqual(parseScreenerActionPage('<main><p>0 results (35313 total)</p><p>0 dividends</p></main>', { kind: 'dividend', observedAt }), { rows: [], publishedTotal: 0, lastPage: 1 });

const nse = normaliseNseCorporateActions([
  { symbol: 'ALPHA', comp: 'Alpha Ltd', isin: 'INE000A01001', series: 'EQ', subject: 'Interim Dividend - Rs 2.50 Per Share', faceVal: '10', exDate: '04-Sep-2026', recDate: '04-Sep-2026' },
]);
const merged = mergeCorporateActionRows(nse.rows, dividend.rows);
assert.equal(merged.length, 2, 'one exact source pair becomes one row while a Screener-only action remains');
const alpha = merged.find((row) => row.ticker === 'ALPHA');
assert.deepEqual(alpha.sources, ['NSE', 'Screener']);
assert.equal(alpha.purpose, 'Interim Dividend - Rs 2.50 Per Share', 'the official NSE purpose remains unchanged');
assert.equal(alpha.screener.dividendType, 'Interim');
assert.equal(merged.find((row) => row.ticker === 'GAMMA').source, 'Screener');
assert.equal(mergeCorporateActionRows(nse.rows, mergeScreenerActionRows(dividend.rows, dividend.rows)).length, 2, 'repeat collection is idempotent');

const ambiguousNse = normaliseNseCorporateActions([
  { symbol: 'BETA', comp: 'Beta Ltd', series: 'EQ', subject: 'Rights 2:5', exDate: '10-Sep-2026' },
  { symbol: 'BETA', comp: 'Beta Ltd', series: 'BE', subject: 'Rights issue - partly paid', exDate: '10-Sep-2026' },
]);
const ambiguous = mergeCorporateActionRows(ambiguousNse.rows, rights.rows);
assert.equal(ambiguous.length, 3, 'an ambiguous cross-source match remains separate instead of guessing');
assert.equal(ambiguous.filter((row) => row.source === 'NSE + Screener').length, 0);
validateScreenerActionRows([...dividend.rows, ...rights.rows]);
assert.throws(() => validateScreenerActionRows([{ ...rights.rows[0], companyUrl: 'https://evil.example/company/BETA/' }]));

const workflow = readFileSync(new URL('../.github/workflows/corporate-actions-refresh.yml', import.meta.url), 'utf8');
const collector = readFileSync(new URL('./scrape-corporate-actions.mjs', import.meta.url), 'utf8');
assert.match(workflow, /cron: "\*\/15 \* \* \* \*"/);
assert.match(workflow, /SCREENER_USERNAME/);
assert.match(workflow, /SCREENER_FULL_REFRESH/);
assert.match(workflow, /playwright@1\.62\.1/);
assert.match(collector, /page\.goto\(catalogueUrl\(catalogue, number\)\.href/);
assert.doesNotMatch(collector, /context\.request/, 'every history page retains the authenticated browser fingerprint');
assert.match(collector, /failureCatalogue.*failurePage.*failureCode/s, 'safe operational logs identify the rejected fixed catalogue page');
assert.match(collector, /row\.exDate < requestedFrom/, 'a full crawl stops only after crossing the retained rolling-window boundary');

console.log('PASS Screener action parsing, retained fields, conservative cross-source deduplication and refresh schedule');
