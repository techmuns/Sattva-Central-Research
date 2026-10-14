#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseMarketCapScreen, parseMarketCapCompany, marketCapDirectoryChecks } from './lib/market-caps.mjs';
import { buildCompanyProfiles, inMcapRange, parseMcapRange, formatMarketCap, marketCapPriceDate } from '../public/js/data/company-profile.js';
import { profileTable, mergeProfileLookups } from '../public/js/data/company-profile-table.js';

const stamp = '2026-10-13T12:00:00Z';
const entities = [
  { isin: 'INE002A01018', ticker: 'MAIN', exchanges: ['NSE'] },
  { isin: 'INE0V9N01017', ticker: 'PRIZOR', exchanges: ['NSE'] },
  { isin: 'INE658D01029', ticker: 'SIMPLEXCAS', bseCode: '513472', exchanges: ['BSE'] },
];
const row = (key, cr) => `<tr data-row-company-id="123"><td>1</td><td><a href="/company/${key}/">Company</a></td><td>${cr}</td></tr>`;
const screen = ({ page = 1, total = 25, keys = ['MAIN', 'PRIZOR', '513472'], cap = 1000 } = {}) => `<html>
  <div>${total} results found: Showing page ${page} of ${Math.ceil(total / 25)}</div>
  <table class="data-table"><thead><tr><th>S.No.</th><th>Company</th><th data-tooltip="Market Capitalization">Mar Cap Rs.Cr.</th></tr></thead>
  <tbody>${Array.from({ length: Math.min(25, total - (page - 1) * 25) }, (_, i) => row(keys[i] || `OTHER${i}`, cap)).join('')}</tbody></table>
  <textarea name="query">Market Capitalization &gt;1</textarea></html>`;
const page = (key = 'PRIZOR', value = '1,468') => `<html><div id="top"><a href="https://www.nseindia.com/get-quotes/equity?symbol=${key}">NSE</a>
  <div class="ink-600 font-size-11 font-weight-500">13 Oct - close price</div>
  <ul><li>Sector Market Cap ₹ <span class="number">99,999</span> Cr.</li><li>Market Cap ₹ <span class="number">${value}</span> Cr.</li></ul></div><div id="chart"></div></html>`;

const parsed = parseMarketCapScreen(screen({ keys: ['M&amp;M', 'id/1286263/consolidated', '513472'] }));
assert.equal(parsed.rows[0].key, 'M&M');
assert.equal(parsed.rows[1].key, 'ID:1286263'); // An unlisted source ID cannot become an NSE symbol/BSE code.
assert.equal(parsed.rows[2].cr, 1000);
assert.equal(formatMarketCap(0.01), '₹0.01 Cr', 'a positive small cap must not display as zero');
assert.throws(() => parseMarketCapScreen(screen().replace('Rs.Cr.', 'Rs.Lakh')), /units/);
assert.throws(() => parseMarketCapScreen(screen().replace('&gt;1', '&gt;1000')), /query/);
assert.throws(() => parseMarketCapScreen(screen().replace(row('MAIN', 1000), '')), /incomplete screen page/);
assert.throws(() => parseMarketCapScreen(screen().replace('</html>', '')), /incomplete/);
assert.equal(parseMarketCapScreen(screen({ cap: 1 })).rows[0].cr, 1, 'a >₹1 Cr source value can round to ₹1.00 Cr');
const figure = parseMarketCapCompany(page(), entities[1], stamp);
assert.equal(figure.cr, 1468);
assert.equal(figure.priceDateLabel, '13 Oct - close price');
assert.equal(figure.checkedAt, stamp);
assert.equal(marketCapPriceDate('13 Oct - close price'), null);
assert.equal(marketCapPriceDate('08 Jun 2016'), '2016-06-08');
assert.equal(marketCapPriceDate('31 Jun 2016'), null);
const oldPage = page().replace('13 Oct - close price', '08 Jun 2016');
assert.equal(parseMarketCapCompany(oldPage, entities[1], stamp).priceAsOf, '2016-06-08');
assert.throws(() => parseMarketCapCompany(page().replace('13 Oct - close price', '14 Oct 2027'), entities[1], stamp), /future/);
assert.throws(() => parseMarketCapCompany(page('OTHER'), entities[1], stamp), /identity/);
assert.throws(() => parseMarketCapCompany(page().replace('Market Cap ₹ <span class="number">1,468', 'Unknown ₹ <span class="number">1,468'), entities[1], stamp), /unavailable/);

