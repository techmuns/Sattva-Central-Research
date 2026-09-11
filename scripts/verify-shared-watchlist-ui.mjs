#!/usr/bin/env node
// THE SHARED WATCHLIST, DRIVEN THROUGH THE REAL UI AGAINST THE REAL STORE.
//
// The fixture server implements /api/watchlist on top of `SharedWatchlistStore` itself — the same
// class the Worker runs — so this exercises the whole path (star -> prompt -> outbox -> route ->
// SQLite -> snapshot -> the other device's paint) without wrangler, without egress, and without a
// second copy of the rules that could drift from the deployed one.
//
// Two browser CONTEXTS are two devices: separate localStorage, separate IndexedDB, one server.
// That is the only arrangement in which "everyone sees the same list" is actually a claim about
// something, and it is the claim this whole change exists to make.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SharedWatchlistStore } from '../worker/watchlist-store.mjs';
import { contentTag, stableJson } from '../worker/http.mjs';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

let failures = 0;
let checks = 0;
const ok = (name, pass, detail = '') => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- the stand-in Worker -----------------------------------------------------------------
const db = new DatabaseSync(':memory:');
const store = new SharedWatchlistStore({
  sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
  transactionSync: (fn) => {
    db.exec('BEGIN');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
});

let offline = false;      // the shared list is unreachable
let reads = 0;
let notModified = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/watchlist') {
    if (offline) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":false,"reason":"watchlist-unavailable"}'); return; }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = store.watchlistApply(input.intents);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...result.snapshot, outcomes: result.outcomes }));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, reason: 'invalid-request' }));
      }
      return;
    }
    reads++;
    const payload = { ok: true, ...store.watchlistSnapshot() };
    const tag = `"${contentTag(stableJson(payload))}"`;
    if (req.headers['if-none-match'] === tag) {
      notModified++;
      res.writeHead(304, { etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' });
    res.end(JSON.stringify(payload));
    return;
  }
  // Every other /api/ route is absent here, exactly as on a static origin. The dashboard must
  // paint anyway — that is a supported mode, not a degraded one.
  if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('{}'); return; }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(file);
    res.setHeader('content-type', {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
    }[extname(file)] || 'text/plain');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

const openDevice = async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Nothing leaves this fixture. A check that quietly reached the internet would be measuring
  // somebody else's uptime rather than this code.
  await page.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort()));
  await page.goto(`${origin}/#/research/breakouts?scope=universe`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-watch]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page, errors };
};

const listOn = (page) => page.evaluate(async () => {
  const wl = await import('/js/core/watchlist.js');
  return { companies: wl.all().map((e) => ({ ticker: e.ticker, addedBy: e.addedBy })), meta: wl.meta() };
});
const sync = async (page) => {
  await page.evaluate(async () => (await import('/js/core/watchlist.js')).syncNow({ force: true }));
  await page.waitForTimeout(800);
};
const starAt = async (page, index) => {
  const star = page.locator('[data-watch]').nth(index);
  const ticker = await star.getAttribute('data-watch');
  await star.click();
  return ticker;
};
const answerPrompt = async (page, name) => {
  await page.waitForSelector('[data-watch-attribution]', { timeout: 5000 });
  if (await page.locator('[data-attribution-select]').isVisible()) await page.selectOption('[data-attribution-select]', '__new__');
  await page.fill('[data-attribution-input]', name);
  await page.click('[data-attribution-confirm]');
  await page.waitForTimeout(900);
};

