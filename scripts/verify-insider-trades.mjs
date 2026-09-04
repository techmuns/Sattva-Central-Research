#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeInsiderTrades, insiderTradeIdentity } from '../public/js/data/insider-history.js';
import { normaliseInsiderTrades } from '../public/js/data/filings-shared.js';
import { mergeLastGoodFilings } from './lib/filings-snapshot.mjs';
import { buildScreenerTradesSnapshot, hasScreenerTradeOverlap, normaliseScreenerTrade, SCREENER_TRADE_SOURCES } from './lib/screener-trades.mjs';
import { fetchInsiderTrades } from '../worker/muns.mjs';
import { createFeed } from '../public/js/data/filings.js';
import { clearAll, readEntry, writeEntry, KEYS } from '../public/js/core/store.js';

const now = Date.now();
const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
const trade = (name, source = 'NSE', date = day(-1)) => ({
  ticker: 'TEST', date, cells: { Insider: name, Transaction: 'Acquisition', 'Trade Shares': '100', Source: source },
});
const a = trade('Alice');
const b = trade('Bob');
const c = trade('Carol', 'Trendlyne');
const expired = trade('Expired', 'NSE', day(-366));
const unknown = trade('Undated', 'BSE', null);
const window = { from: day(-365), to: day(0) };
const reordered = { ...a, raw: a.cells, cells: Object.fromEntries(Object.entries(a.cells).reverse()) };
const merged = mergeInsiderTrades([a, a, b, expired, unknown], [reordered, c], window);
assert.equal(merged.length, 4, 'overlapping responses retain distinct events once');
assert.equal(merged.filter((r) => r.cells.Insider === 'Alice').length, 1);
assert.deepEqual(mergeInsiderTrades(merged, [reordered, c], window), merged, 'repeat fetches are idempotent');
assert.equal(mergeInsiderTrades([a], [a, a, a], window).length, 1, 'identical disclosures are not repeated');
assert.equal(mergeInsiderTrades([a], [trade('Alice', 'BSE')], window).length, 1, 'the same exchange disclosure is not doubled by provider labels');
assert.equal(mergeInsiderTrades([a], [{ ...a, cells: { ...a.cells, Transaction: 'Disposal' } }], window).length, 2);
assert.equal(mergeInsiderTrades([], [trade('Boundary', 'NSE', day(-365)), trade('Future', 'NSE', day(1))], window).length, 1);
const afterEmpty = mergeInsiderTrades([a, unknown], [], window);
assert.equal(afterEmpty.length, 2, 'empty responses cannot retract captured trades');
assert(afterEmpty.every((row) => row.cells['Trade Category'] === 'Insider trade'), 'legacy rows gain the implicit Screener category');

const old = {
  kind: 'insider', capturedAt: new Date(now - 86400000).toISOString(), headers: ['Insider', 'Legacy'],
  byTicker: { TEST: [a, b, expired], EMPTY: [a], FAILED: [b], UNREACHED: [c] }, empty: [],
};
const next = {
  kind: 'insider', capturedAt: new Date(now).toISOString(), ...window, headers: ['Insider', 'New'],
  byTicker: { TEST: [a, c] }, empty: ['EMPTY'], failed: { FAILED: { reason: 'timeout' } },
};
const retained = mergeLastGoodFilings(next, old, ['TEST', 'EMPTY', 'FAILED']);
assert.deepEqual(retained.byTicker.TEST.map((row) => row.cells.Insider), ['Alice', 'Bob', 'Carol']);
assert.deepEqual(retained.byTicker.EMPTY.map((row) => row.cells.Insider), ['Alice'], 'a successful empty capture keeps prior events');
assert.deepEqual(retained.empty, []);
assert.deepEqual(retained.byTicker.UNREACHED.map((row) => row.cells.Insider), ['Carol'], 'narrow captures preserve prior company coverage');
assert.equal(retained.fallbackCount, 2);
assert.equal(retained.fallback.FAILED.capturedAt, old.capturedAt);
assert.equal(retained.freshCovered, 2);
assert.equal(retained.rowCount, 6);
assert(retained.headers.includes('Legacy') && retained.headers.includes('New') && retained.headers.includes('Source'));
assert.equal(old.byTicker.TEST.length, 3, 'merge does not mutate the prior snapshot');
assert.equal(next.byTicker.TEST.length, 2);
assert.equal(mergeLastGoodFilings({ ...next, byTicker: { TEST: [expired] }, empty: [], failed: {} }, null, ['TEST']).rowCount, 0);

