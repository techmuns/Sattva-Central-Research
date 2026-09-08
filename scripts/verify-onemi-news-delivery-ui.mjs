#!/usr/bin/env node
// Local All Alerts rendering with controlled read completion. Real identity/search/signal code;
// only collection timing is replaced so slow/failed sources are deterministic, never production.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const fixtureModule = `
export * from './daily-alerts-real.js';
export async function collect(options) {
  (window.fixtureReads ||= []).push({refresh:options.refresh,load:options.load});
  window.fixtureOptions = options;
  return new Promise(resolve => { window.fixtureRelease = resolve; });
}
`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="padding:16px;background:#f6f7fb"><main id="root"></main><script type="module">
import * as tab from '/js/tabs/daily-alerts.js';
import * as real from '/js/data/daily-alerts-real.js';
import * as coverage from '/js/data/coverage.js';
import * as refresh from '/js/core/refresh.js';
import { attributeNewsRow } from '/js/data/company-news-attribution.js';
import { portfolioNewsEntities } from '/js/data/company-news-identity.js';
const holdings = [{ticker:'KISSHT',isin:'INE12F801023',name:'OnEMI Technology Solutions'}];
coverage.prime({holdings});
const identity = portfolioNewsEntities(holdings)[0];
const raw = {title:'JM Financial initiates coverage on OnEMI Technology with Buy call, sees 28% upside',source:'The Economic Times',url:'https://example.test/onemi-et',date:'2026-09-04',publishedAt:'2026-09-04T07:18:00Z'};
const event = (row) => ({...real.newsSignal(row),id:row.url,sourceRecord:row,headline:row.title,detail:'Published by '+row.source,company:row.company,ticker:row.ticker,entityId:row.entityId,day:row.date,time:'12:48',at:row.publishedAt,url:row.url,feed:'news',feedLabel:'Company news'});
window.fixtureStory = event(attributeNewsRow(raw,identity));
window.fixtureNoise = event(attributeNewsRow({...raw,title:'Kiss band announces concert',url:'https://example.test/kiss-band',date:'2026-09-07'},identity));
window.fixtureReport = (events,status='ok',day='2026-09-07') => ({scope:'portfolio',includeHistory:true,day,events,feeds:[{id:'news',label:'Company news',status,reachesToday:status==='ok',count:events.length,todayCount:0,events}],pending:status==='pending'?1:0,meta:{companies:events.length?1:0,days:1,oldestEventDay:events[0]?.day,newestEventDay:events.at(-1)?.day}});
window.fixtureRender = () => tab.render({root:document.querySelector('#root'),params:{},scope:'portfolio',data:{}});
window.fixtureRefresh = () => refresh.refreshAll();
window.fixtureDestroy = () => tab.destroy();
window.fixtureRender();
window.fixtureReady = true;
</script></body></html>`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (pathname === '/js/data/daily-alerts.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixtureModule); return; }
  const path = resolve(root, '.' + (pathname === '/js/data/daily-alerts-real.js' ? '/js/data/daily-alerts.js' : pathname));
  if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)); }
  catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date('2026-09-07T09:00:00Z') });
  await page.goto(origin);
  await page.waitForFunction(() => window.fixtureReady);
  assert.equal(await page.evaluate(() => window.fixtureReads[0].refresh), true, 'first open checks source readers');
  const state = page.locator('[data-alerts-coverage-state]');
  assert.equal(await state.getAttribute('data-alerts-coverage-state'), 'loading');
  assert(!/\bLive\b/.test(await state.innerText()), 'the initial null report is never Live');
  assert.match(await page.locator('[data-horizon-toggle="through"]').innerText(), /…/, 'unchecked is not a confirmed zero');
  assert.match(await page.locator('#root').innerText(), /Reading sources/);
  await page.evaluate(() => window.fixtureOptions.onPartial(window.fixtureReport([window.fixtureStory, window.fixtureNoise], 'pending')));
  const period = page.getByRole('combobox', { name: 'Date range' });
  assert.equal(await period.inputValue(), '3d', 'All Alerts opens on the last 3 days');
  // The real Sept 4 article is older than this fixture's selected three-day period. Choosing
  // All history must still expose it through partial reads, failures, reopening and rollover.
  await period.selectOption('all');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('JM Financial'));
  const search = page.locator('[data-table-search]');
  await search.fill('kissht');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('JM Financial'));
  assert.equal(await state.getAttribute('data-alerts-coverage-state'), 'loading');
  assert.match(await page.locator('[data-feed="news"]').textContent(), /reading/);
  await page.evaluate(() => window.fixtureRelease(window.fixtureReport([window.fixtureStory, window.fixtureNoise])));
  await page.waitForFunction(() => document.querySelector('[data-alerts-coverage-state]')?.dataset.alertsCoverageState === 'checked');
  assert.equal(await search.inputValue(), 'kissht', 'completion preserves the active customer search');
  const filters = page.locator('[data-table-filter]');
  assert.equal(await filters.count(), 4, 'relationship choice is additive after the existing controls');
  await filters.nth(3).selectOption('confirmed');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('JM Financial') && !document.querySelector('tbody')?.textContent.includes('Kiss band'));
  await filters.nth(3).selectOption('uncertain');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Kiss band') && !document.querySelector('tbody')?.textContent.includes('JM Financial'));
  await filters.nth(3).selectOption('all');
  await search.fill('onemi technology');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('JM Financial'));
  await page.evaluate(() => { void window.fixtureRefresh(); });
  await page.evaluate(() => {
    const retained = window.fixtureReport([window.fixtureStory,window.fixtureNoise], 'failed');
    window.fixtureOptions.onPartial(retained);
    window.fixtureRelease(retained);
  });
  await page.waitForFunction(() => document.querySelector('[data-alerts-coverage-state]')?.dataset.alertsCoverageState === 'partial');
  assert.match(await page.locator('tbody').innerText(), /JM Financial/, 'failure retains the already-visible exact article');
  assert.equal(await search.inputValue(), 'onemi technology');
  assert.match(await page.locator('[data-feed="news"]').textContent(), /partial/);
  await page.evaluate(() => { window.fixtureDestroy(); window.fixtureRender(); });
  assert.match(await page.locator('tbody').innerText(), /JM Financial/, 'navigation retains the prior report while rechecking');
  await page.evaluate(() => window.fixtureRelease(window.fixtureReport([window.fixtureStory,window.fixtureNoise], 'ok', '2026-09-08')));
  await page.waitForFunction(() => document.querySelector('[data-alerts-coverage-state]')?.dataset.alertsCoverageState === 'checked');
  assert.match(await page.locator('tbody').innerText(), /JM Financial/, 'date rollover does not drop retained All Alerts news');
  const beforeResume = await page.evaluate(() => window.fixtureReads.length);
  await page.clock.setSystemTime(new Date('2026-09-07T09:02:00Z'));
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.fixtureReads.length), beforeResume + 1, 'return after inactivity starts one bounded check, not a fan-out per browser event');
  assert.equal(await page.evaluate(() => window.fixtureReads.at(-1).refresh), true);
  await page.evaluate(() => window.fixtureRelease(window.fixtureReport([window.fixtureStory,window.fixtureNoise])));
  await page.waitForFunction(() => document.querySelector('[data-alerts-coverage-state]')?.dataset.alertsCoverageState === 'checked');
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.fixtureDestroy());
  const afterDestroy = await page.evaluate(() => window.fixtureReads.length);
  await page.clock.setSystemTime(new Date('2026-09-07T09:04:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(await page.evaluate(() => window.fixtureReads.length), afterDestroy, 'destroy removes focus rechecks');
  console.log('PASS browser: initial loading is not Live/zero, exact OnEMI KISSHT search, optional noisy-match separation, partial/failure disclosure, search retention, reopening and rollover.');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
