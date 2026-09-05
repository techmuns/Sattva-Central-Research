#!/usr/bin/env node
// Real registry, feed loaders and production CSS; all data reads stay on the local fixture server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), at = '2026-09-06T00:00:00Z';
const discovery = { capturedAt: at, completedQueries: 10, plannedQueries: 10, staleOrIncompleteQueries: 0, pagesFailed: 0, documentsPending: 0 };
const core = { capturedAt: at, enrichmentCoverage: discovery, queryCoverage: { planned: 1, succeeded: 1, failed: 0 },
  byTicker: { ALPHA: [{ title: 'Alpha company update', company: 'Alpha', ticker: 'ALPHA', date: '2026-09-06', url: 'https://publisher.example/alpha' }] } };
let tvFailure = false;
const tv = { capturedAt: at, byTicker: {}, entities: [], tradingViewCoverage: { checkedAt: at, oldestSuccessAt: at,
  activeCompanies: 10, mappedCompanies: 10, plannedSymbols: 10, staleOrFailedSymbols: 0 } };
const market = { capturedAt: at, articles: [{ id: 'fixture-article', title: 'Retained publisher news', url: 'https://publisher.example/fixture', publishedAt: at }], sources: ['moneycontrol', 'business-standard', 'mint', 'economic-times', 'investing']
  .map(id => ({ id, capturedAt: at, ok: true, feedsOk: 3, feeds: 3 })) };