// The four Screener listings share a five-cell table but not the same cell semantics.
const extracted = (ticker, company, person, date, type, value) => ({
  pageUrl: 'https://www.screener.in/trades/example/?o=-2',
  cells: [
    { text: company, lines: [company], links: [{ href: `https://www.screener.in/company/${ticker}/`, text: company }] },
    { text: person.join('\n'), lines: person, links: [] },
    { text: date, lines: [date], dates: [] },
    { text: type.join('\n'), lines: type, links: [] },
    { text: value.join('\n'), lines: value, links: [] },
  ],
});
const captureAt = '2026-09-05T06:30:00.000Z';
const source = (id) => SCREENER_TRADE_SOURCES.find((item) => item.id === id);
const screenerRows = [
  normaliseScreenerTrade(source('bulk'), extracted('BULK', 'Bulk Ltd', ['Buyer LLP'], '04 Sep 2026', ['Buy'], ['11.71 crore', '1,59,657 @ 734']), { capturedAt: captureAt }),
  normaliseScreenerTrade(source('block'), extracted('BLOCK', 'Block Ltd', ['Seller LLP'], '04 Sep 2026', ['S'], ['25.12 crore', '3,20,000 @ 785']), { capturedAt: captureAt }),
  normaliseScreenerTrade(source('sast'), extracted('SAST', 'Sast Ltd', ['Acquirer'], '3 September 2026', ['Acq', 'Off Market'], ['17.17%', 'qty 8,67,000']), { capturedAt: captureAt }),
  normaliseScreenerTrade(source('insiders'), extracted('INSIDER', 'Insider Ltd', ['Director Name', 'Promoter And Director'], 'yesterday', ['Bought', '10,000 Equity'], ['7.14 lacs']), { capturedAt: captureAt }),
];
assert.deepEqual(screenerRows.map((row) => row.cells['Trade Category']), ['Bulk deal', 'Block deal', 'SAST', 'Insider trade']);
assert.deepEqual([screenerRows[0].cells['Trade Shares'], screenerRows[0].cells.Price], ['159657', '734']);
assert.deepEqual([screenerRows[1].cells.Transaction, screenerRows[2].cells.Transaction], ['Sell', 'Acquisition']);
assert.deepEqual([screenerRows[2].cells['Trade %'], screenerRows[2].cells.Mode], ['17.17', 'Off Market']);
assert.deepEqual([screenerRows[3].date, screenerRows[3].cells.Category], ['2026-09-04', 'Promoter And Director']);
const priorBulkIdentities = new Set([insiderTradeIdentity(screenerRows[0])]);
assert.equal(hasScreenerTradeOverlap(priorBulkIdentities, [{ ...screenerRows[0], cells: { ...screenerRows[0].cells, Insider: 'New same-day seller' } }]), false, 'a matching date is not enough to stop a high-volume incremental walk');
assert.equal(hasScreenerTradeOverlap(priorBulkIdentities, [screenerRows[0]]), true, 'an exact prior event establishes safe pagination overlap');

const captures = SCREENER_TRADE_SOURCES.map((item, index) => ({
  id: item.id, label: item.label, url: `https://www.screener.in${item.path}?o=-2`, pagesRead: 1,
  latestDate: screenerRows[index].date, oldestDate: screenerRows[index].date,
  rows: index === 0 ? [screenerRows[index], structuredClone(screenerRows[index])] : [screenerRows[index]],
}));
const screenerSnapshot = buildScreenerTradesSnapshot(null, captures, { capturedAt: captureAt });
const flattenSnapshot = (snapshot) => Object.values(snapshot.byTicker || {}).flat();
assert.equal(screenerSnapshot.coversUniverse, true);
assert.deepEqual(screenerSnapshot.categories, ['Bulk deal', 'Block deal', 'SAST', 'Insider trade']);
assert.equal(screenerSnapshot.rowCount, 4, 'repeat listing rows are collapsed before publication');
assert.equal(new Set(flattenSnapshot(screenerSnapshot).map(insiderTradeIdentity)).size, screenerSnapshot.rowCount);
assert.throws(() => buildScreenerTradesSnapshot(null, captures.slice(1), { capturedAt: captureAt }), /All four/);