try {
  console.log('\n— one list, two devices —');
  const laptop = await openDevice();
  const phone = await openDevice();

  const t1 = await starAt(laptop.page, 0);
  await answerPrompt(laptop.page, 'Ravi Kumar');
  const laptopAfter = await listOn(laptop.page);
  ok('an add reaches the shared list and is attributed',
    laptopAfter.companies.some((c) => c.ticker === t1 && c.addedBy === 'Ravi Kumar'),
    JSON.stringify(laptopAfter.companies));
  ok('...and the device reports it as confirmed rather than merely stored',
    laptopAfter.meta.origin === 'live' && laptopAfter.meta.shared === true, laptopAfter.meta.origin);

  await sync(phone.page);
  const phoneAfter = await listOn(phone.page);
  ok('a SECOND DEVICE that did nothing sees the same company, with the same name beside it',
    phoneAfter.companies.some((c) => c.ticker === t1 && c.addedBy === 'Ravi Kumar'),
    JSON.stringify(phoneAfter.companies));

  console.log('\n— the growing dropdown —');
  const t2 = await starAt(phone.page, 1);
  await phone.page.waitForSelector('[data-watch-attribution]');
  const options = await phone.page.locator('[data-attribution-select] option').allInnerTexts();
  ok('a name typed on one device is offered on another without being retyped',
    options.includes('Ravi Kumar'), options.join(' | '));
  // NOTHING IS PRESELECTED ON A DEVICE NOBODY HAS IDENTIFIED THEMSELVES ON. Defaulting to the top
  // of the roster would file this person's add under a colleague's name on their very first use.
  ok('...but nothing is preselected on a device nobody has identified themselves on',
    (await phone.page.locator('[data-attribution-select]').inputValue()) === '');
  await phone.page.keyboard.press('Enter');
  await phone.page.waitForTimeout(400);
  ok('...and a blind Enter adds nothing rather than crediting the wrong person',
    (await phone.page.locator('[data-watch-attribution]').count()) === 1 &&
    !(await listOn(phone.page)).companies.some((c) => c.ticker === t2));
  await phone.page.selectOption('[data-attribution-select]', { label: 'Ravi Kumar' });
  await phone.page.click('[data-attribution-confirm]');
  await phone.page.waitForTimeout(900);

  const t3 = await starAt(phone.page, 2);
  await phone.page.waitForSelector('[data-watch-attribution]');
  ok('once this device HAS a name, the next add preselects it — one key, no typing',
    (await phone.page.locator('[data-attribution-select]').inputValue()) !== '');
  await phone.page.keyboard.press('Enter');
  await phone.page.waitForTimeout(900);
  ok('...and Enter alone files it under that name',
    (await listOn(phone.page)).companies.some((c) => c.ticker === t3 && c.addedBy === 'Ravi Kumar'));

  console.log('\n— cancelling, and removing —');
  const t4 = await starAt(laptop.page, 4);
  await laptop.page.waitForSelector('[data-watch-attribution]');
  await laptop.page.click('[data-attribution-cancel]');
  await laptop.page.waitForTimeout(500);
  ok('backing out of the prompt adds nothing, here or on the shared list',
    !(await listOn(laptop.page)).companies.some((c) => c.ticker === t4));
  await sync(phone.page);
  ok('...and the other device never sees it either',
    !(await listOn(phone.page)).companies.some((c) => c.ticker === t4));

  await laptop.page.locator(`[data-watch="${t1}"]`).first().click();
  await laptop.page.waitForTimeout(900);
  ok('unstarring stays ONE click — no prompt',
    (await laptop.page.locator('[data-watch-attribution]').count()) === 0);
  await sync(phone.page);
  ok('...and the removal reaches the other device',
    !(await listOn(phone.page)).companies.some((c) => c.ticker === t1));

  console.log('\n— an outage is not an empty list —');
  const beforeOutage = (await listOn(phone.page)).companies.length;
  offline = true;
  await sync(phone.page);
  const during = await listOn(phone.page);
  ok('a failed read leaves every company on screen', during.companies.length === beforeOutage,
    `${beforeOutage} → ${during.companies.length}`);
  ok('...and stops claiming the list is confirmed', during.meta.origin !== 'live', during.meta.origin);
  ok('...and says so in words a reader can act on', typeof during.meta.error === 'string' && during.meta.error.length > 0);

  // An edit made while the shared list is unreachable is the reader's work and must not be lost.
  const t5 = await starAt(phone.page, 6);
  await answerPrompt(phone.page, 'Priya Nair');
  const queued = await listOn(phone.page);
  ok('an edit made during the outage is kept and marked as not yet sent',
    queued.companies.some((c) => c.ticker === t5) && queued.meta.pending === 1 && queued.meta.origin === 'pending',
    `pending=${queued.meta.pending} origin=${queued.meta.origin}`);

  offline = false;
  await sync(phone.page);
  const recovered = await listOn(phone.page);
  ok('...and lands on the shared list once it is reachable again',
    recovered.meta.pending === 0 && recovered.companies.some((c) => c.ticker === t5));
  await sync(laptop.page);
  ok('...where the other device then sees it, attributed to whoever made it',
    (await listOn(laptop.page)).companies.some((c) => c.ticker === t5 && c.addedBy === 'Priya Nair'));

  console.log('\n— the poll is cheap, and a stale device is harmless —');
  // ASSERTED AGAINST THE ROUTE, NOT THROUGH THE BROWSER, and that is not a weaker check.
  //
  // Playwright's request interception re-issues every request, which bypasses the HTTP cache the
  // browser would otherwise revalidate from — so a page-driven poll never sends `If-None-Match`
  // here and a 304 assertion through it would be measuring the test harness. The contract worth
  // guaranteeing is the route's: a caller holding the current tag gets a bodyless 304.
  {
    const first = await fetch(`${origin}/api/watchlist`);
    const tag = first.headers.get('etag');
    const again = await fetch(`${origin}/api/watchlist`, { headers: { 'if-none-match': tag } });
    ok('an unchanged poll is answered 304, so watching the list costs headers',
      !!tag && again.status === 304 && (await again.text()).length === 0, `etag=${tag} status=${again.status}`);
    await fetch(`${origin}/api/watchlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intents: [{ op: 'add', ticker: 'TAGMOVE', name: 'Tag Move Ltd', by: 'Ravi Kumar' }] }),
    });
    const moved = await fetch(`${origin}/api/watchlist`, { headers: { 'if-none-match': tag } });
    ok('...and the tag moves the moment the list actually changes', moved.status === 200);
  }

  // A device that still holds a company the desk has since removed must not put it back.
  const resurrect = await laptop.page.evaluate(async (ticker) => {
    const wl = await import('/js/core/watchlist.js');
    localStorage.setItem('sattva:watchlist', JSON.stringify([{ ticker, name: 'Stale Copy Ltd', addedAt: new Date().toISOString(), addedBy: null }]));
    localStorage.removeItem('sattva:watchlist:seeded');
    await wl.syncNow({ force: true });
    return wl.all().map((e) => e.ticker);
  }, t1);
  ok('a stale device cannot resurrect a company somebody removed', !resurrect.includes(t1), resurrect.join(','));

  const errors = [...laptop.errors, ...phone.errors];
  ok('no uncaught page errors anywhere in the run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
