// Local synthetic source API: no production requests, collection jobs or data changes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chatterHealth } from '../public/js/data/chatter-health.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), initialAt = '2026-09-15T12:00:00Z';
let now = initialAt, generation = initialAt, revision = 1, failed = false, malformed = false, delayMs = 0, postDelayMs = 0;
let calls = 0, postCalls = 0, indexDelayMs = 0, olderUnavailable = false;
let collection = { intervalMinutes: 120, state: 'ok', discoveryOnly: true,
  sources: Object.fromEntries(['valuepickr', 'news', 'tradingqna'].map(source => [source, { state: 'ok', lastSuccessAt: initialAt, history: { complete: true } }])) };
const state = { readable: true, ok: true, collection };
assert.equal(chatterHealth(state, Date.parse(initialAt)).state, 'updated');
assert.equal(chatterHealth(state, Date.parse(initialAt) + 5 * 3600000).state, 'delayed');
assert.equal(chatterHealth({ ...state, checking: true }, Date.parse(initialAt)).state, 'checking');
assert.equal(chatterHealth({ ...state, ok: false }, Date.parse(initialAt)).state, 'failed');
assert.equal(chatterHealth({ ...state, collection: null }, Date.parse(initialAt)).state, 'unconfirmed');
const entry = (ticker, name, mentions) => ({ ticker, name, mentions, mentionsPrev: mentions, changePct: 0,
  sentiment: { label: 'neutral', score: 0, bullish: 0, bearish: 0, neutral: mentions }, sources: { valuepickr: mentions } });
