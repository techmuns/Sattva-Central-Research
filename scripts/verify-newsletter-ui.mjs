#!/usr/bin/env node
// THE NEWSLETTER CONTROL, DRIVEN THROUGH THE REAL UI AGAINST THE REAL ROUTE AND STORE.
//
// The fixture server serves public/ and answers /api/newsletter* by calling `handleNewsletter`
// itself — the same function the Worker runs — over a `NewsletterStore` on node:sqlite and a
// `NewsletterSchedule` whose fetcher answers Yahoo, NSE and the email endpoint from fixtures. So
// this exercises the whole path (button → panel → route → store → schedule → email request) with
// no wrangler, no egress and no second copy of the rules that could drift from the deployed one.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { NewsletterStore, NEWSLETTER_OBJECT } from '../worker/newsletter-store.mjs';
import { NewsletterSchedule, EMAIL_SEND_URL } from '../worker/newsletter-schedule.mjs';
import { handleNewsletter } from '../worker/newsletter.mjs';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
// A screenshot taken the instant the form appears catches the 180ms `brief-enter` animation
// mid-flight, so an opaque panel photographs as a translucent one. Wait for it to settle.
const settled = async (locator) => { await locator.evaluate((n) => Promise.all(n.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))); };

const fixture = (name) => readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8');

