import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { companyMarketLookup, projectCompanyQuotes } from '../public/js/data/company-market-shared.js';
import { parseMarketCapScreen, parseMarketCapCompany } from './lib/market-caps.mjs';
import { handleTechnicals } from '../worker/breakouts.mjs';
import { writeCompanyQuotes } from './lib/company-quotes.mjs';

const stamp = '2026-10-21T10:00:00Z', isin = 'INE000000001', bseIsin = 'INE000000002';
const technicals = { generated_at: stamp, companies: [{ ticker: 'ALPHA', cmp: 120, bar_date: '2026-10-19', quantity: 999 },
  { ticker: 'BAD', cmp: 0, bar_date: null }] };
const quotes = projectCompanyQuotes(technicals);
assert.equal(quotes.rows[0].price_date, '2026-10-19');
assert.equal(quotes.rows[1].cmp, null);
assert(!JSON.stringify(quotes).includes('quantity'));
const marketCaps = { version: 1, entries: [{ ticker: 'ALPHA', isin, exchanges: ['NSE'], bseCode: '500001', cr: 900, checkedAt: stamp },
  { ticker: 'COLLISION', isin: bseIsin, exchanges: ['BSE'], bseCode: '500002', cr: 80, checkedAt: stamp,
    cmp: 23, cmpCheckedAt: stamp, cmpPriceDateLabel: '21 Oct - close price' }] };
const sharesStamp = '2026-10-19T10:00:00Z';
const lookup = companyMarketLookup({ quotes, marketCaps, now: () => Date.parse(sharesStamp), tickerMap: { map: { A: { ticker: 'ALPHA', shares: 100_000_000, sharesCheckedAt: sharesStamp } } } });
const priceInfo = company => ({ price: company.cmp, label: `Daily close · ${company.price_date}`, at: null });
const alpha = lookup.read({ ticker: 'ALPHA', isin }, priceInfo);
assert.equal(alpha.cmp, 120); assert.equal(alpha.mcapCr, 1200);
assert.match(alpha.quoteLabel, /Daily close · 2026-10-19/);
assert.match(alpha.mcapLabel, /shares outstanding .*observed 2026-10-19.*× CMP/);
assert.equal(lookup.read({ ticker: 'ALPHA', cmp: 110, price_date: '2026-10-19' }, priceInfo).mcapCr, 1100, 'existing screen CMP and its added cap share one price');
assert.equal(lookup.read({ ticker: 'ALPHA', marketQuote: { price: 77, date: '2026-10-19', label: 'CMP shown' } }, priceInfo).mcapCr, 770, 'a dated source-specific CMP controls the added derived cap');
assert.equal(lookup.read({ ticker: 'ALPHA', marketQuote: { price: null, label: 'CMP unavailable' } }, priceInfo).mcapCr, 900, 'a missing displayed price uses the dated source cap, not a hidden price');
assert.equal(lookup.read({ ticker: 'ALPHA', isin, mcapCr: 900, mcapAsOf: '2026-10-16' }, priceInfo).mcapCr, 900, 'captured range filters and displayed cap agree');
assert.equal(lookup.read({ ticker: 'ALPHA', isin: 'INE999999999' }, priceInfo).cmp, null, 'conflicting ISIN cannot borrow a ticker price');
assert.equal(lookup.read({ ticker: 'ALPHA', isin: bseIsin, mcapCr: 12345 }, priceInfo).mcapCr, null, 'conflicting valid identifiers withhold even a supplied cap');
assert.equal(lookup.read({ ticker: 'ALPHA', bseCode: '500002' }, priceInfo).cmp, null, 'a valid BSE code cannot silently override another ticker');
assert.equal(lookup.read({ isin, bseCode: '500002' }, priceInfo).cmp, null, 'conflicting ISIN and BSE code cannot join');
assert.equal(lookup.read({ name: 'Alpha' }, priceInfo).cmp, null, 'names never imply exchange identity');
assert.equal(lookup.read({ ticker: 'UNKNOWN' }, priceInfo).mcapCr, null);
assert.equal(lookup.read({ isin: bseIsin, ticker: 'COLLISION' }, priceInfo).cmp, 23, 'BSE-only exact ISIN can read its own saved price');
assert.match(lookup.read({ isin: bseIsin }, priceInfo).quoteLabel, /21 Oct - close price · checked/);
assert.equal(lookup.read({ entityId: `isin:${bseIsin}` }, priceInfo).cmp, 23, 'tickerless retained alerts resolve their canonical ISIN identity');
assert.equal(lookup.read({ ticker: 'COLLISION' }, priceInfo).cmp, null, 'BSE-only display symbol is not an NSE identifier');
const collidingDaily = companyMarketLookup({ quotes: { rows: [{ ticker: 'COLLISION', cmp: 999, price_date: '2026-10-19' }] }, marketCaps });
assert.equal(collidingDaily.read({ ticker: 'COLLISION' }, priceInfo).cmp, null, 'a BSE-only display symbol cannot borrow an unrelated daily observation');
assert.equal(lookup.read({ scripCode: '500002' }, priceInfo).mcapCr, 80);
const bseQuotes = companyMarketLookup({ marketCaps, quotes: { rows: [{ ticker: '500002', cmp: 491.9, price_date: '2026-10-19' }] } });
assert.equal(bseQuotes.read({ isin: bseIsin }, priceInfo).cmp, 491.9, 'exact BSE ISIN reads its namespaced daily code');
assert.equal(bseQuotes.read({ bseCode: '500002' }, priceInfo).cmp, 491.9);
const undatedShares = companyMarketLookup({ quotes, marketCaps, tickerMap: { generated_at: stamp, map: { A: { ticker: 'ALPHA', shares: 100_000_000 } } } });
assert.equal(undatedShares.read({ ticker: 'ALPHA' }, priceInfo).mcapCr, 900, 'file generation time cannot date an old share count');
const agedShares = companyMarketLookup({ quotes, marketCaps, now: () => Date.parse(stamp), tickerMap: { map: { A: { ticker: 'ALPHA', shares: 100_000_000, sharesCheckedAt: sharesStamp } } } });
assert.equal(agedShares.read({ ticker: 'ALPHA' }, priceInfo).mcapCr, 900, 'a dated but old share count uses the captured cap');
assert.equal(lookup.read({ ticker: 'ALPHA', isin }, () => ({ price: 140, label: 'Saved · source quote time', at: sharesStamp })).mcapCr, 1400);
assert.equal(lookup.read({ ticker: 'ALPHA', isin }, () => ({ price: 140, label: 'Newer quote', at: stamp })).mcapCr, 900, 'old share counts cannot be combined with a later session');
mkdirSync('.cache/company-market', { recursive: true });
const retainedPath = '.cache/company-market/retained-quotes.json';
writeCompanyQuotes(technicals, retainedPath);
const failedCapture = { generated_at: '2026-10-22T03:00:00Z', companies: [{ ticker: 'ALPHA', error: 'Price source unavailable' }] };
writeCompanyQuotes(failedCapture, retainedPath);
const retained = JSON.parse(readFileSync(retainedPath));
assert.equal(retained.rows.find(row => row.ticker === 'ALPHA').cmp, 120);
assert.equal(retained.rows.find(row => row.ticker === 'ALPHA').price_date, '2026-10-19');
assert.equal(retained.rows.find(row => row.ticker === 'ALPHA').attemptedAt, failedCapture.generated_at);
assert.match(retained.rows.find(row => row.ticker === 'ALPHA').error, /source unavailable/);
const reopened = companyMarketLookup({ quotes: retained });
assert.equal(reopened.read({ ticker: 'ALPHA' }, priceInfo).cmp, 120, 'a new session retains the last good quote after a per-company failure');
assert.match(reopened.read({ ticker: 'ALPHA' }, priceInfo).quoteLabel, /Retained.*2026-10-19/);