let stocks = [entry('tata-consultancy-services', 'Tata Consultancy Services', 1001), entry('infosys', 'Infosys', 1), entry('some-topic', 'Some topic', 1)];
let posts = Array.from({ length: 1001 }, (_, i) => ({ id: `post-${i}`, source: 'valuepickr', timestamp: new Date(Date.parse(initialAt) - (i + 1) * 1000).toISOString(), text: `Mention fixture ${i}`, url: `https://example.test/post/${i}`, sentiment: 'neutral', author: 'Fixture author' }));
posts[0].timestamp = '2026-09-15T17:29:59+05:30';
posts[1].timestamp = '2026-09-15T06:59:58-05:00';
posts[1000].timestamp = 'unavailable';
const archive = { available: true, version: 1, startedAt: '2026-07-01T12:00:00Z', recovery: { complete: true }, topics: [
  { ticker: 'old-company', name: 'Old Company', count: 5, latestAt: '2026-08-03T12:00:00Z', months: { '2026-08': { count: 3 }, '2026-07': { count: 2 } } },
] };
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head><body><main id="root" class="p-4"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/public-chatter.js';
import * as chatter from '/js/data/chatter-live.js';
import * as coverage from '/js/data/coverage.js';
import * as live from '/js/core/live.js';
window.SATTVA_CHATTER_URL = location.origin + '/v1';
coverage.prime({holdings:[{ticker:'TCS',name:'Tata Consultancy Services'},{ticker:'INFY',name:'Infosys'}]});
window.chatter=chatter; window.live=live; window.tab=tab;
window.renderScope=(scope,params={})=>tab.render({root:document.querySelector('#root'),scope,live,params});
window.renderScope('universe',Object.fromEntries(new URLSearchParams(location.search)));
</script></body></html>`;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost'), path = url.pathname;
  response.setHeader('cache-control', 'no-cache');
  const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (path === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
  if (path === '/v1/dashboard') {
    calls++;
    setTimeout(() => {
      if (failed) return json({ error: 'offline' }, 503);
      if (malformed) return json({ stocks: [] });
      const tag = `"revision-${revision}"`;
      if (request.headers['if-none-match'] === tag) { response.writeHead(304, { etag: tag }); response.end(); return; }
      response.setHeader('etag', tag);
      const offset = Number(url.searchParams.get('offset') || 0), limit = offset ? 1000 : 2;
      json({ generatedAt: generation, window: '30d', collection,
        overview: { totalPosts: stocks.reduce((sum, row) => sum + row.mentions, 0), totalStocks: stocks.length },
        stocks: stocks.slice(offset, offset + limit), pagination: { total: stocks.length, offset, count: Math.min(limit, stocks.length - offset), hasMore: offset + limit < stocks.length } });
    }, delayMs); return;
  }
  if (path === '/v1/archive') { json(archive); return; }
  const history = path.match(/^\/v1\/archive\/old-company\/(2026-07|2026-08)$/);
  const detail = path.match(/^\/v1\/stocks\/([^/]+)\/posts$/);
  if (detail || history) {
    postCalls++;
    setTimeout(() => {
      if (history?.[1] === '2026-07' && olderUnavailable) return json({ error: 'offline' }, 503);
      const slug = detail?.[1] || 'old-company';
      const rows = history ? posts.slice(0, history[1] === '2026-08' ? 3 : 2).map((post, i) => ({ ...post, id: `${history[1]}-${i}`, timestamp: `${history[1]}-0${3-i}T12:00:00Z` })) : posts;
      const offset = Number(url.searchParams.get('offset') || 0), page = rows.slice(offset, offset + 1000);
      json({ ticker: slug, name: history ? 'Old Company' : 'Tata Consultancy Services', generatedAt: generation,
        counts: { total: rows.length, filtered: rows.length }, posts: page,
        pagination: { total: rows.length, offset, count: page.length, hasMore: offset + page.length < rows.length } });
    }, postDelayMs); return;
  }
  if (path === '/data/universe.json') { setTimeout(() => json(['TCS', 'INFY', 'OLDCO', 'COFORGE'].map((ticker, i) => ({ Company: ['Tata Consultancy Services', 'Infosys', 'Old Company', 'Coforge'][i], 'Screener URL': `https://www.screener.in/company/${ticker}/` }))), indexDelayMs); return; }
  if (path === '/data/mc-ticker-map.json') { json({ map: {} }); return; }
  if (path.startsWith('/api/')) { json({}); return; }
  try {
    const file = resolve(root, `.${path}`); assert(file.startsWith(root + sep));
    response.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'text/plain');
    response.end(readFileSync(file));
  } catch { json({}, 404); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(now) });
  await page.goto(origin);
  await page.locator('[data-chatter-state="updated"]').waitFor();
  assert.equal(await page.evaluate(() => chatter.meta().total), 3, 'every dashboard page is included');
  assert.equal(await page.locator('#root tbody tr[data-row-key]').count(), 2);
  assert.equal(calls, 2, 'two pages, with no duplicate initial read');
  const search = page.locator('#root [data-table-search]');
  await search.fill('Tata');
  await search.evaluate(input => { window.originalSearch = input; });
  collection = { ...collection, sources: { ...collection.sources, news: { ...collection.sources.news, state: 'partial' } } }; revision++;
  await page.evaluate(() => chatter.refresh());
  assert.equal(await page.locator('[data-chatter-live]').getAttribute('data-chatter-state'), 'partial');
  assert(await page.evaluate(() => originalSearch === document.querySelector('#root [data-table-search]')), 'status changes preserve the mounted search input');
  assert.equal(await search.inputValue(), 'Tata');

  collection.sources.news.state = 'ok'; revision++;
  await page.evaluate(() => chatter.refresh());
  delayMs = 2500; failed = true;
  const start = performance.now();
  await page.reload();
  await page.locator('#root tbody tr[data-row-key]').first().waitFor({ timeout: 1500 });
  assert(performance.now() - start < 1500, 'saved rows paint before slow revalidation');
  assert.equal(await page.locator('[data-chatter-live]').getAttribute('data-chatter-state'), 'checking');
  await page.locator('[data-chatter-state="failed"]').waitFor();
  assert.equal(await page.locator('#root tbody tr[data-row-key]').count(), 2, 'failed first revalidation retains disk data');
  delayMs = 0; failed = false;
  await page.evaluate(() => chatter.refresh());
  await search.fill('Tata');
  await search.focus();
  generation = '2026-09-15T12:01:00Z'; revision++;
  stocks[0] = { ...stocks[0], mentions: 1002 };
  posts.unshift({ ...posts[0], id: 'new-post', text: 'Fresh source observation', timestamp: generation });
  await page.clock.setSystemTime(new Date(generation));
  await page.clock.fastForward(301000);
  await page.waitForFunction(() => chatter.byTicker('TCS')?.mentions === 1002);
  assert.equal(await search.inputValue(), 'Tata');
  assert(await search.evaluate(input => document.activeElement === input), 'new arrivals retain keyboard focus');
  console.log('PASS cache-first opening, complete summary pagination, source-status changes, outage retention, automatic arrivals and focused search');

  posts.reverse(); // Deliberately unsorted pages: the newest record arrives after page one.
  await page.locator('#root tbody tr[data-row-key="tata-consultancy-services"]').click();
  await page.waitForFunction(() => chatter.loadedPosts().some(group => group.posts.length === 1002));
  assert.equal(await page.locator('[data-chatter-mention-row]').count(), 40, 'large detail lists have a bounded first paint');
  assert.equal(postCalls, 2, 'all mention pages, including beyond 1000, are retained');
  assert.deepEqual(await page.locator('[data-mention-id]').evaluateAll(rows => rows.slice(0, 3).map(row => row.dataset.mentionId)), ['new-post', 'post-0', 'post-1'], 'publication instants, not timestamp text, sentiment or source pagination, determine newest first');
  const dialog = page.locator('[data-chatter-mentions-dialog]');
  // Complete the opening transform before measuring a reading anchor.
  await page.locator('#modal-container').evaluate(node => node.getAnimations().forEach(animation => animation.finish()));
  await dialog.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelectorAll('[data-chatter-mention-row]').length === 80);
  assert.equal(await page.locator('[data-mention-id]').nth(40).getAttribute('data-mention-id'), 'post-39', 'scroll continues with the next older card');
  await page.locator('[data-chatter-more]').click();
  assert.equal(await page.locator('[data-chatter-mention-row]').count(), 120, 'keyboard-accessible pagination remains available');
  // New arrivals go first without replacing the mention currently being read.
  await dialog.evaluate(node => { node.scrollTop = 1600; });
  const anchor = await page.locator('[data-mention-id]').evaluateAll(rows => {
    const headerBottom = document.querySelector('[data-chatter-mentions-dialog]').firstElementChild.getBoundingClientRect().bottom;
    const row = rows.find(row => row.getBoundingClientRect().bottom > headerBottom);
    return { id: row.dataset.mentionId, top: row.getBoundingClientRect().top };
  });
  posts.push({ ...posts.at(-1), id: 'newer-post', timestamp: '2026-09-15T12:01:30Z', text: 'Newer source observation' });
  generation = '2026-09-15T12:01:30Z'; revision++;
  await page.evaluate(() => chatter.refresh());
  await page.waitForFunction(() => document.querySelector('[data-mention-id]')?.dataset.mentionId === 'newer-post');
  assert(Math.abs(await page.locator(`[data-mention-id="${anchor.id}"]`).evaluate(row => row.getBoundingClientRect().top) - anchor.top) < 2, 'live arrivals preserve the visible reading anchor');
  // Read every display batch; undated records stay available at the end.
  while (await page.locator('[data-chatter-more]').count()) {
    const count = await page.locator('[data-mention-id]').count();
    await dialog.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.waitForFunction(count => document.querySelectorAll('[data-mention-id]').length > count, count);
  }
  assert.equal(await page.locator('[data-mention-id]').count(), 1003);
  assert.equal(await page.locator('[data-mention-id]').last().getAttribute('data-mention-id'), 'post-1000');
  assert.match(await page.locator('[data-mention-id]').last().innerText(), /Time not published/);
  assert.equal(new Set(await page.locator('[data-mention-id]').evaluateAll(rows => rows.map(row => row.dataset.mentionId))).size, 1003, 'scrolling retains every distinct mention');
  await page.getByRole('button', { name: 'Close mentions', exact: true }).click();
  await page.clock.fastForward(61000);
  postDelayMs = 2500;
  const detailStart = performance.now();
  await page.locator('#root tbody tr[data-row-key="tata-consultancy-services"]').click();
  await page.locator('[data-chatter-mention-row]').first().waitFor({ timeout: 1500 });
  assert(performance.now() - detailStart < 1500, 'saved mentions open before the network');
  assert.match(await page.locator('[data-mention-status]').innerText(), /checking/);
  await page.waitForFunction(() => !document.querySelector('[data-mention-status]')?.textContent.includes('checking'));
  postDelayMs = 0;
  await page.getByRole('button', { name: 'Close mentions', exact: true }).click();
  await page.locator('[data-chatter-history]').click();
  await page.locator('[data-chatter-history-body] tbody tr[data-row-key="old-company"]').waitFor();
  await page.locator('[data-chatter-history-body] tbody tr[data-row-key="old-company"]').click();
  await page.locator('[data-chatter-older]').waitFor();
  assert.equal(await page.locator('[data-chatter-mention-row]').count(), 3);
  olderUnavailable = true;
  await page.setViewportSize({ width: 390, height: 500 });
  await page.locator('[data-chatter-mentions-dialog]').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[data-mention-status]')?.textContent.includes('Saved mentions remain available.'));
  assert.equal(await page.locator('[data-mention-id]').count(), 3, 'an older-month outage retains already loaded mentions');
  const afterOlderFailure = postCalls;
  await page.locator('[data-chatter-mentions-dialog]').evaluate(node => { node.scrollTop -= 1; node.dispatchEvent(new Event('scroll')); });
  assert.equal(postCalls, afterOlderFailure, 'scroll does not repeatedly retry a failed older month');
  olderUnavailable = false;
  await page.locator('[data-chatter-older]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-chatter-mention-row]').length === 5);
  assert.deepEqual(await page.locator('[data-mention-id]').evaluateAll(rows => rows.map(row => row.dataset.mentionId)), ['2026-08-0', '2026-08-1', '2026-08-2', '2026-07-0', '2026-07-1'], 'older months continue the publication timeline');
  assert.equal(await page.locator('[data-chatter-older]').count(), 0);
  await page.getByRole('button', { name: 'Close mentions', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('PASS instant cached mentions, pagination beyond 1000, bounded rendering and archived-only companies across retained months');

  const beforeHidden = calls;
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(6 * 60000);
  assert.equal(calls, beforeHidden);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => !chatter.meta().checking);
  assert.equal(calls, beforeHidden + 1, 'return/focus/online checks coalesce into one conditional request');
  await page.clock.setSystemTime(new Date('2026-09-15T18:00:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.waitForFunction(() => chatter.meta().health.state === 'delayed' && !chatter.meta().checking);
  assert.equal(await page.locator('[data-chatter-live]').getAttribute('data-chatter-state'), 'delayed', 'unchanged transport success cannot refresh source-check times');
  malformed = true;
  await page.evaluate(() => chatter.refresh());
  failed = true; malformed = false;
  await page.reload();
  await page.locator('#root tbody tr[data-row-key]').first().waitFor();
  await page.locator('[data-chatter-state="failed"]').waitFor();
  assert.equal(await page.evaluate(() => chatter.byTicker('TCS').mentions), 1002, 'malformed responses never replace the last-good disk capture');
  failed = false; generation = '2026-09-14T00:00:00Z'; revision++;
  await page.evaluate(() => chatter.refresh());
  assert.equal(await page.evaluate(() => chatter.meta().generatedAt), '2026-09-15T12:01:30Z', 'older snapshots cannot roll back the reader');
  stocks.push(entry('tcs', 'Tata Consultancy Services', 2)); generation = '2026-09-15T12:02:00Z'; revision++;
  await page.evaluate(() => chatter.refresh());
  assert.equal(await page.locator('#root tr[data-row-key="tata-consultancy-services"]').count(), 1);
  assert.equal(await page.locator('#root tr[data-row-key="tcs"]').count(), 1, 'two source topics for one exchange ticker remain separate rows');
  assert.equal(await page.evaluate(() => chatter.companies().filter(row => row.ticker === 'TCS').length), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.locator('[data-chatter-history]').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => tab.destroy());
  const afterDestroy = calls;
  await page.clock.fastForward(6 * 60000);
  assert.equal(calls, afterDestroy, 'tab teardown stops its poller');
  generation = '2026-09-21T00:15:56Z'; revision++;
  stocks = [{ ...entry('coforge', 'Coforge', 13), sentiment: { bullish: 1, bearish: 3, neutral: 9, label: 'bearish', labelText: 'Bearish' } }];
  posts = ['bullish', ...Array(9).fill('neutral'), ...Array(3).fill('bearish')].map((sentiment, i) => ({
    id: `coforge-${i}`, source: 'news', sentiment, text: `Coforge mention ${i}`, timestamp: i ? '2026-09-09T04:00:00Z' : '2026-09-18T07:47:25Z', url: `https://example.test/coforge/${i}`,
  }));
  indexDelayMs = 750;
  const cold = await browser.newPage();
  cold.on('pageerror', error => errors.push(error.message));
  await cold.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await cold.goto(`${origin}/?company=COFORGE&open=mentions`);
  await cold.locator('[data-chatter-mention-row]').first().waitFor();
  assert.equal(await cold.locator('[data-chatter-mentions-dialog]').getAttribute('data-chatter-slug'), 'coforge', 'company-only links open after the delayed resolver arrives');
  assert.match(await cold.locator('[data-chatter-sentiment-summary]').innerText(), /1 bullish, 3 bearish, 9 neutral/);
  const event = await cold.evaluate(async () => {
    const daily = await import('/js/data/daily-alerts.js');
    const report = await daily.collect({ day: '2026-09-21', scope: 'universe', includeHistory: true, load: false });
    return report.events.find(event => event.feed === 'chatter' && event.ticker === 'COFORGE');
  });
  assert.equal(event.direction, 'neutral', 'actual collector cannot make Coforge mixed chatter a bearish risk leg');
  assert.equal(event.headline, 'Mixed public chatter (30d snapshot)');
  assert.equal(event.chatterTopic, 'coforge');
  assert.match(event.signalReason, /keyword-based source readings/);
  await cold.getByRole('button', { name: 'Close mentions', exact: true }).click();
  await cold.evaluate(() => chatter.refresh());
  assert.equal(await cold.locator('[data-chatter-mentions-dialog]').count(), 0, 'background updates do not reopen a dismissed dialog');
  const summaries = [
    { ...entry('coforge', 'Coforge', 13), sentiment: { bullish: 1, bearish: 3, neutral: 9, label: 'bearish', score: -5 } },
    { ...entry('tata-consultancy-services', 'Tata Consultancy Services', 10), sentiment: { bullish: 8, bearish: 0, neutral: 2, label: 'bullish', score: -10 } },
    { ...entry('infosys', 'Infosys', 10), sentiment: { bullish: 0, bearish: 8, neutral: 2, label: 'bearish', score: 10 } },
  ];
  stocks = [...summaries, ...summaries.map((row, i) => ({ ...row, ticker: `unresolved-topic-${i}`, name: `Unresolved topic ${i}` }))];
  revision++;
  await cold.evaluate(() => { tab.destroy(); window.renderScope('universe'); });
  await cold.evaluate(() => chatter.refresh());
  await cold.locator('[data-table-search]').first().fill('');
  for (const section of ['coverage', 'not-in-coverage']) {
    await cold.locator(`[data-chatter-section-tabs] [data-tab-id="${section}"]`).click();
    await cold.locator('th[data-sort]').filter({ hasText: /^Sentiment/ }).click();
    const labels = await cold.locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim()).find(text => ['Mixed', 'Bullish', 'Bearish'].includes(text))));
    assert.deepEqual(labels, ['Mixed', 'Bullish', 'Bearish'], `${section} sorts displayed summaries, not deliberately conflicting source scores`);
  }
  await cold.close();
  console.log('PASS exact chatter collector reading, delayed company resolution and dismissed-dialog stability');
  assert.deepEqual(errors, []);
  console.log('PASS hidden/resume/reconnect cadence, aged status, invalid-response retention, rollback rejection, mobile layout and poll cleanup; no browser errors');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
