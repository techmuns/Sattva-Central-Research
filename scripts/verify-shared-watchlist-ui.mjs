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
let holdWrite = null;
function delayNextWrite() {
  let accepted, release;
  const ready = new Promise(done => { accepted = done; });
  const gate = new Promise(done => { release = done; });
  holdWrite = async () => { accepted(); await gate; };
  return { ready, release };
}
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
        const hold = holdWrite;
        holdWrite = null;
        if (hold) await hold();
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
  if (url.pathname === '/watchlist-fixture') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>Local watchlist regression fixture</title>');
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
  // Keep the row clear of the fixed source-status launcher at the viewport edge.
  await star.evaluate(button => button.scrollIntoView({ block: 'center' }));
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

  console.log('\n— edits made during a save —');
  const fixtures = [];
  const fixtureErrors = [];
  const fixture = async (initial = {}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => fixtureErrors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    await page.goto(`${origin}/watchlist-fixture`);
    await page.evaluate(async entries => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      window.wl = await import('/js/core/watchlist.js');
    }, initial);
    fixtures.push(context);
    return page;
  };
  const racing = await fixture({ 'sattva:watchlist:seeded': '1' });
  await sync(racing);
  let delayed = delayNextWrite();
  await racing.evaluate(() => { wl.add('RACEFIRST', 'First company', 'Tester'); window.saving = wl.syncNow({ force: true }); });
  await delayed.ready;
  await racing.evaluate(() => wl.add('RACELATER', 'Later company', 'Tester'));
  delayed.release();
  await racing.evaluate(() => window.saving);
  await sync(racing);
  ok('an addition during an earlier save survives and reaches the shared list',
    store.watchlistSnapshot().companies.some(c => c.ticker === 'RACELATER') &&
    (await listOn(racing)).companies.some(c => c.ticker === 'RACELATER'));

  delayed = delayNextWrite();
  await racing.evaluate(() => { wl.add('RACEUNDO', 'Undo company', 'Tester'); window.saving = wl.syncNow({ force: true }); });
  await delayed.ready;
  await racing.evaluate(() => wl.remove('RACEUNDO', 'Tester'));
  delayed.release();
  await racing.evaluate(() => window.saving);
  await sync(racing);
  ok('an unstar during the same company’s add survives the acknowledgement',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'RACEUNDO'));

  const sibling = await racing.context().newPage();
  await sibling.goto(`${origin}/watchlist-fixture`);
  await sibling.evaluate(async () => { window.wl = await import('/js/core/watchlist.js'); });
  delayed = delayNextWrite();
  await racing.evaluate(() => { wl.add('RACETABONE', 'First tab', 'Tester'); window.saving = wl.syncNow({ force: true }); });
  await delayed.ready;
  await sibling.evaluate(() => wl.add('RACETABTWO', 'Second tab', 'Tester'));
  delayed.release();
  await racing.evaluate(() => window.saving);
  await sync(sibling);
  ok('acknowledging one tab preserves an edit queued by another tab',
    store.watchlistSnapshot().companies.some(c => c.ticker === 'RACETABTWO'));

  console.log('\n— interrupted migration —');
  const migrating = await fixture({
    'sattva:watchlist': JSON.stringify([{ ticker: 'LEGACYKEEP', name: 'Old saved company' }, { ticker: 'LEGACYNEW', name: 'Queued addition', addedBy: 'Tester' }]),
    'sattva:watchlist:outbox': JSON.stringify([{ op: 'add', ticker: 'LEGACYNEW', name: 'Queued addition', by: 'Tester' }]),
  });
  await sync(migrating);
  ok('a pending new addition cannot erase an older list before migration',
    ['LEGACYKEEP', 'LEGACYNEW'].every(ticker => store.watchlistSnapshot().companies.some(c => c.ticker === ticker)));
  ok('migration does not invent a contributor for older entries',
    store.watchlistSnapshot().companies.find(c => c.ticker === 'LEGACYKEEP')?.addedBy === null);

  console.log('\n— unavailable browser storage —');
  const limited = await fixture({ 'sattva:watchlist:seeded': '1' });
  await limited.evaluate(() => {
    window.realSetItem = Storage.prototype.setItem;
    window.realRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('sattva:watchlist')) throw new DOMException('Full', 'QuotaExceededError'); return realSetItem.call(this, key, value); };
    Storage.prototype.removeItem = function(key) { if (key.startsWith('sattva:watchlist')) throw new DOMException('Blocked', 'SecurityError'); return realRemoveItem.call(this, key); };
  });
  await sync(limited);
  let limitedState = await listOn(limited);
  ok('a shared list remains readable when local persistence fails',
    limitedState.companies.length === store.watchlistSnapshot().count && limitedState.companies.length > 0);
  ok('the reader is told that browser persistence failed', !!limitedState.meta.error);
  offline = true;
  await limited.evaluate(() => wl.add('MEMORYONLY', 'Unsaved browser edit', 'Tester'));
  await sync(limited);
  limitedState = await listOn(limited);
  ok('offline edits remain in this tab when storage writes fail',
    limitedState.companies.some(c => c.ticker === 'MEMORYONLY') && limitedState.meta.pending === 1);
  ok('the outage message does not claim a session-only edit was saved on the device',
    !!limitedState.meta.error && !limitedState.meta.error.includes('saved on this device'));
  offline = false;
  await sync(limited);
  ok('the in-memory edit reaches the shared list after reconnection',
    store.watchlistSnapshot().companies.some(c => c.ticker === 'MEMORYONLY'));
  await limited.evaluate(() => { Storage.prototype.setItem = realSetItem; Storage.prototype.removeItem = realRemoveItem; });
  await sync(limited);
  ok('persistence recovers without restoring the stale disk list',
    (await listOn(limited)).companies.some(c => c.ticker === 'MEMORYONLY') && !(await listOn(limited)).meta.error);
  await limited.reload();
  ok('the recovered device copy survives a page reload',
    (await listOn(limited)).companies.some(c => c.ticker === 'MEMORYONLY'));

  const denied = await browser.newContext();
  const deniedPage = await denied.newPage();
  fixtures.push(denied);
  deniedPage.on('pageerror', error => fixtureErrors.push(error.message));
  await deniedPage.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  await deniedPage.goto(`${origin}/watchlist-fixture`);
  await deniedPage.evaluate(async () => {
    localStorage.setItem('sattva:watchlist', JSON.stringify([{ ticker: 'DENIEDOLD', name: 'Unread old company' }]));
    localStorage.setItem('sattva:watchlist:outbox', JSON.stringify([{ op: 'add', ticker: 'DENIEDQUEUED', name: 'Old queued addition', by: 'Tester' }]));
    window.originalStorage = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(key => [key, Storage.prototype[key]]));
    for (const method of Object.keys(originalStorage)) Storage.prototype[method] = function(key, ...args) {
      if (key.startsWith('sattva:watchlist')) throw new DOMException('Denied', 'SecurityError');
      return originalStorage[method].call(this, key, ...args);
    };
    window.wl = await import('/js/core/watchlist.js');
    await wl.syncNow({ force: true });
  });
  ok('a new session works from the shared list when all browser storage access is denied',
    (await listOn(deniedPage)).companies.length === store.watchlistSnapshot().count && !!(await listOn(deniedPage)).meta.error);
  await deniedPage.evaluate(async () => {
    wl.add('DENIEDNEW', 'New session addition', 'Tester');
    await wl.syncNow({ force: true });
    for (const [method, original] of Object.entries(originalStorage)) Storage.prototype[method] = original;
    await wl.syncNow({ force: true });
  });
  ok('restoring storage preserves unread legacy companies, old queued edits and new session edits',
    ['DENIEDOLD', 'DENIEDQUEUED', 'DENIEDNEW'].every(ticker => store.watchlistSnapshot().companies.some(c => c.ticker === ticker)));
  ok('restored storage clears the temporary-copy warning', !(await listOn(deniedPage)).meta.error);

  const unreadFixture = async initial => {
    const context = await browser.newContext();
    const page = await context.newPage();
    fixtures.push(context);
    page.on('pageerror', error => fixtureErrors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
    await page.goto(`${origin}/watchlist-fixture`);
    await page.evaluate(async entries => {
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      window.denyAll = true;
      window.denyOutbox = false;
      const original = Object.fromEntries(['getItem', 'setItem', 'removeItem'].map(key => [key, Storage.prototype[key]]));
      for (const method of Object.keys(original)) Storage.prototype[method] = function(key, ...args) {
        if (key.startsWith('sattva:watchlist') && (denyAll || (denyOutbox && method === 'setItem' && key === 'sattva:watchlist:outbox'))) throw new DOMException('Denied', 'SecurityError');
        return original[method].call(this, key, ...args);
      };
      window.wl = await import('/js/core/watchlist.js');
    }, initial);
    return page;
  };

  store.watchlistApply([{ op: 'add', ticker: 'UNREADCONFLICT', name: 'Original company', by: 'Tester' }]);
  const unread = await unreadFixture({ 'sattva:watchlist:seeded': '1', 'sattva:watchlist': JSON.stringify([{ ticker: 'UNREADCONFLICT', name: 'Original company' }]) });
  const unreadSibling = await unread.context().newPage();
  await unreadSibling.goto(`${origin}/watchlist-fixture`);
  await unreadSibling.evaluate(async () => { window.wl = await import('/js/core/watchlist.js'); });
  offline = true;
  await unread.evaluate(async () => { wl.add('UNREADCONFLICT', 'Older add', 'Tester'); await wl.syncNow({ force: true }); });
  await unreadSibling.evaluate(async () => { wl.remove('UNREADCONFLICT', 'Tester'); await wl.syncNow({ force: true }); });
  await unread.evaluate(() => { window.denyAll = false; });
  offline = false;
  await sync(unread);
  await sync(unreadSibling);
  ok('an initially unread outbox preserves the newer sibling action on the same ticker',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'UNREADCONFLICT'));

  for (const quotaBlocked of [false, true]) {
    const ticker = quotaBlocked ? 'RECOVERQUOTAOLD' : 'RECOVEROFFLINEOLD';
    const recoveredOld = await unreadFixture({ 'sattva:watchlist': JSON.stringify([{ ticker, name: 'Older saved company' }]) });
    offline = true;
    await sync(recoveredOld);
    await recoveredOld.evaluate(blocked => { window.denyAll = false; window.denyOutbox = blocked; }, quotaBlocked);
    await sync(recoveredOld);
    const retained = await recoveredOld.evaluate(ticker => ({
      visible: wl.has(ticker), saved: JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some(c => c.ticker === ticker),
      seeded: localStorage.getItem('sattva:watchlist:seeded'),
    }), ticker);
    ok(`storage recovery keeps the older list visible and saved while the server is offline (quota blocked: ${quotaBlocked})`,
      retained.visible && retained.saved && (!quotaBlocked || retained.seeded !== '1'));
    await recoveredOld.reload();
    ok(`the recovered older list survives reopening before migration can reach the server (quota blocked: ${quotaBlocked})`,
      (await listOn(recoveredOld)).companies.some(c => c.ticker === ticker));
    offline = false;
    await sync(recoveredOld);
    ok(`the preserved older company migrates on reconnection (quota blocked: ${quotaBlocked})`,
      store.watchlistSnapshot().companies.some(c => c.ticker === ticker));
  }

  console.log('\n— storage recovery across tabs —');
  const storageRace = await fixture({ 'sattva:watchlist:seeded': '1' });
  const storageSibling = await storageRace.context().newPage();
  await storageSibling.goto(`${origin}/watchlist-fixture`);
  await storageSibling.evaluate(async () => { window.wl = await import('/js/core/watchlist.js'); });
  await sync(storageRace);
  await storageRace.evaluate(() => {
    window.originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'sattva:watchlist:outbox') throw new DOMException('Full', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
  });
  offline = true;
  await storageRace.evaluate(async () => { wl.add('RECOVERLOCAL', 'Temporary edit', 'Tester'); await wl.syncNow({ force: true }); });
  await storageSibling.evaluate(async () => { wl.add('RECOVERSIBLING', 'Sibling edit', 'Tester'); await wl.syncNow({ force: true }); });
  await storageRace.evaluate(() => { Storage.prototype.setItem = originalSet; });
  offline = false;
  await sync(storageRace);
  await sync(storageSibling);
  ok('a recovered outbox write merges edits added by a sibling during the storage failure',
    ['RECOVERLOCAL', 'RECOVERSIBLING'].every(ticker => store.watchlistSnapshot().companies.some(c => c.ticker === ticker)));

  await storageRace.evaluate(() => {
    Storage.prototype.setItem = function(key, value) {
      if (key === 'sattva:watchlist:outbox') throw new DOMException('Full', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
  });
  offline = true;
  await storageRace.evaluate(async () => { wl.add('RECOVERCONFLICT', 'Older add', 'Tester'); await wl.syncNow({ force: true }); });
  await storageSibling.evaluate(async () => { wl.remove('RECOVERCONFLICT', 'Tester'); await wl.syncNow({ force: true }); });
  await storageRace.evaluate(() => { Storage.prototype.setItem = originalSet; });
  offline = false;
  await sync(storageRace);
  await sync(storageSibling);
  ok('a newer sibling unstar wins over an older unsaved add to the same company',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'RECOVERCONFLICT'));

  await storageRace.evaluate(() => {
    Storage.prototype.setItem = function(key, value) {
      if (key === 'sattva:watchlist:outbox') throw new DOMException('Full', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
  });
  offline = true;
  await storageRace.evaluate(async () => { wl.add('RECOVERREPEAT', 'Still unsaved', 'Tester'); await wl.syncNow({ force: true }); });
  await storageSibling.evaluate(async () => { wl.add('RECOVERFINISHED', 'Sibling saves first', 'Tester'); await wl.syncNow({ force: true }); });
  await sync(storageRace); // Merge the sibling once, while persistence still fails.
  offline = false;
  await sync(storageSibling);
  store.watchlistApply([{ op: 'remove', ticker: 'RECOVERFINISHED', by: 'Another device' }]);
  await storageRace.evaluate(() => { Storage.prototype.setItem = originalSet; });
  await sync(storageRace);
  ok('repeated persistence failures do not replay a sibling edit already acknowledged elsewhere',
    store.watchlistSnapshot().companies.some(c => c.ticker === 'RECOVERREPEAT') &&
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'RECOVERFINISHED'));

  await storageRace.evaluate(() => {
    window.originalRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key) {
      if (key === 'sattva:watchlist:outbox') throw new DOMException('Denied', 'SecurityError');
      return originalRemove.call(this, key);
    };
  });
  await storageRace.evaluate(async () => { wl.add('RECOVERACK', 'Already acknowledged', 'Tester'); await wl.syncNow({ force: true }); });
  store.watchlistApply([{ op: 'remove', ticker: 'RECOVERACK', by: 'Another device' }]);
  offline = true;
  await storageSibling.evaluate(async () => { wl.add('RECOVERKEEP', 'Keep sibling edit', 'Tester'); await wl.syncNow({ force: true }); });
  await storageRace.evaluate(() => { Storage.prototype.removeItem = originalRemove; });
  offline = false;
  await sync(storageRace);
  await sync(storageSibling);
  ok('recovering an acknowledged outbox removal retains newer sibling edits',
    store.watchlistSnapshot().companies.some(c => c.ticker === 'RECOVERKEEP'));
  ok('storage recovery never replays an already-acknowledged edit from stale disk bytes',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'RECOVERACK'));

  console.log('\n— recovered device mirrors and migration markers —');
  for (const withPending of [false, true]) {
    const oldTicker = withPending ? 'MIRROROLDPENDING' : 'MIRROROLD';
    const newTicker = withPending ? 'MIRRORNEWPENDING' : 'MIRRORNEW';
    store.watchlistApply([{ op: 'add', ticker: oldTicker, name: 'Older snapshot', by: 'Tester' }]);
    const mirror = await fixture({ 'sattva:watchlist:seeded': '1' });
    await sync(mirror);
    const sibling = await mirror.context().newPage();
    await sibling.goto(`${origin}/watchlist-fixture`);
    await sync(sibling);
    await mirror.evaluate(() => {
      window.originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'sattva:watchlist') throw new DOMException('Full', 'QuotaExceededError');
        return originalSet.call(this, key, value);
      };
    });
    await sync(mirror); // A server-confirmed list whose mirror could not be saved.
    store.watchlistApply([{ op: 'remove', ticker: oldTicker, by: 'Another device' },
      { op: 'add', ticker: newTicker, name: 'Newer snapshot', by: 'Another device' }]);
    await sync(sibling);
    offline = true;
    if (withPending) await mirror.evaluate(async () => { wl.add('MIRRORLOCAL', 'Pending local addition', 'Tester'); await wl.syncNow({ force: true }); });
    await mirror.evaluate(() => { Storage.prototype.setItem = originalSet; });
    await sync(mirror);
    const recovered = await listOn(mirror);
    ok(`recovery keeps the newer sibling mirror and outstanding edits while offline (pending: ${withPending})`,
      !recovered.companies.some(c => c.ticker === oldTicker) && recovered.companies.some(c => c.ticker === newTicker) &&
      (!withPending || recovered.companies.some(c => c.ticker === 'MIRRORLOCAL')));
    await mirror.reload();
    const reopened = await listOn(mirror);
    ok(`reopening retains the newer mirror after recovery (pending: ${withPending})`,
      !reopened.companies.some(c => c.ticker === oldTicker) && reopened.companies.some(c => c.ticker === newTicker) &&
      (!withPending || reopened.companies.some(c => c.ticker === 'MIRRORLOCAL')));
    offline = false;
    await sync(mirror);
  }

  // An absent server row is also the state of a removal whose tombstone expired.
  const seededMarker = await fixture({ 'sattva:watchlist:seeded': '1',
    'sattva:watchlist': JSON.stringify([{ ticker: 'SEEDEDMARKEROLD', name: 'Already migrated long ago' }]) });
  await seededMarker.evaluate(() => {
    window.originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === 'sattva:watchlist:seeded') throw new DOMException('Denied', 'SecurityError');
      return originalGet.call(this, key);
    };
  });
  await sync(seededMarker);
  ok('a failed migration-marker read cannot seed an established stale mirror again',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'SEEDEDMARKEROLD'));
  await seededMarker.evaluate(() => { Storage.prototype.getItem = originalGet; });
  await sync(seededMarker);
  ok('recovering the established migration marker leaves the old company removed',
    !store.watchlistSnapshot().companies.some(c => c.ticker === 'SEEDEDMARKEROLD') && !(await listOn(seededMarker)).meta.error);

  for (const withPending of [false, true]) {
    const ticker = withPending ? 'UNKNOWNSEEDPENDING' : 'UNKNOWNSEEDOLD';
    const initial = { 'sattva:watchlist': JSON.stringify([{ ticker, name: 'Never migrated' }]) };
    if (withPending) initial['sattva:watchlist:outbox'] = JSON.stringify([{ op: 'add', ticker: 'UNKNOWNSEEDNEW', by: 'Tester' }]);
    const unknownMarker = await fixture(initial);
    await unknownMarker.evaluate(() => {
      window.originalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        if (key === 'sattva:watchlist:seeded') throw new DOMException('Denied', 'SecurityError');
        return originalGet.call(this, key);
      };
    });
    await sync(unknownMarker);
    const retained = await unknownMarker.evaluate(ticker => ({
      visible: wl.has(ticker), saved: JSON.parse(localStorage.getItem('sattva:watchlist') || '[]').some(c => c.ticker === ticker),
      meta: wl.meta(),
    }), ticker);
    ok(`an unreadable migration marker preserves an unmigrated list before adoption (pending: ${withPending})`,
      retained.visible && retained.saved && !retained.meta.shared && !!retained.meta.error);
    await unknownMarker.evaluate(() => { Storage.prototype.getItem = originalGet; });
    await sync(unknownMarker);
    ok(`the unmigrated list and pending clicks are recovered after the marker becomes readable (pending: ${withPending})`,
      store.watchlistSnapshot().companies.some(c => c.ticker === ticker) &&
      (!withPending || store.watchlistSnapshot().companies.some(c => c.ticker === 'UNKNOWNSEEDNEW' && c.addedBy === 'Tester')));
  }

  console.log('\n— capacity refusals stay visible —');
  const capacity = await fixture({ 'sattva:watchlist:seeded': '1' });
  const room = 600 - store.watchlistSnapshot().count;
  for (let i = 0; i < room; i += 50) store.watchlistApply(Array.from({ length: Math.min(50, room - i) }, (_, j) => ({ op: 'add', ticker: `CAP${i + j}`, by: 'Tester' })));
  await sync(capacity);
  await capacity.evaluate(() => wl.add('CAPOVERFLOW', 'Rejected company', 'Tester'));
  await sync(capacity);
  ok('a full-list rejection remains visible after the successful follow-up read',
    (await listOn(capacity)).meta.error?.includes('CAPOVERFLOW'));
  await sync(capacity);
  ok('an ordinary poll cannot clear an unresolved capacity refusal',
    (await listOn(capacity)).meta.error?.includes('CAPOVERFLOW'));
  await capacity.reload();
  ok('an unresolved capacity refusal survives reopening the page',
    (await listOn(capacity)).meta.error?.includes('CAPOVERFLOW'));
  store.watchlistApply([{ op: 'remove', ticker: 'CAP0', by: 'Tester' }]);
  await capacity.evaluate(async () => { window.wl = await import('/js/core/watchlist.js'); wl.add('CAPOVERFLOW', 'Rejected company', 'Tester'); await wl.syncNow({ force: true }); });
  ok('a successful retry clears the refusal and shares the company',
    !(await listOn(capacity)).meta.error && store.watchlistSnapshot().companies.some(c => c.ticker === 'CAPOVERFLOW'));
  for (const context of fixtures) await context.close();

  const errors = [...laptop.errors, ...phone.errors, ...fixtureErrors];
  ok('no uncaught page errors anywhere in the run', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
