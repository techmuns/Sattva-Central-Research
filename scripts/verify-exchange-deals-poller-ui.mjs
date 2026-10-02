#!/usr/bin/env node
// The bulk/block poller in public/js/data/exchange-deals.js runs only while an ACTIVE reader is open.
//
// All Alerts' source observer (`observeSources()` in public/js/data/daily-alerts.js) subscribes to
// every alert source once and stays subscribed for the page's lifetime, because it only invalidates
// cached readings. It used to subscribe to the insider feed like any reader, and the insider feed
// hands its subscribers to the bulk/block poller, so the 60-second check never stopped: after the
// reader left All Alerts, and after Insider Trades closed too, the page went on reading
// /api/bulk-block-deals every minute for the rest of the session. verify-general-alerts-ui.mjs
// caught it as a read after `destroy`, only on CI, because only there did a tick land inside its
// 400 ms window. A simulated clock makes it deterministic here: every tick is driven on purpose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);

const root = fileURLToPath(new URL('../public/', import.meta.url));
let reads = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Answered as unavailable, as a static origin does: the module keeps the committed capture,
  // records the delivery error and emits, which is all a subscriber needs to be told about.
  if (url.pathname === '/api/bulk-block-deals') { reads++; res.writeHead(404); res.end('{}'); return; }
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>poller</title><main></main>'); return; }
  try {
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    window.alerts = await import('/js/data/daily-alerts.js');
    window.deals = await import('/js/data/exchange-deals.js');
    window.feeds = await import('/js/data/filings.js');
    await window.deals.refresh(); // the committed capture, then the one live check every reader makes
  });
  const readsDuring = async (action) => {
    const before = reads;
    await action();
    await page.waitForTimeout(250);
    return reads - before;
  };
  const minute = () => page.clock.fastForward(61_000);

  // 1. All Alerts opens and closes. Its source observer stays subscribed for the page's lifetime,
  //    so this is exactly the state every session is in once All Alerts has been visited.
  await page.evaluate(() => { const off = window.alerts.onChange(() => {}); off(); });
  assert.equal(await readsDuring(minute), 0, 'no bulk/block read a minute after All Alerts closes');
  assert.equal(await readsDuring(minute), 0, 'nor the minute after that');

  // 2. Insider Trades opens: an active reader checks a stale capture at once and every minute after.
  await page.evaluate(() => { window.stopInsider = window.feeds.insider.onChange(() => {}); });
  await page.waitForTimeout(250);
  assert.equal(reads, 2, 'an active reader refreshes the stale capture as it opens');
  assert.equal(await readsDuring(minute), 1, 'and keeps it current every minute while it is open');

  // 3. It closes: the cache observer left behind does not keep the poll alive.
  await page.evaluate(() => window.stopInsider());
  assert.equal(await readsDuring(minute), 0, 'closing the last active reader stops the minute check');
  assert.equal(await readsDuring(() => page.evaluate(() => window.dispatchEvent(new Event('focus')))), 0,
    'and its focus, online and visibility listeners with it');

  // 4. A passive subscriber is still TOLD about changes, which is what the cache observer is for.
  const told = await page.evaluate(async () => {
    let calls = 0;
    const off = window.feeds.insider.onChange(() => { calls++; }, { poll: false });
    await window.deals.refresh(); // a stale capture: the read happens and every listener is told
    off();
    return calls;
  });
  assert.ok(told > 0, 'a passive subscriber still receives bulk/block changes');
  assert.equal(await readsDuring(minute), 0, 'and starts no poll of its own');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS bulk/block poller: runs only while an active reader is open, stops with the last one, and still tells passive observers about changes');
} finally {
  await browser.close();
  server.close();
}