// ---- the stand-in Worker ---------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
const kv = new Map();
let alarm = null;
let tail = Promise.resolve();
const storage = {
  sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
  transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  get: async (key) => structuredClone(kv.get(key)),
  put: async (key, value) => { kv.set(key, structuredClone(value)); },
  getAlarm: async () => alarm,
  setAlarm: async (value) => { alarm = value; },
  deleteAlarm: async () => { alarm = null; },
  transaction(fn) { const result = tail.then(() => fn(storage)); tail = result.catch(() => {}); return result; },
};
const emails = [];
const fetcher = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://query1.finance.yahoo.com/')) return new Response(fixture('yahoo-sp500.json'), { headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://nsearchives.nseindia.com/')) return new Response(fixture('nse-announcements.xml'), { headers: { 'content-type': 'application/xml' } });
  if (url === EMAIL_SEND_URL) {
    const body = JSON.parse(init.body);
    emails.push({ to: body.email, subject: body.subject, html: body.html, hasText: body.text !== undefined, auth: init.headers.authorization });
    return Response.json({ data: { message: 'Email sent successfully!' }, message: '', success: true });
  }
  throw new Error(`unexpected upstream ${url}`);
};
const assets = { fetch: async (request) => { const path = new URL(request.url).pathname; try { return new Response(readFileSync(resolve(root, `.${path}`)), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('', { status: 404 }); } } };
let tokenConfigured = true;
const envFor = () => ({ ASSETS: assets, ...(tokenConfigured ? { MUNS_TOKEN: 'team-token' } : {}), DASHBOARD_ORIGIN: 'https://example.test' });
const store = new NewsletterStore(storage);
const schedule = () => new NewsletterSchedule(storage, envFor(), store, { fetcher });
// The object surface the route talks to, exactly as capture-registry-object.mjs exposes it.
const object = {
  newsletterSnapshot: () => store.snapshot(),
  newsletterStatus: async () => { await schedule().arm(); return schedule().status(); },
  newsletterApply: async ({ intents = null, settings = null } = {}) => {
    const out = { outcomes: [], settingsChanged: false };
    if (settings) out.settingsChanged = store.setSettings(settings).changed;
    if (intents) out.outcomes = store.apply(intents).outcomes;
    await schedule().arm();
    return { ...out, snapshot: store.snapshot(), schedule: await schedule().status() };
  },
  newsletterSend: (input, token) => schedule().sendNow(input, token),
  newsletterPreview: (input) => schedule().preview(input),
};
let offline = false;
let mode = 'worker'; // worker | static
const env = () => ({ ...envFor(), NEWSLETTER: { getByName: (name) => { assert.equal(name, NEWSLETTER_OBJECT); return object; } }, NEWSLETTER_LIMITER: { limit: async () => ({ success: true }) } });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/newsletter')) {
    if (mode === 'static') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>not found</html>'); return; }
    if (offline) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":false,"reason":"newsletter-unavailable"}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    try {
      const response = await handleNewsletter(request, env());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      // A throw here would leave the browser waiting for ever; name it and answer.
      console.error('  fixture route failed:', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false,"reason":"fixture-error"}');
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}'); return; }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(file)] || 'text/html');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
let checks = 0;
const ok = (name, pass, detail = '') => { checks++; if (!pass) failures++; console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/research/insider-trades?scope=portfolio`);
  const button = () => page.locator('[data-brief-button]');
  const panel = () => page.getByRole('dialog', { name: 'Newsletter', exact: true });
  await button().waitFor();

  console.log('\n— the button —');
  const placement = await page.evaluate(() => {
    const b = document.querySelector('[data-brief-button]');
    const bell = document.querySelector('[data-notification-bell]');
    const bookmarks = document.querySelector('[data-header-bookmarks]');
    return {
      inHeader: !!b.closest('[data-app-header]'),
      leftOfBell: b.getBoundingClientRect().right <= bell.getBoundingClientRect().left && b.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING,
      rightOfBookmarks: bookmarks.getBoundingClientRect().right <= b.getBoundingClientRect().left,
      label: b.textContent.trim(),
      height: b.getBoundingClientRect().height,
    };
  });
  ok('one Newsletter button in the header, immediately left of the bell', placement.inHeader && placement.leftOfBell && placement.rightOfBookmarks, JSON.stringify(placement));
  ok('...labelled Newsletter, with no dot before anything has been read', placement.label === 'Newsletter' && !(await page.locator('[data-brief-dot]').isVisible()));
  ok('...and it fetched nothing on page load', (await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/newsletter')).length)) === 0);

  console.log('\n— the panel —');
  await button().click();
  await panel().waitFor();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('opens on the reader\'s own email and a Subscribe button, opaque over the page', await panel().evaluate((n) => /^rgb\(/.test(getComputedStyle(n).backgroundColor)) && (await page.locator('[data-brief-form="me"] button[type="submit"]').innerText()) === 'Subscribe');
  const shape = await panel().evaluate((n) => ({
    inputs: n.querySelectorAll('input').length,
    names: n.querySelectorAll('input[name="by"]').length,
    checks: n.querySelectorAll('input[type="checkbox"], input[type="time"], select').length,
    sends: n.querySelectorAll('[data-brief-action^="send"]').length,
    lede: n.querySelector('.brief-lede')?.textContent || '',
  }));
  ok('...and stays simple: two email fields, no name, no ticks, no times, no send buttons', shape.inputs === 2 && shape.names === 0 && shape.checks === 0 && shape.sends === 0, JSON.stringify(shape));
  ok('...with one line saying what it is and when it sends', /portfolio companies by email at 8:00 AM and 4:00 PM IST, weekdays/.test(shape.lede), shape.lede);
  await page.keyboard.press('Escape');
  ok('Escape closes it and returns focus to the button', !(await panel().isVisible()) && (await button().evaluate((n) => n === document.activeElement)));

  console.log('\n— subscribing —');
  await button().click();
  await page.locator('[data-brief-form="me"] input[name="email"]').fill('Pratik@Muns.io');
  await page.locator('[data-brief-form="me"] button[type="submit"]').click();
  await page.locator('.brief-you').waitFor().catch(async (error) => { console.error('  panel said:', await page.locator('.brief-body').innerText()); throw error; });
  ok('subscribing shows "Subscribed as" with the normalised address', (await page.locator('.brief-you').innerText()).includes('pratik@muns.io'));
  ok('...the button now carries the subscribed dot', await page.locator('[data-brief-dot]').isVisible());
  const first = store.snapshot().subscribers[0];
  ok('...and the store holds one row, both editions, attributed without asking for a name', store.snapshot().count === 1 && JSON.stringify(first?.editions) === '["morning","evening"]' && first?.addedBy === 'pratik@muns.io', JSON.stringify(first));
  ok('...with the alarm armed for the next weekday send', alarm != null);

  console.log('\n— the team —');
  await page.locator('[data-brief-form="add"] input[name="email"]').fill('meera@muns.io');
  await page.locator('[data-brief-form="add"] button[type="submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.brief-row')].some((r) => r.textContent.includes('meera@muns.io')));
  ok('adding a teammate lists them under Also receiving and clears the field', store.snapshot().count === 2 && (await page.locator('[data-brief-form="add"] input[name="email"]').inputValue()) === '');
  await page.locator('[data-brief-action="remove"][data-email="meera@muns.io"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.brief-row')].some((r) => r.textContent.includes('meera@muns.io')));
  ok('...and × removes them', store.snapshot().count === 1);

  console.log('\n— the whole team at once —');
  // The desk copies a column of addresses out of a table, so the paste arrives with NEWLINES — which
  // a single-line field strips rather than separates on, merging six addresses into one that never
  // existed. Driven as a real paste event, because `fill()` sets the value and would not exercise it.
  const team = ['bharat@example.test', 'gaurav@example.test', 'prateek@example.test', 'ashwini@example.test', 'ankita@example.test', 'yamini@example.test'];
  await page.evaluate((text) => {
    const field = document.querySelector('form[data-brief-form="add"] input[name="email"]');
    const data = new DataTransfer();
    data.setData('text/plain', text);
    field.focus();
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, team.join('\n'));
  const pasted = await page.locator('[data-brief-form="add"] input[name="email"]').inputValue();
  ok('a column of addresses pasted with newlines stays six addresses, not one merged string', pasted === team.join(', '), pasted);
  await page.locator('[data-brief-form="add"] button[type="submit"]').click();
  await page.waitForFunction((n) => document.querySelectorAll('.brief-row').length === n, team.length);
  const held = store.snapshot().subscribers;
  ok('...and one Add puts every one of them on the list, in one edit, each attributed to the reader',
    team.every((e) => held.some((s) => s.email === e)) && held.length === team.length + 1 && held.every((s) => s.addedBy === 'pratik@muns.io'), held.map((s) => s.email).join(','));
  ok('...with the note counting what the SERVER did, not what was sent', /\b6 added\b/.test(await page.locator('.brief-note').innerText()));
  // A batch is one request, so a duplicate inside it is the store's answer rather than a refusal.
  await page.locator('[data-brief-form="add"] input[name="email"]').fill(`${team[0]}, kiran@example.test`);
  await page.locator('[data-brief-form="add"] button[type="submit"]').click();
  await page.waitForFunction(() => /already on the list/.test(document.querySelector('.brief-note')?.textContent || ''));
  ok('...and re-adding someone already there says so beside the one that was new', store.snapshot().count === team.length + 2 && /added/.test(await page.locator('.brief-note').innerText()));
  await page.locator('[data-brief-action="remove"][data-email="kiran@example.test"]').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.brief-row')].some((r) => r.textContent.includes('kiran@')));
  const before = store.snapshot().count;
  await page.locator('[data-brief-form="add"] input[name="email"]').fill('ravi@example.test, nope, sana@example.test');
  await page.locator('[data-brief-form="add"] button[type="submit"]').click();
  await page.locator('.brief-note[data-tone="error"]').waitFor();
  ok('a token that is not an address refuses the WHOLE paste, names it, and keeps the text to correct',
    store.snapshot().count === before
    && (await page.locator('.brief-note').innerText()).includes('"nope"')
    && (await page.locator('[data-brief-form="add"] input[name="email"]').inputValue()).includes('ravi@example.test'));
  await page.locator('[data-brief-form="add"] input[name="email"]').fill('');

  console.log('\n— preview —');
  const [preview] = await Promise.all([context.waitForEvent('page'), page.locator('[data-brief-action="preview"][data-edition="evening"]').click()]);
  await preview.waitForLoadState();
  ok('Preview Evening opens the edition as it would send now, in a new tab', /^Sattva Ventures · \d+ updates?/.test(await preview.title()) && (await preview.locator('body').innerText()).includes('SATTVA VENTURES') && new URL(preview.url()).searchParams.get('edition') === 'evening');
  await preview.close();
  ok('...and nothing was emailed from the panel', emails.length === 0);

  console.log('\n— states —');
  await page.keyboard.press('Escape');
  tokenConfigured = false;
  await button().click();
  await page.locator('.brief-token').waitFor();
  ok('with no token on the Worker one quiet line names the secret', (await page.locator('.brief-token').innerText()).includes('MUNS_TOKEN'));
  tokenConfigured = true;
  await page.locator('[data-brief-action="unsubscribe-me"]').click();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('Unsubscribe removes only the reader and clears the dot', !(await page.locator('[data-brief-dot]').isVisible()) && store.snapshot().count === team.length && !store.snapshot().subscribers.some(row => row.email === 'pratik@muns.io'));
  await page.keyboard.press('Escape');
  offline = true;
  await button().click();
  await page.locator('.brief-empty').waitFor();
  ok('an unreachable service is named as such, with a retry', (await page.locator('.brief-empty').innerText()).includes("Couldn't reach") && (await page.locator('[data-brief-action="retry"]').count()) === 1);
  offline = false;
  await page.locator('[data-brief-action="retry"]').click();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('...and retrying recovers', true);
  await page.keyboard.press('Escape');
  mode = 'static';
  await page.reload();
  await button().waitFor();
  await button().click();
  await page.locator('.brief-empty').waitFor();
  ok('a static origin says the newsletter is not part of this deployment — never an error', (await page.locator('.brief-empty').innerText()).includes("isn't part of this deployment"));
  mode = 'worker';
  await page.keyboard.press('Escape');

  console.log('\n— unsubscribe link, appearance, small screens —');
  await page.goto(`${base}/#/research/insider-trades?scope=portfolio&newsletter=manage`);
  await panel().waitFor();
  ok('the email\'s Unsubscribe link (?newsletter=manage) opens straight onto the panel', await panel().isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sattvaTheme.toggle());
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  const dark = await panel().evaluate((n) => getComputedStyle(n).backgroundColor);
  ok('the dark panel paints an opaque dark surface', /^rgb\(/.test(dark) && dark !== 'rgb(255, 255, 255)', dark);
  await settled(panel());
  await page.screenshot({ path: '/tmp/sattva-newsletter-dark.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sattvaTheme.toggle());
  await page.setViewportSize({ width: 390, height: 844 });
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  const bounds = await panel().boundingBox();
  ok('on a phone the panel stays inside the viewport and the page does not scroll sideways',
    bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845 && (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)), JSON.stringify(bounds));
  ok('...and the button is a 44px touch target', (await button().boundingBox()).height >= 44);

  await settled(panel());
  await page.screenshot({ path: '/tmp/sattva-newsletter-mobile.png' });
  await page.keyboard.press('Escape');
  // Ask Research is the landing tab and reserves its viewport for the answer, so at 560px and under
  // the control cluster is flattened into the header row and this button is ordered up beside the
  // scope toggle at 2rem. That is a deliberate trade against the 44px target above — a fourth 44px
  // icon does not fit beside the status pill at 390px and wrapping the cluster costs the transcript
  // a whole 44px row (scripts/verify-research-stream-ui.mjs asserts that reading space). Assert the
  // exception rather than leaving it to hold by accident of which route this suite happens to open.
  await page.goto(`${base}/#/research/ask-research?scope=portfolio`);
  // The header mounts before the destination workspace; compact styling depends on that workspace.
  await page.locator('.research-workspace').waitFor();
  await button().waitFor();
  const compact = await button().evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), label: n.getAttribute('aria-label'), name: (n.textContent || '').trim() };
  });
  ok('on Ask Research at 390px it stays visible and named, at the compact size that keeps the answer its row',
    compact.w >= 32 && compact.h >= 32 && compact.w <= 36 && /Newsletter/.test(compact.label || '') && /Newsletter/.test(compact.name),
    JSON.stringify(compact));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  await settled(panel());
  await page.screenshot({ path: '/tmp/sattva-newsletter-desktop.png' });

  ok('zero page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${checks - failures} of ${checks} passed`);
if (failures) process.exit(1);