const screen = `<html><p>1 results found: Showing page 1 of 1</p><textarea name="query">Market Capitalization &gt;1</textarea>
<table class="data-table"><tr><th>S.No.</th><th>Company</th><th data-tooltip="Current Price">CMP Rs.</th><th data-tooltip="Market Capitalization">Market cap Rs.Cr.</th></tr>
<tr data-row-company-id="1"><td>1</td><td><a href="/company/ALPHA/">Alpha</a></td><td>1,234.50</td><td>9,000</td></tr></table></html>`;
assert.equal(parseMarketCapScreen(screen).rows[0].cmp, 1234.5);
assert.equal(parseMarketCapScreen(screen.replace('CMP Rs.', 'CMP USD')).rows[0].cmp, null, 'different currencies are not rupees');
assert.equal(parseMarketCapScreen(screen.replace('CMP Rs.', 'CMP Rs.Cr.')).rows[0].cmp, null, 'price units must be rupees, not crore');
const companyPage = `<html><div id="top"><a href="https://www.nseindia.com/get-quotes/equity?symbol=ALPHA">NSE</a>
<li>Market Cap ₹ <span>9,000</span> Cr.</li><li>Current Price ₹ <span>1,234.50</span></li><div class="ink-600 font-size-11 font-weight-500">21 Oct - close price</div></div><div id="chart"></div></html>`;
assert.equal(parseMarketCapCompany(companyPage, marketCaps.entries[0], stamp).cmp, 1234.5);

const revision = 'a'.repeat(40), paths = [];
const fetcher = async url => {
  paths.push(String(url));
  if (String(url).includes('api.github.com')) return Response.json([{ sha: revision }]);
  assert(String(url).endsWith(`/${revision}/public/data/company-quotes.json`));
  return Response.json(quotes);
};
const request = new Request('https://sattva.test/api/technicals/prices');
const response = await handleTechnicals(request, {}, { fetcher, edgeCache: null });
assert.equal(response.status, 200); assert.deepEqual(await response.json(), quotes);
assert.equal(response.headers.get('x-sattva-revision'), revision);
const fallbackPaths = [];
const fallback = await handleTechnicals(request, { ASSETS: { fetch: async req => { fallbackPaths.push(new URL(req.url).pathname); return Response.json(quotes); } } },
  { fetcher: async () => { throw Error('offline'); }, edgeCache: null });
assert.deepEqual(await fallback.json(), quotes); assert.deepEqual(fallbackPaths, ['/data/company-quotes.json']);
assert.equal(fallback.headers.get('cache-control'), 'no-store');
assert.equal((await handleTechnicals(new Request(request, { method: 'POST' }), {}, { fetcher })).status, 405);
const committed = JSON.parse(readFileSync('public/data/company-quotes.json'));
assert(committed.rows.length > 500 && readFileSync('public/data/company-quotes.json').length < 150_000);
console.log('PASS identity-safe CMP/cap, dates, unknowns, source units, compact projection, pinned route and read-only fallback.');
