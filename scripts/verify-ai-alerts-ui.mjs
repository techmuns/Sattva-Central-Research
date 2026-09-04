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
const holdings = [...new Map(events.map(e => [e.ticker, { ticker: e.ticker, name: e.company }])).values()]
  .map((h, i, list) => ({ ...h, isin: `INE${String(i).padStart(9, '0')}`, sector: 'Test', weightPct: 100 / list.length }));
const familyOrigin = 'https://sattva-family.pages.dev';
const familyHtml = `<script>
window.book=${JSON.stringify(holdings)}; window.holdPositions=true; window.failed=false; window.version=1;
const send=data=>parent.postMessage({channel:'sattva-portfolio-v1',...data},'*');
window.invalidate=()=>send({type:'invalidated',version:++window.version});
window.ready=()=>send({type:'positions-ready',version:window.version});
window.lock=()=>send({type:'auth-required'});
addEventListener('message',e=>{
 if(e.source!==parent || e.data.channel!=='sattva-portfolio-v1') return;
 const {id,type}=e.data;
 if(type==='hello') {send({id,type:'ready',capabilities:['position-sizes']}); return;}
 if(type!=='positions') return;
 const reply=()=>window.failed ? send({id,type:'error',message:'Fixture workbook unavailable'}) : send({id,type:'result',holdings:window.book,
 sizes:{basis:'listed-market-value',complete:true,bookAsOf:'2026-08-31',checkedAt:new Date().toISOString(),archiveVersion:window.version,quotes:{}}});
 if(window.holdPositions) window.releasePositions=()=>{window.holdPositions=false;window.releasePositions=null;reply();}; else reply();
});
</script>`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="padding:24px;background:#f6f4fb;font-family:Arial,sans-serif"><main id="root" class="mx-auto max-w-7xl"></main>
<script>window.fixtureEvents=${JSON.stringify(events)};window.reads=0;</script>
<script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import * as coverage from '/js/data/coverage.js';
import * as refresh from '/js/core/refresh.js';
coverage.prime({holdings:${JSON.stringify(holdings)}});
window.show=(scope='portfolio')=>tab.render({root:document.querySelector('#root'),scope,params:{}});
window.dispose=()=>tab.destroy();
window.refreshAlerts=()=>refresh.refreshAll();
window.show();
</script></body></html>`;
const fixtureModule = `
export { currentDay as today } from '../ui/ai-alert-utils.js';
import { currentDay } from '../ui/ai-alert-utils.js';
export async function collect({scope,onPartial,holdings,load=true}) {
  if(load) window.reads++;
  if(load && window.holdStart) await new Promise(done=>window.releaseStart=done);
  const wanted=new Set(holdings.map(h=>h.ticker));
  const events=window.fixtureEvents.filter(e=>scope==='universe' || wanted.has(e.ticker));
  const report=()=>({day:currentDay(),scope,events,feeds:${JSON.stringify(feeds.map((id) => ({ id, status: 'ok', reachesToday: true })))},pending:0});
  onPartial?.({...report(),events:window.partialEvents || events,pending:1});
  if(load && window.holdRead) await new Promise(done=>window.releaseRead=done);
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
await page.route('**/*', route => route.request().url() === `${familyOrigin}/research-bridge`
  ? route.fulfill({ contentType:'text/html', body:familyHtml })
  : route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
// Browser clocks are paused for midnight tests; poll postMessage completion with
// the test runner's real clock rather than a frozen requestAnimationFrame loop.
const waitFor = async (target, condition) => {
  const deadline = Date.now() + 10000;
  while (!await target.evaluate(condition)) {
    assert(Date.now() < deadline, `Timed out: ${condition}`);
    await new Promise(done => setTimeout(done, 20));
  }
};
const settled = () => waitFor(page, () => document.querySelector('[data-ai-feed-status]')?.dataset.state === 'complete');
const card = (ticker) => page.locator(`[data-ai-card][data-ticker="${ticker}"]`);
try {
  await page.clock.install({ time: '2026-09-04T18:29:00Z' });
  await page.clock.pauseAt('2026-09-04T18:29:58Z');
  await page.goto(origin);
  await page.locator('[data-ai-card]').first().waitFor();
  await page.clock.runFor(300);
  const peer = await (await page.locator('iframe').elementHandle()).contentFrame();
  await waitFor(peer, () => !!window.releasePositions);
  assert.equal(await page.locator('[data-ai-card]').count(), 8, 'cold-load evidence does not wait for holding sizes');
  await peer.evaluate(() => window.releasePositions());
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

  await page.evaluate(() => {
    window.originalCard = document.querySelector('[data-ai-card]');
    window.holdRead = true; window.partialEvents = [];
    void window.refreshAlerts();
  });
  await waitFor(page, () => !!window.releaseRead);
  assert.equal(await page.locator('[data-ai-card]').count(), 8, 'empty refresh partials cannot clear the last completed view');
  assert(await page.evaluate(() => document.querySelector('[data-ai-card]') === window.originalCard), 'unchanged cards keep their DOM during refresh');
  await search.fill('A00');
  await search.evaluate((el) => { el.setSelectionRange(1, 2); window.inputBefore = el; });
  await page.evaluate(() => { window.holdRead = false; window.partialEvents = null; window.releaseRead(); });
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
  // runFor advances the parent and cross-origin frame clocks separately. Deliver the
  // fresh source reply after both have advanced, avoiding an artificial stale timestamp.
  await peer.evaluate(() => { window.holdPositions = true; });
  await page.clock.runFor(2100);
  await waitFor(peer, () => !!window.releasePositions);
  await peer.evaluate(() => window.releasePositions());
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
  await page.setViewportSize({ width: 1440, height: 1100 });
  await search.fill('A00');
  await peer.evaluate(() => { window.holdPositions = true; window.invalidate(); });
  assert.equal(await card('A00').count(), 1, 'archive invalidation keeps the existing card');
  await peer.evaluate(() => window.ready());
  await waitFor(peer, () => !!window.releasePositions);
  assert.equal(await card('A00').count(), 1, 'card remains throughout a slow holding-size check');
  assert.equal(await search.inputValue(), 'A00');
  await peer.evaluate(() => window.releasePositions());
  await settled();
  assert.equal(await card('A00').count(), 1);
  await peer.evaluate(() => { window.failed = true; });
  const failed = await page.evaluate(() => window.refreshAlerts());
  assert(failed.results.some(r => /Fixture workbook unavailable/.test(r.error)), 'header Refresh reports the failure');
  assert.equal(await card('A00').count(), 1, 'a portfolio outage keeps alert evidence visible');
  assert.equal(await page.locator('[data-ai-holding-size]').count(), 0, 'unverified sizes are removed');
  assert.match(await page.locator('[data-ai-error]').innerText(), /Showing available alerts/);
  assert.equal(await page.evaluate(async () => (await import('/js/data/coverage.js')).meta().syncStatus), 'family-unavailable');
  // Background rechecks may send invalidated and then fail without ever sending
  // positions-ready. Repeated failures must leave a warning, not a stuck spinner.
  for (let attempt = 0; attempt < 2; attempt++) {
    await peer.evaluate(() => window.invalidate());
    await waitFor(page, () => document.querySelector('[data-ai-feed-status]')?.dataset.state === 'pending');
    await page.evaluate(async () => { try { await (await import('/js/research/portfolio-bridge.js')).readPositionSizes(); } catch {} });
    assert.equal(await page.locator('[data-ai-feed-status]').getAttribute('data-state'), 'error');
    assert.equal(await card('A00').count(), 1, 'a repeated background failure preserves the evidence');
  }
  await peer.evaluate(() => { window.failed = false; });
  await page.evaluate(() => window.refreshAlerts());
  await settled();
  assert.equal(await page.locator('[data-ai-error]').count(), 0);
  await peer.evaluate(() => { window.holdPositions = true; });
  await page.evaluate(() => { window.dispose(); document.querySelector('#root').innerHTML = ''; window.show(); });
  assert.equal(await card('A00').count(), 1, 'return visits immediately restore the last view');
  assert.equal(await search.inputValue(), 'A00');
  await waitFor(peer, () => !!window.releasePositions);
  await page.evaluate(() => window.show('universe'));
  await settled();
  await peer.evaluate(() => window.releasePositions());
  assert.match(await page.locator('[data-ai-heading]').innerText(), /Universe/);
  assert.equal(await page.locator('[data-ai-holding-size]').count(), 0, 'late portfolio replies cannot overwrite another scope');
  await page.evaluate(() => window.show());
  await settled();
  await peer.evaluate(() => {
    window.book = window.book.filter(h => h.ticker !== 'A00').map((h, _, list) => ({ ...h, weightPct:100/list.length }));
    window.invalidate(); window.ready();
  });
  await waitFor(page, () => !document.querySelector('[data-ai-card][data-ticker="A00"]'));
  await settled();
  assert.equal(await card('A00').count(), 0, 'a verified exit removes the old holding');
  await search.fill('A00');
  await page.evaluate(() => window.show('universe'));
  await settled();
  assert(!/in portfolio/i.test(await card('A00').innerText()), 'the active private book excludes the exited company');
  await peer.evaluate(() => window.lock());
  await waitFor(page, async () => (await import('/js/research/portfolio-bridge.js')).portfolioConnectionState() === 'locked');
  await settled();
  assert(/in portfolio/i.test(await card('A00').innerText()), 'sign-out recomputes Universe membership from the public book');
  await page.evaluate(() => window.show());
  await settled();
  await page.evaluate(() => { window.dispose(); document.querySelector('#root').innerHTML = ''; });
  await peer.evaluate(() => { window.holdPositions = true; window.lock(); });
  await waitFor(page, async () => (await import('/js/research/portfolio-bridge.js')).portfolioConnectionState() === 'locked');
  await page.evaluate(() => { window.holdStart = true; window.show(); window.cardsAtReturn = document.querySelectorAll('[data-ai-card]').length; });
  assert.equal(await page.evaluate(() => window.cardsAtReturn), 0, 'sign-out revokes the cached view even while unmounted');
  assert.equal(await page.locator('[data-ai-holding-size]').count(), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct')), false);
  console.log('PASS: cold load, atomic refresh, archive recheck, failure/recovery, return visits, scope races, verified exits and sign-out.');
  await page.evaluate(() => { window.dispose(); window.holdStart = false; window.releaseStart(); });
  const reads = await page.evaluate(() => window.reads);
  await page.clock.runFor(86_400_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.evaluate(() => window.reads), reads, 'destroy removes calendar timer and listeners');
  assert.deepEqual(errors, []);
  console.log('PASS: responsive search/cards at 320–1440px, calendar cleanup and zero application errors.');
} catch (error) {
  console.error('Browser errors:', errors, (await page.locator('body').innerText()).slice(0, 2000));
  throw error;
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
