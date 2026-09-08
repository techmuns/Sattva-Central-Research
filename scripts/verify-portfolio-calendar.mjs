#!/usr/bin/env node
// THE PORTFOLIO CALENDAR SURVIVES A FAILURE IN THE FEED IT SHARES A ROUTE WITH.
//
// `/api/concalls` assembles two independent upstreams: StockScans' analysed con-call rows, and the
// authenticated S Screen dashboard captured into an immutable Actions artifact. Either fails on
// its own, and when StockScans is the one that fails the Worker serves the committed snapshot —
// a capture of StockScans alone, which has never carried a calendar at all.
//
// Both used to arrive in the browser as `[]`, which was written straight over a good calendar and
// then persisted, because the response is stored under the server's own ETag. All Alerts' Upcoming
// view emptied on an outage in a feed it does not read, and stayed empty across reloads.
//
// Every assertion here is about that boundary: an absent calendar is retained, a read one wins,
// and an EMPTY SUCCESSFUL read still clears — "the dashboard has nothing on it" is a real answer
// and must not be confused with "we could not ask".
//
// Local captures and local stand-ins only. No production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const snapshot = JSON.parse(readFileSync(resolve(root, 'data/concall-scans.json')));

const event = (ticker, date, eventType) => ({
  id: `${ticker}|${date}|${eventType}|day`, companyKey: ticker, ticker, name: `${ticker} Limited`,
  date, time: null, eventType, companyUrl: `https://www.screener.in/company/${ticker}/`,
  sourceUrl: `https://www.screener.in/company/${ticker}/`, observedAt: '2026-09-04T07:00:00Z',
});
const FULL = [event('STLTECH', '2026-09-10', 'AGM'), event('RELIANCE', '2026-09-12', 'Result')];
const SHRUNK = [event('RELIANCE', '2026-09-12', 'Result')];

// The four shapes the route can answer with. Only the first two are successful reads of the
// dashboard; the last two are the failures that used to read as an empty calendar.
const MODES = {
  full: { portfolioUpcoming: FULL, screener: { status: 'ok', checkedAt: '2026-09-04T07:00:00Z', portfolioUpcomingAvailable: true } },
  shrunk: { portfolioUpcoming: SHRUNK, screener: { status: 'ok', checkedAt: '2026-09-05T07:00:00Z', portfolioUpcomingAvailable: true } },
  emptied: { portfolioUpcoming: [], screener: { status: 'ok', checkedAt: '2026-09-06T07:00:00Z', portfolioUpcomingAvailable: true } },
  // The artifact could not be read: capture null, so the route sends no calendar.
  'artifact-failed': { portfolioUpcoming: null, screener: { status: 'failed', checkedAt: '2026-09-06T09:00:00Z', portfolioUpcomingAvailable: false } },
};
let mode = 'full';
let stockscansDown = false;
// What the Worker's fallback branch carries: the artifact's own rows where it was readable.
let stockscansDownCalendar = null;
// The Worker is unreachable entirely: a reload paints the stored response, and nothing in this
// session has confirmed any of it.
let routeDown = false;