const marketCaps = { version: 1, entries: entities.map((e, i) => ({ ...e, cr: i === 1 ? 1468 : 567.89, checkedAt: stamp })) };
const profiles = buildCompanyProfiles({ marketCaps, technicals: { price_date: '2026-10-12', companies: [{ ticker: 'PRIZOR', marketCap: 100 }] } });
assert.equal(profiles.profileOf(entities[1]).mcapCr, 1468);
assert.equal(profiles.profileOf({ bseCode: '513472' }).mcapCr, 567.89);
assert.equal(profiles.profileOf(entities[2]).mcapCr, 567.89);
assert.equal(profiles.profileOf({ ticker: 'SIMPLEXCAS', entityId: `isin:${entities[2].isin}` }).mcapCr, 567.89, 'news entity IDs retain exact BSE-only identity');
assert.equal(profiles.profileOf({ ticker: 'SIMPLEXCAS' }).mcapCr, null, 'a BSE-only symbol cannot identify another NSE issuer');
assert.equal(buildCompanyProfiles({ marketCaps }).profileOf({ ticker: 'PRIZOR', isin: 'INE002A01018' }).mcapCr, 567.89, 'exact ISIN wins over a conflicting symbol');
assert.equal(buildCompanyProfiles({ marketCaps }).profileOf({ ticker: 'PRIZOR', isin: 'INE999A01018' }).mcapCr, null, 'a conflicting unknown ISIN cannot borrow a symbol cap');
assert.equal(profiles.profileOf(entities[1]).mcapAsOf, null, 'observation time is never an invented price date');
assert.match(profiles.profileOf(entities[1]).mcapSource, /checked 2026-10-13/);
assert(inMcapRange(profiles.profileOf(entities[1]).mcapCr, parseMcapRange('small')));
assert(!inMcapRange(profiles.profileOf(entities[1]).mcapCr, parseMcapRange('unknown')));
assert.equal(buildCompanyProfiles({ marketCaps, technicals: { price_date: '2026-10-14', companies: [{ ticker: 'PRIZOR', marketCap: 1500, marketCapAsOf: '2026-10-14' }] } }).profileOf(entities[1]).mcapCr, 1500);
assert.equal(buildCompanyProfiles({ marketCaps, technicals: { price_date: '2026-10-14', companies: [{ ticker: 'PRIZOR', marketCap: 1500 }] } }).profileOf(entities[1]).mcapCr, 1468, 'Yahoo bar dates cannot make an old Screener export newer');
assert.equal(buildCompanyProfiles({ technicals: { price_date: '2026-10-14', companies: [{ ticker: 'PRIZOR', marketCap: 1500 }] } }).profileOf(entities[1]).mcapAsOf, null);
assert.equal(buildCompanyProfiles({ marketCaps: { version: 1, entries: [{ ...entities[1], cr: 0, checkedAt: stamp }] } }).profileOf(entities[1]).mcapCr, null);
const datedCapture = { version: 1, entries: [{ ...entities[1], cr: 0.34, checkedAt: stamp, priceDateLabel: '08 Jun 2016', priceAsOf: '2016-06-08' }] };
assert.equal(buildCompanyProfiles({ marketCaps: datedCapture }).profileOf(entities[1]).mcapAsOf, '2016-06-08');
assert.equal(buildCompanyProfiles({ marketCaps: datedCapture, technicals: { companies: [{ ticker: 'PRIZOR', marketCap: 1700, marketCapAsOf: '2025-12-31' }] } }).profileOf(entities[1]).mcapCr, 1700, 'old prices cannot override a genuinely newer dated figure');
const table = profileTable({ builtAt: stamp, rows: [
  ['SEL', '500371', entities[0].isin, 11.33, 'micro', 'real_estate'],
  ['SEL', null, entities[1].isin, 73.94, 'micro', 'capital_goods'],
] });
assert.equal(table.profileOf({ ticker: 'SEL', isin: entities[1].isin }).mcapCr, 73.94);
assert.equal(table.profileOf({ ticker: 'SEL', bseCode: '500371' }).mcapCr, 11.33);
assert.equal(table.profileOf({ ticker: 'SEL' }).mcapCr, null, 'a colliding symbol has no unqualified owner');
assert.equal(table.profileOf({ ticker: 'SEL', isin: 'INE999A01018' }).mcapCr, null);
assert.equal(table.profileOf({ ticker: 'SEL', entityId: `isin:${entities[1].isin}` }).mcapCr, 73.94);
const directory = { source: 'reference-files', builtAt: stamp, profileOf: profiles.profileOf };
const combined = mergeProfileLookups(table, directory);
assert.equal(combined.profileOf(entities[2]).mcapCr, 567.89, 'an index absent issuer still receives its directory cap');
assert.equal(combined.profileOf({ ticker: 'SEL', isin: entities[1].isin }).mcapCr, 73.94, 'saved index values survive a partial directory');
assert.equal(combined.profileOf({ ticker: 'SEL', entityId: `isin:${entities[0].isin}` }).mcapCr, 11.33);
assert.equal(combined.profileOf({ ticker: 'SEL', entityId: `isin:${entities[1].isin}` }).mcapCr, 73.94, 'the memoized lookup separates colliding entity IDs');
const verified = marketCapDirectoryChecks({ capturedAt: stamp }, { attemptedAt: '2026-10-14T00:00:00Z', directories: { equity: { checkedAt: stamp }, sme: { checkedAt: '2026-10-01T00:00:00Z', error: 'HTTP 503' } } });
assert.equal(verified.nse.sme.checkedAt, '2026-10-01T00:00:00Z');
assert.equal(verified.nse.sme.error, 'HTTP 503');
assert.notEqual(verified.nse.sme.checkedAt, verified.nse.attemptedAt);

