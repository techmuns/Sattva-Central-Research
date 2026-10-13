// Isolated public-source fixture; never collect or mutate production chatter.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), start = '2026-10-13T12:00:00Z';
let generation = start, detailFailure = false, pending = 0, peak = 0;
const requests = [];
const stocks = Array.from({ length: 200 }, (_, i) => ({ ticker: `company-${i}`, name: `Company ${i}`, mentions: 3,
  sentiment: { bullish: 1, bearish: 1, neutral: 1, label: 'bullish' }, sources: { valuepickr: 3 } }));
let posts = [
  { id: 'older', text: 'Older neutral observation', timestamp: '2026-10-13T11:57:00Z', sentiment: 'neutral', url: 'https://example.test/old' },
  { id: 'green', text: 'Exact positive source <script>window.bad=true</script>', timestamp: '2026-10-13T17:29:00+05:30', sentiment: 'bullish', url: 'https://example.test/topic/42/7?original=1' },
  { id: 'red', text: 'Exact negative source observation', timestamp: '2026-10-13T06:59:30-05:00', sentiment: 'bearish', url: 'https://example.test/topic/42/9#post' },
].map(post => ({ ...post, source: 'valuepickr', sourceLabel: 'ValuePickr', author: 'Fixture' }));
// The newest post is beyond page one, and source pages deliberately ignore sort=newest.
posts.unshift(...Array.from({ length: 998 }, (_, i) => ({ ...posts[0], id: `old-${i}`, timestamp: '2026-10-01T00:00:00Z' })));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head><body><main id="root" class="p-4"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/public-chatter.js';import * as chatter from '/js/data/chatter-live.js';import * as coverage from '/js/data/coverage.js';import * as live from '/js/core/live.js';
window.SATTVA_CHATTER_URL=location.origin+'/v1';window.chatter=chatter;
coverage.prime({holdings:[{ticker:'C0',name:'Company 0'}]});tab.render({root:document.querySelector('#root'),scope:'universe',params:{},live});
</script></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost'), path = url.pathname;
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  if (path === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (path === '/v1/dashboard') return json({ generatedAt: generation, window: '30d', overview: { totalPosts: 600, totalStocks: 200 }, stocks,
    pagination: { total: 200, offset: 0, count: 200, hasMore: false } });
  const detail = path.match(/^\/v1\/stocks\/(company-\d+)\/posts$/);
  if (detail) {
    pending++; peak = Math.max(peak, pending); requests.push(detail[1]);
    setTimeout(() => {
      pending--;
      if (detailFailure) return json({ error: 'source offline' }, 503);
      const offset = Number(url.searchParams.get('offset') || 0), page = posts.slice(offset, offset + 1000);
      return json({ ticker: detail[1], generatedAt: generation, counts: { total: posts.length, filtered: posts.length }, posts: page,
        pagination: { total: posts.length, offset, count: page.length, hasMore: offset + page.length < posts.length } });
    }, 200); return;
  }
  if (path === '/data/universe.json') return json(stocks.map((stock, i) => ({ Company: stock.name, 'Screener URL': `https://www.screener.in/company/C${i}/` })));
  if (path === '/data/mc-ticker-map.json') return json({ map: {} });
  if (path.startsWith('/api/')) return json({});
  try {
    const file = resolve(root, `.${path}`); assert(file.startsWith(root + sep));
    response.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    response.end(readFileSync(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const cell = page.locator('[data-chatter-highlights="company-0"]');
  await cell.waitFor();
  await cell.locator('[data-chatter-highlight]').first().waitFor();
  assert.deepEqual(await cell.locator('[data-chatter-highlight]').evaluateAll(nodes => nodes.map(node => node.dataset.highlightId)), ['red', 'green']);
  assert.deepEqual(await cell.locator('[data-chatter-highlight]').evaluateAll(nodes => nodes.map(node => node.dataset.sourceTag)), ['bearish', 'bullish']);
  assert.equal(await cell.locator('a').first().getAttribute('href'), 'https://example.test/topic/42/9#post');
  assert.equal(await cell.locator('a').nth(1).getAttribute('href'), 'https://example.test/topic/42/7?original=1');
  assert.match(await cell.locator('a').nth(1).innerText(), /<script>/);
  assert.equal(await page.evaluate(() => !!window.bad), false, 'source text is escaped');
  assert.equal(await page.locator('[data-chatter-mentions-dialog]').count(), 0);
  if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT });
  assert(peak <= 2, 'visible detail prefetch uses at most two shared request slots');
  assert(!requests.includes('company-199'), 'offscreen universe details are not fetched');
  assert(await page.locator('tbody tr[data-row-key]').count() <= 40, 'mounted rows remain bounded');
  // Link owns its click; it must not also open the company-wide dialog.
  await cell.locator('a').first().click();
  assert.equal(await page.locator('[data-chatter-mentions-dialog]').count(), 0);
  const input = page.locator('[data-table-search]'); await input.fill('Company 0'); await input.focus();
  posts.push({ ...posts[0], id: 'new-neutral', text: 'Latest neutral source observation', timestamp: '2026-10-13T12:01:00Z', url: 'javascript:alert(1)' });
  generation = '2026-10-13T12:02:00Z';
  await page.evaluate(() => chatter.refresh());
  await page.waitForFunction(() => document.querySelector('[data-chatter-highlights="company-0"] [data-chatter-highlight]')?.dataset.highlightId === 'new-neutral');
  assert.equal(await cell.locator('[data-chatter-highlight]').first().getAttribute('data-source-tag'), 'neutral');
  assert(await input.evaluate(node => document.activeElement === node), 'highlight arrivals retain search focus');
  const missingLink = cell.locator('[data-chatter-highlight-open]');
  assert.equal(await missingLink.getAttribute('href'), null, 'unsafe URLs never become links');
  await missingLink.click();
  await page.locator('[data-chatter-mention-row][data-mention-id="new-neutral"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.mentionId), 'new-neutral', 'missing original URL focuses the exact captured mention');
  await page.getByRole('button', { name: 'Close mentions', exact: true }).click();
  detailFailure = true; generation = '2026-10-13T12:03:00Z';
  await page.evaluate(() => chatter.refresh());
  await page.waitForFunction(() => document.querySelector('[data-chatter-highlights="company-0"]')?.textContent.includes('Update unavailable'));
  assert.equal(await cell.locator('[data-chatter-highlight]').first().getAttribute('data-highlight-id'), 'new-neutral', 'failed refresh retains verified excerpts');
  await page.reload();
  await page.locator('[data-chatter-highlights="company-0"] [data-chatter-highlight]').first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-chatter-highlights="company-0"]')?.textContent.includes('Update unavailable'));
  assert.equal(await cell.locator('[data-chatter-highlight]').first().getAttribute('data-highlight-id'), 'new-neutral', 'reopening restores disk evidence and rechecks a newer source generation');
  await input.fill('Company 199');
  await page.locator('[data-chatter-highlights="company-199"]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-chatter-highlights="company-199"]')?.textContent.includes('Excerpts unavailable'));
  assert(requests.includes('company-199'), 'search exposes and reads offscreen evidence');
  assert.deepEqual(errors, []);
  console.log('PASS newest exact excerpts, source colours, safe original links, exact captured fallback, bounded lazy reads, focused updates and outage retention');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
