// Local/staging only. All external requests are blocked; X and portfolio responses are fixtures.
import assert from 'node:assert/strict';
import { portfolioCatalog, CACHE_MS } from '../public/js/data/x-chatter-shared.js';
import { XChatterEngine } from '../worker/x-chatter-engine.mjs';
const base = (process.argv[2] || 'http://127.0.0.1:8908').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Use a local test server');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const now = Date.now(), errors = [], requests = [];
const holdings = [{ isin: 'FIXTURE1', ticker: 'EXAMPLE', name: 'Example Optical' },
  { isin: 'FIXTURE2', ticker: null, name: 'Sample Private Holdings' },
  { isin: 'FIXTURE3', ticker: 'DEMO', name: 'Demo Manufacturing' }];
const catalog = portfolioCatalog(holdings), rows = new Map();
rows.set('state', { running: true, revision: 1, catalog, queue: [], cursor: 0, usage: {}, tombstones: {}, lastSuccessAt: new Date(now).toISOString() });
for (let c = 0; c < catalog.length; c++) {
  rows.set(`company:${catalog[c].key}`, { checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + CACHE_MS).toISOString(), partial: c === 0,
    posts: Array.from({ length: 20 }, (_, i) => ({ id: String(1000 + c * 100 + i), author: { name: 'Offline fixture author', username: 'fixture_author' },
      text: `OFFLINE TEST FIXTURE ${c}-${i}. Synthetic UI text, not company news. ${i === 0 ? '<script>window.badX=true</script> ' + 'Long post text. '.repeat(100) : ''}`,
      createdAt: new Date(now - (c === 2 ? 48 : 1) * 3600000 - i * 1000).toISOString(), images: [] })) });
}
const store = { get: (k) => structuredClone(rows.get(k)), put: (k, v) => rows.set(k, structuredClone(v)),
  entries: (prefix) => [...rows].filter(([k]) => k.startsWith(prefix)).map((r) => structuredClone(r)), delete: (k) => rows.delete(k) };