// Real CLI checkpoints with entirely local fetch responses. No upstream, secret or production write.
const tmp = mkdtempSync(join(tmpdir(), 'market-cap-contract-'));
try {
  mkdirSync(join(tmp, 'filing-capture'));
  writeFileSync(join(tmp, 'announcement-identities.json'), JSON.stringify({ capturedAt: stamp, entries: [{ ...entities[2], name: 'Simplex Castings Ltd', bseSymbol: 'SIMPLEXCAS', status: 'Active' }] }));
  writeFileSync(join(tmp, 'filing-capture/nse-identities.json'), JSON.stringify({ attemptedAt: stamp, directories: {
    equity: { checkedAt: stamp, entries: [{ ...entities[0], name: 'Main Ltd' }] }, sme: { checkedAt: stamp, entries: [{ ...entities[1], name: 'Prizor Viztech Ltd' }] },
  } }));
  const delisted = { isin: 'INE888A01018', ticker: 'OLD', cr: 42, checkedAt: stamp };
  writeFileSync(join(tmp, 'market-caps.json'), JSON.stringify({ entries: [...marketCaps.entries, delisted] }));
  const shim = join(tmp, 'fetch.mjs');
  writeFileSync(shim, `import fs from 'node:fs';
    const fixture=JSON.parse(fs.readFileSync(process.env.MARKET_CAP_FIXTURE));
    globalThis.fetch=async url=>{const u=new URL(url),page=+(u.searchParams.get('page')||1); const body=u.pathname.startsWith('/company/')?fixture.company:fixture[page];
      if(!body) throw Error('unexpected request '+url);
      return typeof body==='number'?new Response('',{status:body}):new Response(body,{headers:{'content-type':'text/html'}});};`);
  function run(fixture) {
    const path = join(tmp, 'responses.json'); writeFileSync(path, JSON.stringify(fixture));
    const result = spawnSync(process.execPath, ['--import', shim, resolve('scripts/collect-market-caps.mjs')], {
      env: { ...process.env, MARKET_CAP_DATA_DIR: tmp, MARKET_CAP_FIXTURE: path, MARKET_CAP_MAX_MS: '10000' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(join(tmp, 'market-caps.json')));
  }
  const partial = run({ 1: screen({ total: 50, keys: ['MAIN'], cap: 2000 }), 2: 429 });
  assert.equal(partial.coverage.screenComplete, false);
  assert.equal(partial.coverage.refused, true);
  assert.equal(partial.entries.find(e => e.ticker === 'PRIZOR').cr, 1468);
  assert.equal(partial.entries.find(e => e.ticker === 'PRIZOR').checkedAt, stamp, 'source refusal retains the last observation time');
  assert(partial.entries.some(e => e.isin === delisted.isin), 'delisted capture history survives');
  // Simulate the next scheduled attempt after the persisted cooldown has expired.
  partial.coverage.retryAt = '1970-01-01T00:00:00Z';
  writeFileSync(join(tmp, 'market-caps.json'), JSON.stringify(partial));
  const recovered = run({ 1: screen({ cap: 1550.12 }) });
  assert.equal(recovered.coverage.known, 3);
  assert.equal(recovered.coverage.checked, 3);
  assert.equal(recovered.coverage.screenComplete, true);
  assert.equal(recovered.coverage.refused, false);
  assert.equal(recovered.entries.find(e => e.ticker === 'PRIZOR').cr, 1550.12);
  assert(recovered.entries.some(e => e.isin === delisted.isin));
  const oldCheck = recovered.entries.find(e => e.ticker === 'PRIZOR').checkedAt;
  const failedPage = run({ 1: screen({ keys: ['MAIN', '513472'] }), company: 404 });
  const saved = failedPage.entries.find(e => e.ticker === 'PRIZOR');
  assert.equal(saved.cr, 1550.12);
  assert.equal(saved.checkedAt, oldCheck);
  assert.equal(saved.error, 'HTTP 404');
  assert.equal(saved.checkState, 'failed');
  assert.equal(failedPage.coverage.directRead, 1);
  assert.equal(failedPage.coverage.directFailures, 1);
  assert.equal(failedPage.coverage.directUnavailable, 0);
  assert.match(buildCompanyProfiles({ marketCaps: failedPage }).profileOf(entities[1]).mcapSource, /latest check failed/);
  const pageRecovery = run({ 1: screen({ keys: ['MAIN', '513472'] }), company: page() });
  const refreshed = pageRecovery.entries.find(e => e.ticker === 'PRIZOR');
  assert.equal(refreshed.cr, 1468);
  assert.equal(refreshed.priceDateLabel, '13 Oct - close price');
  assert.equal(refreshed.error, null);
  const noFigure = page().replace('Market Cap ₹ <span class="number">1,468', 'Unknown ₹ <span class="number">1,468');
  const unavailable = run({ 1: screen({ keys: ['MAIN', '513472'] }), company: noFigure });
  assert.equal(unavailable.entries.find(e => e.ticker === 'PRIZOR').checkState, 'unavailable');
  assert.equal(unavailable.coverage.directFailures, 0);
  assert.equal(unavailable.coverage.directUnavailable, 1);
  assert.equal(unavailable.coverage.checked, 3, 'verified pages without figures count as completed source checks');
  assert.equal(unavailable.coverage.refreshedFigures, 2);
  assert.equal(unavailable.coverage.attempted, 3);
  const transport = run({ 1: screen({ keys: ['MAIN', '513472'] }), company: 503 });
  assert.equal(transport.coverage.directFailures, 1, 'a finished walk with a transport failure remains partial');
  assert.equal(transport.coverage.checked, 2);
  assert.equal(transport.coverage.attempted, 3);
  assert.equal(transport.coverage.directRead, transport.coverage.directTotal);
  assert.equal(transport.coverage.screenComplete, true);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log('PASS market-cap units, exchange identities, sector rejection, source dates, ranges, retained checkpoints and refusal recovery.');
