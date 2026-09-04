#!/usr/bin/env node
// Actual AI ranking and tab UI over deterministic local event fixtures. No production reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const feeds = ['earnings', 'announcements', 'insider'];
const eventsFor = (ticker, company, day = '2026-09-04') => feeds.map((feed, i) => ({
  id: `${ticker}-${feed}`, ticker, company, day, time: ['09:15', '11:10', '14:42'][i], feed, feedLabel: feed,
  headline: `${company}: material risk ${i + 1}`, direction: 'negative', importance: 'high', tab: 'daily-alerts',
}));
const events = Array.from({ length: 11 }, (_, i) => eventsFor(`A${String(i).padStart(2, '0')}`, i === 10 ? 'Zenith Manufacturing' : `Company ${String(i).padStart(2, '0')}`)).flat();
events.find((e) => e.ticker === 'A01').time = null;
events.push({ ...events[30], id: 'hidden-event', importance: 'low', headline: 'Lithium supply agreement hidden beyond the evidence preview' });
events.push(...eventsFor('OLD', 'Old signal', '2026-08-29'));
events.push({ ...events[1], id: 'important-event', ticker: 'ZIMP', company: 'Important Company', direction: 'neutral' });
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="padding:24px;background:#f6f4fb;font-family:Arial,sans-serif"><main id="root" class="mx-auto max-w-7xl"></main>
<script>window.fixtureEvents=${JSON.stringify(events)};window.reads=0;</script>
<script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import * as coverage from '/js/data/coverage.js';
import * as refresh from '/js/core/refresh.js';
coverage.prime({holdings:[...new Map(window.fixtureEvents.map(e=>[e.ticker,{ticker:e.ticker,name:e.company}])).values()]});
window.show=(scope='portfolio')=>tab.render({root:document.querySelector('#root'),scope,params:{}});
window.dispose=()=>tab.destroy();
window.refreshAlerts=()=>refresh.refreshAll();
window.show();
</script></body></html>`;
const fixtureModule = `
export { currentDay as today } from '../ui/ai-alert-utils.js';
import { currentDay } from '../ui/ai-alert-utils.js';
export async function collect({scope,onPartial}) {
  window.reads++;
  const report=()=>({day:currentDay(),scope,events:window.fixtureEvents,feeds:${JSON.stringify(feeds.map((id) => ({ id, status: 'ok', reachesToday: true })))},pending:0});
  onPartial?.({...report(),pending:1});
  if(window.holdRead) await new Promise(done=>window.releaseRead=done);
  return report();
}`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (pathname === '/js/data/daily-alerts.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixtureModule); return; }
    const path = resolve(root, '.' + pathname);
    if (!path.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
// A browser in California must still roll the Indian market date at 18:30 UTC.
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'America/Los_Angeles' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
const settled = () => page.waitForFunction(() => document.querySelector('[data-ai-feed-status]')?.dataset.state === 'complete');
const card = (ticker) => page.locator(`[data-ai-card][data-ticker="${ticker}"]`);
try {
  await page.clock.install({ time: '2026-09-04T18:29:00Z' });
  await page.clock.pauseAt('2026-09-04T18:29:58Z');
  await page.goto(origin);
  await settled();
  assert.equal(await page.locator('[data-ai-card]').count(), 8);
  assert.equal(await card('A10').count(), 0, 'target starts beyond the first page');
  const search = page.getByRole('searchbox', { name: 'Search AI Alerts' });
  await search.fill('lithium supply');
  assert.equal(await page.locator('[data-ai-card]').count(), 1);
  assert.equal(await card('A10').count(), 1, 'search finds hidden evidence beyond page one');
  assert(!(await card('A10').locator('[data-ai-evidence]').innerText()).includes('Lithium'), 'match is outside the evidence preview');
  assert(await search.evaluate((el) => el === document.activeElement));
  await search.fill('ZENITH MANUFACTURING');
  assert.equal(await card('A10').count(), 1, 'case-insensitive company search');
  await card('A10').locator('[data-ai-mute]').click();
  assert.equal(await card('A10').count(), 0);
  await page.locator('[data-ai-filter="archived"]').click();
  assert.equal(await card('A10').count(), 1, 'same search reaches archived cards');
  await card('A10').locator('[data-ai-unmute]').click();
  await page.locator('[data-ai-filter="all"]').click();
  assert.equal(await card('A10').count(), 1);
  await page.locator('[data-ai-filter="important"]').click();
  assert.equal(await page.locator('[data-ai-card]').count(), 0, 'search composes with priority');
  await page.locator('[data-ai-clear]').click();
  assert.equal(await card('ZIMP').count(), 1);
  await page.locator('[data-ai-filter="all"]').click();
  await search.fill('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('[data-ai-empty] img').count(), 0, 'search is escaped in the empty state');
  await page.locator('[data-ai-empty-clear]').click();
  assert.equal(await search.inputValue(), '');
  assert.equal(await page.locator('[data-ai-card]').count(), 8);
  console.log('PASS: search beyond pagination and preview, priority, archive/restore and clear search.');

  await page.evaluate(() => { window.holdRead = true; void window.refreshAlerts(); });
  await page.waitForFunction(() => !!window.releaseRead);
  await search.fill('A00');
  await search.evaluate((el) => { el.setSelectionRange(1, 2); window.inputBefore = el; });
  await page.evaluate(() => { window.holdRead = false; window.releaseRead(); });
  await settled();
  assert.deepEqual(await search.evaluate((el) => [el === window.inputBefore, el === document.activeElement, el.selectionStart, el.selectionEnd]), [true, true, 1, 2]);
  assert.equal(await search.inputValue(), 'A00', 'feed completion preserves query and input');
  assert((await card('A00').locator('[data-ai-date]').innerText()).includes('04 Sept 2026 · 14:42 IST'));
  assert.equal(await card('A00').locator('[data-ai-date] time').getAttribute('datetime'), '2026-09-04T14:42:00+05:30');
  await search.fill('A01');
  assert(!(await card('A01').locator('[data-ai-date]').innerText()).includes('IST'), 'mixed day precision does not invent a latest clock');
  assert.equal(await card('A01').locator('[data-ai-date] time').getAttribute('datetime'), '2026-09-04');
  await page.locator('[data-ai-clear]').click();
  await page.locator('[data-ai-more]').click();
  assert.equal(await card('OLD').count(), 1);
  await search.fill('A00');
  await page.clock.runFor(2100);
  await settled();
  assert.equal((await card('A00').locator('[data-ai-date] [data-ai-age]').innerText()).toLowerCase(), '1d');
  assert.deepEqual(await card('A00').locator('[data-ai-evidence] [data-ai-age]').allTextContents(), ['1d', '1d', '1d']);
  assert.equal(await search.inputValue(), 'A00');
  await search.fill('OLD');
  assert.equal(await card('OLD').count(), 0, 'expired evidence leaves the rolling window at IST midnight');
  // Simulate a laptop sleeping past the next midnight; visibility return must re-age immediately.
  await search.fill('A00');
  await page.clock.setSystemTime('2026-09-05T18:31:00Z');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await settled();
  assert.equal((await card('A00').locator('[data-ai-date] [data-ai-age]').innerText()).toLowerCase(), '2d');
  console.log('PASS: stable input during feed updates, source time precision, midnight rollover, stale window expiry and resume after sleep.');

  await page.locator('[data-ai-clear]').click();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `no page overflow at ${width}px`);
    const inputBox = await search.boundingBox();
    assert(inputBox.width > 120 && inputBox.x >= 0 && inputBox.x + inputBox.width <= width);
    if (process.env.AI_ALERT_SCREENSHOT && [1440, 390].includes(width)) await page.screenshot({ path: `${process.env.AI_ALERT_SCREENSHOT}-${width}.png` });
  }
  await page.evaluate(() => window.dispose());
  const reads = await page.evaluate(() => window.reads);
  await page.clock.runFor(86_400_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.evaluate(() => window.reads), reads, 'destroy removes calendar timer and listeners');
  assert.deepEqual(errors, []);
  console.log('PASS: responsive search/cards at 320–1440px, calendar cleanup and zero application errors.');
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