// The user-supplied service contract is exercised without credentials or network access.
const realFetch = globalThis.fetch;
const markdown = `| Insider | Broadcast Date | Source |\n| --- | --- | --- |\n| Alice | ${day(-1)} | NSE |`;
try {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    return new Response(requests.length === 1 ? markdown : JSON.stringify(markdown));
  };
  for (const country of ['india', 'USA']) {
    const response = await fetchInsiderTrades({ ticker: ' test ', country, fromDate: window.from, toDate: window.to }, { MUNS_TOKEN: 'fixture-session-token' });
    assert.equal(response.trades.length, 1);
    assert.equal(response.trades[0].date, day(-1));
    assert.equal(response.format, 'markdown');
  }
  for (const [i, country] of ['india', 'USA'].entries()) {
    assert.equal(requests[i].url, 'https://devde.muns.io/filings/data/insider_trades');
    assert.equal(requests[i].method, 'POST');
    assert.equal(requests[i].headers.authorization, 'Bearer fixture-session-token');
    assert.deepEqual(requests[i].body, { ticker: 'TEST', country, fromDate: window.from, toDate: window.to });
  }
  assert.equal(normaliseInsiderTrades({ data: markdown }, 'TEST').rows.length, 1);

  await clearAll();
  let snapshot = { ...old, byTicker: { TEST: [a, expired] }, capturedAt: new Date(now - 7200000).toISOString() };
  let live = { ok: true, trades: [b], headers: ['Insider', 'Added column'] };
  let tag = 0;
  globalThis.fetch = async (path) => {
    if (path === 'data/insider-trades.json') return Response.json(snapshot);
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/api/insider-trades/TEST');
    assert.equal(url.searchParams.get('from'), window.from);
    assert.equal(url.searchParams.get('to'), window.to);
    return Response.json(live, { headers: { etag: `"live-${tag}"` } });
  };
  const feed = createFeed('insider');
  await feed.load(['TEST']);
  assert.equal(feed.rows().length, 1, 'initial snapshot obeys the retention window');
  await feed.loadOne('TEST', { force: true });
  assert.equal(feed.rows().length, 2, 'live trades join the snapshot');
  await feed.loadOne('TEST', { force: true });
  assert.equal(feed.rows().length, 2, 'revalidation of the same ETag does not duplicate trades');
  live = { ok: true, trades: [], headers: [] };
  tag++;
  await feed.loadOne('TEST', { force: true });
  assert.equal(feed.rows().length, 2, 'a live empty result keeps history');
  assert.equal((await readEntry(KEYS.filingRow('insider', 'TEST'))).value.trades.length, 0, 'HTTP cache retains exact response bytes');
  assert.equal((await readEntry(KEYS.insiderHistory('TEST'))).value.trades.length, 2);
  feed.invalidate();
  await feed.load(['TEST']);
  assert.equal(feed.rows().length, 2, 'live-only additions survive a reload after an empty response');
  assert(feed.meta().headers.includes('Legacy') && feed.meta().headers.includes('Added column'));
  snapshot = { ...snapshot, capturedAt: new Date(now - 3600000).toISOString(), byTicker: { TEST: [c] }, headers: ['Latest'] };
  await feed.refreshSnapshot();
  assert.equal(feed.rows().length, 3, 'new bulk capture supplements live and retained rows');
  snapshot = { ...snapshot, capturedAt: new Date(now - 1800000).toISOString(), byTicker: {}, empty: ['TEST'] };
  await feed.refreshSnapshot();
  assert.equal(feed.rows().length, 3, 'a new empty bulk capture cannot erase disclosures');
  assert.equal(feed.wasAskedEmpty('TEST'), false, 'a company with retained trades is not labelled empty');
  feed.invalidate();
  await feed.load(['TEST']);
  assert.equal(feed.rows().length, 3, 'bulk additions also survive reload after a later empty capture');
  live = { ok: false, reason: 'unauthorised', message: 'Expired session' };
  tag++;
  await feed.loadOne('TEST', { force: true });
  assert.equal(feed.rows().length, 3);
  assert.equal(feed.failureFor('TEST').reason, 'unauthorised', 'failed reads stay visible');
  // Older device results can still contribute a disclosure missing from the bulk response.
  await writeEntry(KEYS.filingRow('insider', 'TEST'), { value: { ok: true, trades: [c] }, savedAt: now - 86400000 });
  feed.invalidate();
  await feed.load(['TEST']);
  assert.equal(feed.rows().length, 3);
  snapshot = { ...snapshot, capturedAt: new Date(now).toISOString(), empty: [], failed: { TEST: { reason: 'timeout' } } };
  await feed.refreshSnapshot();
  assert.equal(feed.rows().length, 3);
  assert.equal(feed.failureFor('TEST').reason, 'timeout', 'a failed bulk capture stays visible beside retained rows');
} finally {
  globalThis.fetch = realFetch;
  await clearAll();
}