const engine = new XChatterEngine(store, { X_CHATTER_ALLOW_PAID: 'true', X_CHATTER_ENABLED: 'true', X_CHATTER_DAILY_POST_LIMIT: '120', X_CHATTER_COMPANIES: 'all', X_BEARER_TOKEN: 'offline-fixture' });
let mode = 'ready';
page.on('pageerror', (err) => errors.push(err.message));
await page.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) return route.abort();
  if (url.pathname === '/data/portfolio-companies.json') return route.fulfill({ json: { holdings, count: holdings.length, asOf: new Date(now).toISOString() } });
  if (url.pathname === '/api/x-chatter') {
    requests.push(request.method());
    if (mode === 'error') return route.fulfill({ status: 503, json: {} });
    if (mode === 'setup') return route.fulfill({ json: { source: 'X API', status: 'setup-required', companies: [], posts: [], total: 0 } });
    if (mode === 'free') return route.fulfill({ json: { source: 'X API', status: 'free-only', companies: [], posts: [], total: 0 } });
    return route.fulfill({ json: engine.snapshot(Object.fromEntries(url.searchParams)) });
  }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, json: {} });
  return route.continue();
});
let checks = 0;
const ok = (label, value) => { assert.ok(value, label); console.log(`PASS ${label}`); checks++; };
try {
  await page.goto(`${base}/#/research/public-chatter?scope=portfolio&section=x-chatter`);
  await page.waitForSelector('[data-x-post]');
  ok('X Chatter is immediately next to Coverage even when the forum API is unavailable',
    JSON.stringify((await page.locator('[data-chatter-section-tabs] [role=tab]').allTextContents()).map((s) => s.trim())) === JSON.stringify(['Coverage', 'X Chatter', 'Not in coverage']));
  ok('24-hour filter excludes two-day-old posts', await page.locator('[data-x-post]').count() === 40);
  ok('every card visibly identifies X and unverified social content', await page.locator('[data-x-label]').count() === 40 && await page.locator('[data-x-results]').getByText('Unverified social post', { exact: true }).count() === 40);
  ok('post text is escaped', !(await page.evaluate(() => window.badX)) && await page.locator('[data-x-results]').textContent().then((s) => s.includes('<script>')));
  ok('original link includes the author and immutable post ID', (await page.locator('[data-x-post="1000"] a').last().getAttribute('href')) === 'https://x.com/fixture_author/status/1000');
  await page.locator('[data-x-company]').selectOption('FIXTURE1');
  await page.waitForFunction(() => document.querySelectorAll('[data-x-post]').length === 10);
  ok('selecting a company starts with ten posts and exposes the cap', /capped or incomplete/.test(await page.locator('[data-x-results]').textContent()));
  await page.locator('[data-x-page=next]').click();
  await page.waitForFunction(() => document.querySelector('[data-x-count]')?.textContent.includes('11–20'));
  ok('the next ten posts are reachable', await page.locator('[data-x-post="1010"]').count() === 1);
  await page.locator('[data-x-search]').fill('fixture_author');
  await page.waitForFunction(() => document.querySelector('[data-x-count]')?.textContent.includes('1–10'));
  ok('author search keeps keyboard focus', await page.locator('[data-x-search]').evaluate((el) => document.activeElement === el));
  await page.locator('[data-x-search]').fill('no such phrase');
  await page.waitForFunction(() => document.querySelectorAll('[data-x-post]').length === 0);
  ok('empty filtering explains limits instead of claiming no company activity', /not proof of no activity/.test(await page.locator('[data-x-results]').textContent()));
  await page.locator('[data-x-search]').fill(''); await page.locator('[data-x-company]').selectOption('');
  await page.locator('[data-x-period]').selectOption('72');
  await page.waitForFunction(() => document.querySelector('[data-x-count]')?.textContent.includes('of 60'));
  ok('three-day range includes older posts with bounded DOM paging', await page.locator('[data-x-post]').count() === 50);
  await page.locator('[data-x-coverage] > summary').click();
  ok('unlisted holdings have named coverage and manual dated X searches',
    await page.locator('[data-x-company-row]').count() === 3 && /since%3A/.test(await page.locator('[data-x-company-row]').nth(1).locator('a').first().getAttribute('href')));
  await page.setViewportSize({ width: 390, height: 844 });
  ok('mobile layout has no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator('[data-chatter-section-tabs] [data-tab-id="coverage"]').click();
  await page.locator('[data-chatter-section-tabs] [data-tab-id="x-chatter"]').click();
  await page.waitForSelector('[data-x-post]');
  await page.reload(); await page.waitForSelector('[data-x-post]');
  ok('the chosen X tab survives reload', page.url().includes('section=x-chatter'));
  mode = 'error'; await page.locator('[data-x-refresh]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-x-post]').length === 0);
  ok('failed confirmation clears the view and names the error', /unavailable/.test(await page.locator('[data-x-status]').textContent()));
  mode = 'setup'; await page.locator('[data-x-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-x-status]')?.textContent.includes('not set up yet'));
  ok('setup state keeps every holding visible without fabricated posts', await page.locator('[data-x-company-row]').count() === 3 && await page.locator('[data-x-post]').count() === 0);
  mode = 'free'; await page.locator('[data-x-refresh]').click();
  await page.waitForFunction(() => document.querySelector('[data-x-status]')?.textContent.includes('Free data only'));
  ok('free mode clearly offers manual reading, not automatic ingestion', /do not automatically import/.test(await page.locator('[data-x-status]').textContent()) && await page.locator('[data-x-post]').count() === 0);
  ok('all X view requests are read-only', requests.length > 5 && requests.every((method) => method === 'GET'));
  ok('no application JavaScript errors', errors.length === 0);
  console.log(`${checks} X Chatter browser checks passed`);
} finally { await browser.close(); }