const html = `<!doctype html><html><body><script type="module">
import * as concalls from '/js/data/concall-scans.js';
window.concalls = concalls;
window.ready = concalls.load().then(() => true, (e) => 'error: ' + e.message);
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value, tag) => {
    res.setHeader('content-type', 'application/json');
    if (tag) res.setHeader('etag', tag);
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/concalls') {
      if (routeDown) { res.writeHead(503); res.end('{}'); return; }
      // StockScans down: the Worker's own fallback branch. It serves the committed snapshot, and
      // CARRIES THE CALENDAR READ INTO IT — the artifact is a different upstream and settles on its
      // own, so a healthy calendar survives a StockScans outage. `null` only where the artifact
      // itself could not be read.
      if (stockscansDown) return json({ ...snapshot, ok: true,
        portfolioUpcoming: stockscansDownCalendar, meta: { ...snapshot.meta, screener: MODES[mode].screener },
        degraded: 'StockScans is unavailable — showing the last committed snapshot.' }, `"snapshot-fallback-${mode}"`);
      const { portfolioUpcoming, screener } = MODES[mode];
      return json({ ...snapshot, portfolioUpcoming, meta: { ...snapshot.meta, screener } }, `"${mode}"`);
    }
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const context = await browser.newContext();
const errors = [];
let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (error) { failures++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

const openPage = async (target = context) => {
  const page = await target.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  await page.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => window.ready), true, 'the con-call module failed to load');
  return page;
};
const state = (page) => page.evaluate(() => ({
  dates: window.concalls.portfolioUpcoming().map((row) => `${row.ticker}|${row.date}`),
  rows: window.concalls.all().length,
  retained: window.concalls.meta()?.portfolioUpcomingRetained,
  confirmed: window.concalls.meta()?.portfolioUpcomingConfirmed,
  supplied: window.concalls.meta()?.portfolioUpcomingSupplied,
  calendarAsOf: window.concalls.meta()?.portfolioUpcomingCheckedAt,
  screener: window.concalls.meta()?.screener?.status ?? null,
}));

const page = await openPage();
let now = await state(page);
check('a healthy read paints the dashboard calendar and is not marked retained', () => {
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12']);
  assert.equal(now.retained, false);
  assert.equal(now.confirmed, true);
  assert.equal(now.calendarAsOf, '2026-09-04T07:00:00Z');
});

// A SUCCESSFUL READ ALWAYS WINS, INCLUDING A SHORTER ONE. A forward calendar legitimately shrinks
// as its dates pass, so retention must never become a merge that keeps yesterday's events alive.
mode = 'shrunk';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('a shorter successful read replaces the calendar rather than merging into it', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, false);
  assert.equal(now.calendarAsOf, '2026-09-05T07:00:00Z');
});

// THE FAILURE THIS FILE EXISTS FOR.
mode = 'artifact-failed';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('an unreadable S Screen artifact retains the calendar instead of emptying it', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.screener, 'failed', 'the failure must still be reported');
  assert.equal(now.retained, true, 'and the rows must be labelled as retained');
  // A 200 that carried no calendar is still a read that did not confirm one. This must not
  // depend on `screener.status` happening to say so beside it — two independent signals, and
  // only this one is about whether the rows on screen were vouched for.
  assert.equal(now.confirmed, false, 'a payload carrying no calendar confirms nothing about the rows it left');
});
check('a retained calendar keeps its own capture time, not the failed check', () => {
  assert.equal(now.calendarAsOf, '2026-09-05T07:00:00Z');
});

// AND IT SURVIVES A RELOAD. The response is stored under the server's ETag, so without a retained
// copy of its own the reload repaints the empty calendar the failure carried — which is the
// version of this bug that looks permanent rather than transient.
await page.reload();
await page.waitForFunction(() => window.ready);
now = await state(page);
check('the retained calendar survives a reload while the artifact is still unreadable', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, true);
});

// A STOCKSCANS OUTAGE MAY NOT EMPTY A FEED IT DOES NOT PUBLISH. The Worker's snapshot fallback is
// a capture of StockScans alone and carries no calendar at all.
mode = 'shrunk';
stockscansDown = true;
await page.evaluate(() => window.concalls.refresh().catch(() => null));
now = await state(page);
check('a StockScans outage does not empty the S Screen calendar', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, true);
});

// AND AN EMPTY SUCCESSFUL READ STILL CLEARS. "The dashboard has nothing scheduled" is an answer;
// retention must not turn it into a calendar that can never go back to nothing.
stockscansDown = false;
mode = 'emptied';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('a successful read of an empty dashboard clears the calendar', () => {
  assert.deepEqual(now.dates, []);
  assert.equal(now.retained, false);
  assert.equal(now.calendarAsOf, '2026-09-06T07:00:00Z');
});

// A LIVE READ THAT NEVER HAPPENED IS NOT A CONFIRMATION. Reloading against an unreachable route
// paints the stored response, whose own `meta.screener` said `ok` when it was written. Reporting
// that as a current capture is the same class of claim as the empty calendar above, one layer on.
// Its own device. Sharing the one above leaves its 2026-09-06 `emptied` capture held, and the
// `full` fixture is dated 2026-09-04 — the staleness guard then correctly refuses to roll the
// calendar backward onto it, which is that guard working rather than the case under test.
mode = 'full';
const outageContext = await browser.newContext();
const outagePage = await openPage(outageContext);
routeDown = true;
await outagePage.reload();
await outagePage.waitForFunction(() => window.ready);
now = await state(outagePage);
check('a reload with an unreachable route serves the calendar as retained, not as confirmed', () => {
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12'], 'the stored calendar is still painted');
  assert.equal(now.confirmed, false, 'bytes nobody confirmed in this session may not read as a fresh capture');
  assert.equal(now.retained, true, 'and these rows really are ones we held');
});
routeDown = false;
await outagePage.close();
await outageContext.close();

// AN AVAILABILITY TRANSITION IS ITSELF A CHANGE. `hasChanged` gates whether subscribers repaint,
// and the coverage chip reads the retention flag — so a calendar going missing, or coming back
// with the same rows, has to reach them rather than waiting for the next full collection.
mode = 'full';
const transitionContext = await browser.newContext();
const page3 = await openPage(transitionContext);
const changes = () => page3.evaluate(() => window.__calendarChanges || 0);
await page3.evaluate(() => {
  window.__calendarChanges = 0;
  window.concalls.onChange(() => { window.__calendarChanges += 1; });
});
mode = 'artifact-failed';
await page3.evaluate(() => window.concalls.refresh());
const afterLoss = await changes();
const lostState = await state(page3);
check('a calendar going missing notifies subscribers even though its rows are unchanged', () => {
  assert.equal(afterLoss, 1, `expected one change notification, saw ${afterLoss}`);
  assert.equal(lostState.retained, true);
  assert.equal(lostState.supplied, false);
});
mode = 'full';
await page3.evaluate(() => window.concalls.refresh());
const afterRecovery = await changes();
const recoveredState = await state(page3);
check('and the same calendar coming back notifies them too', () => {
  assert.equal(afterRecovery, 2, `expected a second change notification, saw ${afterRecovery}`);
  assert.equal(recoveredState.retained, false);
  assert.equal(recoveredState.supplied, true);
});
await page3.close();
await transitionContext.close();

// AN EMPTY CALENDAR NOBODY CONFIRMED IS STILL A CALENDAR NOBODY CONFIRMED. The last successful
// read can legitimately return an empty dashboard; gating the retention mark on row count let
// that case report a failed check as a current capture.
const page4 = await openPage();
mode = 'emptied';
await page4.evaluate(() => window.concalls.refresh());
routeDown = true;
await page4.reload();
await page4.waitForFunction(() => window.ready);
now = await state(page4);
check('an unreachable route over a legitimately EMPTY calendar is still marked unconfirmed', () => {
  assert.deepEqual(now.dates, [], 'the empty capture is still what is painted');
  assert.equal(now.confirmed, false, 'row count may not decide whether a failed check is reported');
});

routeDown = false;
await page4.close();

// AND AN UNCHANGED RECOVERY LIFTS THE MARK. Driven from a NON-EMPTY calendar so the retention
// mark under test is the one an outage sets, not the empty-calendar case above: with that fixed,
// asserting this on an empty calendar would pass for the wrong reason.
//
// The route comes back serving the same representation, so its ETag matches what this browser
// stored and `conditionalJson` reports 304 — no content change is coming, so nothing else would
// ever clear the flag and the feed would report failed while every poll succeeded. (A same-ETag
// 200 is how a 304 reaches this module: `cache: 'no-cache'` lets the browser resolve the real
// 304 itself and hand back the cached body.)
// Its own browser context, so it starts with an empty device store. Sharing one would leave the
// `emptied` capture (2026-09-06) held from the block above, and `full` is dated 2026-09-04 — the
// stale guard would correctly refuse to roll the calendar backward onto it, which is the guard
// working, not the case under test.
mode = 'full';
const cleanContext = await browser.newContext();
const page5 = await openPage(cleanContext);
const beforeOutage = await state(page5);
check('the recovery case starts from a confirmed, non-empty calendar', () => {
  assert.deepEqual(beforeOutage.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12']);
  assert.equal(beforeOutage.retained, false);
});
routeDown = true;
await page5.reload();
await page5.waitForFunction(() => window.ready);
const duringOutage = await state(page5);
check('...which the outage marks unconfirmed', () => {
  assert.equal(duringOutage.confirmed, false);
  assert.equal(duringOutage.retained, true);
});
routeDown = false;
await page5.evaluate(() => window.concalls.refresh());
now = await state(page5);
check('an unchanged recovery clears the retention mark rather than leaving the feed failed for ever', () => {
  assert.equal(now.confirmed, true, 'a 304 confirms the representation we hold, calendar included');
  assert.equal(now.retained, false);
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12'], 'and the rows are untouched');
});
await page5.close();
await cleanContext.close();

// A FIRST VISIT WITH NO CALENDAR EVER CAPTURED MAY NOT CLAIM A RETAINED ONE. `confirmed` is
// false either way — nothing was checked — but the retention sentence would invent a capture this
// device has never had.
routeDown = true;
const coldContext = await browser.newContext();
const cold = await openPage(coldContext);
now = await state(cold);
check('a first visit with an unreachable route reports unconfirmed but claims no retained rows', () => {
  assert.deepEqual(now.dates, []);
  assert.equal(now.confirmed, false, 'nothing was checked');
  assert.equal(now.retained, false, 'and there is no capture on this device to retain');
});
await cold.close();
await coldContext.close();
routeDown = false;

// A POLL THAT FAILS ON AN OPEN TAB IS ALSO A CHECK THAT DID NOT HAPPEN. `refresh()` is the path
// All Alerts' own control drives; `live.js` swallows the poller's error entirely, so nothing else
// would ever say so.
mode = 'full';
const openTab = await browser.newContext();
const openPageTab = await openPage(openTab);
const before = await state(openPageTab);
check('an open tab starts confirmed', () => assert.equal(before.confirmed, true));
routeDown = true;
await openPageTab.evaluate(() => window.concalls.refresh().catch(() => null));
now = await state(openPageTab);
check('a failing revalidation on an open tab marks the calendar unconfirmed', () => {
  assert.equal(now.confirmed, false, 'an outage beginning after the page loaded must still be reported');
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12'], 'without discarding the rows');
});
routeDown = false;
await openPageTab.close();
await openTab.close();

// A COLD DEVICE HAS NOTHING TO RETAIN, so the route carrying the calendar into its fallback is the
// only thing between a StockScans outage and an empty Upcoming view for a healthy S Screen read.
mode = 'full';
stockscansDown = true;
stockscansDownCalendar = FULL;
const coldFallbackContext = await browser.newContext();
const coldFallback = await openPage(coldFallbackContext);
now = await state(coldFallback);
check('a StockScans outage on a COLD device still paints a healthy calendar', () => {
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12'], 'the artifact was readable, so its rows must arrive');
  assert.equal(now.confirmed, true, 'and they were confirmed by this read');
});
await coldFallback.close();
await coldFallbackContext.close();
stockscansDown = false;
stockscansDownCalendar = null;

await page.close();

check('no console errors', () => assert.deepEqual(errors, []));

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll portfolio-calendar checks passed');
process.exit(failures ? 1 : 0);