// Run the real capture against a localhost fixture in a disposable copy. In particular, the
// news collapse guard and FILINGS_FORCE must not bypass additive insider retention.
const scratch = await mkdtemp(join(tmpdir(), 'sattva-insider-'));
const tickers = Array.from({ length: 8 }, (_, i) => `TEST${i}`);
const fixtureErrors = [];
let returnRows = true;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    assert.equal(req.method, 'GET');
    assert.equal(url.searchParams.get('from'), window.from);
    assert.equal(url.searchParams.get('to'), window.to);
    assert.match(url.pathname, /^\/api\/insider-trades\/TEST[0-7]$/);
  } catch (error) { fixtureErrors.push(error); }
  const ticker = url.pathname.split('/').at(-1);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, trades: returnRows && ticker === 'TEST0' ? [{ ...c, ticker }] : [], headers: ['New'] }));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  for (const file of ['scripts/scrape-filings.mjs', 'scripts/lib/filings-snapshot.mjs', 'scripts/lib/company-capture.mjs', 'scripts/lib/filing-archive.mjs', 'worker/muns.mjs',
    'scripts/lib/active-portfolio.mjs', 'public/js/data/family-book-contract.js',
    'public/js/data/filings-shared.js', 'public/js/data/insider-history.js', 'public/js/data/announcements-shared.js', 'public/js/data/announcement-identity.js', 'public/js/data/domestic-filings-shared.js']) {
    await mkdir(dirname(join(scratch, file)), { recursive: true });
    await copyFile(new URL(`../${file}`, import.meta.url), join(scratch, file));
  }
  await mkdir(join(scratch, 'public/data'), { recursive: true });
  await writeFile(join(scratch, 'public/data/portfolio-companies.json'), JSON.stringify({ holdings: tickers.map((ticker) => ({ ticker })) }));
  const output = join(scratch, 'public/data/insider-trades.json');
  const prior = { ...old, byTicker: Object.fromEntries(tickers.map((ticker) => [ticker, [{ ...a, ticker }]])), withRows: 8 };
  for (const force of ['', '1']) {
    await writeFile(output, JSON.stringify(prior));
    await promisify(execFile)(process.execPath, ['scripts/scrape-filings.mjs', 'insider'], {
      cwd: scratch, env: { FILINGS_BASE: `http://127.0.0.1:${server.address().port}`, FILINGS_SCOPE: 'book', FILINGS_FORCE: force },
      timeout: 60000,
    });
    const captured = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(captured.rowCount, 9, `partial capture adds new rows with FILINGS_FORCE=${force}`);
    assert.equal(captured.covered, 8);
    assert.equal(captured.byTicker.TEST0.length, 2);
    assert(captured.headers.includes('Legacy') && captured.headers.includes('New'));
  }
  returnRows = false;
  await promisify(execFile)(process.execPath, ['scripts/scrape-filings.mjs', 'insider'], {
    cwd: scratch, env: { FILINGS_BASE: `http://127.0.0.1:${server.address().port}`, FILINGS_SCOPE: 'book' }, timeout: 60000,
  });
  assert.equal(JSON.parse(await readFile(output, 'utf8')).rowCount, 9, 'an all-empty capture keeps earlier additions');
  assert.deepEqual(fixtureErrors, []);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
console.log('PASS insider request contract, additive capture script, live refreshes and device history');