const ipo = JSON.parse(readFileSync(resolve(root, 'data/ipo-filings.json')));
ipo.checkedAt = at;
for (const source of ipo.sources) source.checkedAt = at;
Object.assign(ipo.sources.find(s => s.id === 'bse-sme'), { status: 'failed', note: 'Fixture upstream HTTP 503; prior documents retained', count: 0 });
ipo.sources.find(s => s.id === 'nse-equity').checkedAt = '2026-09-05T00:00:00Z';
const styles = [...readFileSync(resolve(root, 'index.html'), 'utf8').matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/style.css">${styles}</head>
<body style="background:#f5f4fc"><main style="padding:36px;color:#475569"><h1>Portfolio research</h1><p>Source connection verification</p></main><script type="module">
import { news } from '/js/data/filings.js';
import * as market from '/js/data/market-news.js';
import * as ipo from '/js/data/ipo-filings.js';
import { mount, openBeacon } from '/js/ui/source-beacon.js';
window.news = news; window.openBeacon = openBeacon;
await Promise.all([news.seed(), market.load(), ipo.load()]);
window.disposeBeacon = mount(); window.ready = true;
</script></body></html>`;
const requests = [], errors = [];
const server = createServer((req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ path, method: req.method }); res.setHeader('cache-control', 'no-store');
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    const fixture = { '/data/news.json': core, '/data/tradingview-news/latest.json': tv, '/data/market-news.json': market,
      '/data/ipo-filings.json': ipo, '/api/ipo-filings': ipo }[path];
    if (fixture) {
      res.setHeader('content-type', 'application/json');
      res.statusCode = path.includes('/tradingview-news/') && tvFailure ? 503 : 200;
      res.end(JSON.stringify(fixture)); return;
    }
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) throw Error('Outside fixture');
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS', name); };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(at) });
  await page.goto(origin); await page.waitForFunction(() => window.ready);
  const dataReads = () => requests.filter(r => /^\/(api|data)\//.test(r.path)).length;
  const before = dataReads();
  await page.evaluate(() => window.openBeacon({ group: 'portfolio-news' }));
  check('all nine portfolio-news sources appear exactly once', await page.locator('[data-beacon-group="portfolio-news"] .beacon-row').count() === 9);
  check('every recently successful news source is connected', await page.locator('[data-beacon-group="portfolio-news"] .beacon-row.is-live').count() === 9);
  check('new TradingView capture uses a verified connected indicator', await page.locator('[data-beacon-source="tradingview-news"] > summary').evaluate(el => el.classList.contains('is-live') && el.innerText.includes('Connected')));
  check('launcher is a source inventory, with separate verified connection count', await page.evaluate(async () => {
    const { sourceGroups } = await import('/js/ui/sources.js');
    const { sourceSummary } = await import('/js/ui/source-connections.js');
    const { total, automatic, connected } = sourceSummary(sourceGroups());
    return connected > 0 && automatic > connected && document.querySelector('[data-beacon-launch-count]').textContent === `${total} research sources` && document.querySelector('[data-beacon-connected]').textContent === `${connected} connected`;
  }));
  const details = page.locator('[data-beacon-source="tradingview-news"]');
  await details.locator('summary').click();
  check('expanded source explains server and dashboard refresh cadences', (await details.innerText()).includes('Every 15 minutes') && (await details.innerText()).includes('every 2 minutes'));
  check('dated and unavailable sources use calm, distinct labels without a green indicator', await page.locator('[data-beacon-source="nse-equity"] > summary').evaluate(el => el.innerText.includes('Refresh due') && !el.classList.contains('is-live')) && await page.locator('[data-beacon-source="bse-sme"] > summary').evaluate(el => el.innerText.includes('Connection paused') && !el.classList.contains('is-live')));
  check('unbuilt integrations and credential plumbing do not count as data sources', !(await page.locator('#source-beacon-panel').innerText()).match(/NOT BUILT|\bDATED\b|UNAVAILABLE|Analyst consensus|indicator overlay|Credentialled proxy/i));
  check('confirmed source dots animate', await details.locator('.beacon-dot').evaluate(el => getComputedStyle(el).animationName === 'beacon-dot-pulse'));
  const scroll = await page.locator('.beacon-list').evaluate(el => el.scrollTop);
  await page.clock.runFor(15001);
  check('in-place status refresh preserves focus, expanded details and scrolling', await details.getAttribute('open') !== null && await details.locator('summary').evaluate(el => el === document.activeElement) && Math.abs(await page.locator('.beacon-list').evaluate(el => el.scrollTop) - scroll) < 1);
  check('opening and refreshing source presentation issues no data requests', dataReads() === before);
  if (process.env.SOURCE_SCREENSHOT_DIR) {
    await details.locator('summary').click();
    await page.evaluate(() => window.openBeacon({ group: 'portfolio-news' }));
    await page.clock.runFor(500);
    await page.screenshot({ path: `${process.env.SOURCE_SCREENSHOT_DIR}/source-connections-desktop.png`, animations: 'disabled' });
  }
  await context.setOffline(true);
  await page.waitForFunction(() => !document.querySelector('#source-beacon-root').classList.contains('has-connection'));
  check('offline removes every green dot and the launcher pulse', await page.locator('.beacon-row.is-live').count() === 0 && await page.locator('[data-beacon-connected]').innerText() === '0 connected' && await page.locator('[data-beacon-toggle] .beacon-live-dot').evaluate(el => getComputedStyle(el, '::after').animationName === 'none'));
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector('#source-beacon-root').classList.contains('has-connection'));
  tvFailure = true; await page.evaluate(() => window.news.refreshSnapshot());
  await page.clock.runFor(15001);
  check('latest published-snapshot failure overrides the earlier successful timestamp', await details.locator('summary').evaluate(el => !el.classList.contains('is-live') && el.innerText.includes('Connection paused')));
  check('upstream failure evidence is retained behind the softer label', (await page.locator('[data-beacon-source="bse-sme"] .beacon-source-copy').textContent()).includes('HTTP 503'));
  tvFailure = false; await page.evaluate(() => window.news.refreshSnapshot());
  await page.clock.runFor(15001);
  check('source recovery restores the verified indicator', await details.locator('summary').evaluate(el => el.classList.contains('is-live')));
  await page.clock.setSystemTime(new Date(Date.parse(at) + 5 * 3600000));
  await page.clock.runFor(15001);
  check('aging out naturally removes verified news indicators without a network response', await page.locator('[data-beacon-group="portfolio-news"] .beacon-row.is-live').count() === 0);
  await page.keyboard.press('Escape');
  check('Escape closes and returns keyboard focus to the launcher', await page.locator('#source-beacon-panel').count() === 0 && await page.locator('[data-beacon-toggle]').evaluate(el => el === document.activeElement));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => window.openBeacon({ group: 'portfolio-news' }));
    await page.clock.runFor(500);
    check(`source panel stays within a ${width}px viewport`, await page.evaluate(() => {
      const rect = document.querySelector('#source-beacon-panel').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && rect.right <= innerWidth && rect.width > 250 && rect.height > 200 && rect.top >= 0;
    }));
    if (width === 390 && process.env.SOURCE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SOURCE_SCREENSHOT_DIR}/source-connections-mobile.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.openBeacon({ group: 'portfolio-news' }));
  check('reduced motion removes travelling flow particles', await page.locator('animateMotion').count() === 0);
  await page.evaluate(() => window.disposeBeacon());
  check('disposal removes the widget', await page.locator('#source-beacon-root').count() === 0);
  check('all fixture requests were read-only and no browser errors occurred', requests.every(r => r.method === 'GET') && errors.length === 0);
  console.log(`${checks} source-connection browser checks passed`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
