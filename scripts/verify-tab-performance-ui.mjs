#!/usr/bin/env node
// Full-data interaction sweep. Only local captures/fixtures; no production API or write calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(503); res.end('{}'); return; }
  if (url.pathname === '/fixture/table') {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><main id="fixture"></main><script type="module">
      import { scoreTable } from '/js/ui/screener.js';
      window.records = Array.from({ length: 3000 }, (_, i) => ({ id: String(i), title: 'Record ' + i, value: i,
        detail: i % 9 === 0 ? 'Complete variable-height detail. '.repeat(50) : 'Short detail ' + i }));
      window.renderFixture = () => {
        window.disposeFixture?.();
        window.fixtureTable = scoreTable({ rows: records, key: r => r.id, name: r => r.title, showAvatar: false,
          showRank: false, stickyHead: '500px', searchable: r => r.title + ' ' + r.detail,
          columns: [{ label: 'Value', get: r => r.value }, { label: 'Detail', html: true,
            get: r => '<div style="width:320px;white-space:normal">' + r.detail + '</div>' }],
          initialSort: { key: 'Value', dir: 'asc' }, onExport: rows => window.exportedIds = rows.map(r => r.id) });
        document.querySelector('#fixture').innerHTML = fixtureTable.html;
        window.disposeFixture = fixtureTable.wire(document.querySelector('#fixture'));
      }; renderFixture();
    </script>`); return;
  }
  if (url.pathname === '/embed') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><body style="margin:0;overflow:hidden"><main style="position:fixed;inset:16px 16px 16px 64px;display:flex;flex-direction:column"><header style="height:48px;flex:none">Local performance fixture</header><iframe title="Research dashboard" src="/#/research/news?scope=portfolio" style="flex:1;min-height:0;width:100%;border:0"></iframe></main>'); return;
  }
  const api = { '/api/earnings': 'earnings-live.json', '/api/concalls': 'concall-scans.json',
    '/api/nse-announcements': 'nse-announcements.json', '/api/ipo-filings': 'ipo-filings.json' }[url.pathname];
  let path = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (api) path = resolve(root, 'data', api);
  if (url.pathname === '/fixture/chatter/dashboard') path = resolve(root, '../scripts/fixtures/chatter-dashboard.json');
  if (url.pathname.startsWith('/api/') && !api) { res.writeHead(503); res.end('{}'); return; }
  if (!path.startsWith(root + sep) && !url.pathname.startsWith('/fixture/')) { res.writeHead(403); res.end(); return; }
  try { res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path)); }
  catch { res.writeHead(404); res.end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const audit = process.env.TAB_PERF_AUDIT === '1';
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript(origin => {
    localStorage.setItem('sattva:chatter-base', `${origin}/fixture/chatter`);
    window.__longTasks = [];
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
  }, origin);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/embed`);
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('[data-tab-id="news"][aria-selected="true"]').waitFor();
  const routes = process.env.TAB_PERF_ROUTES?.split(',') || ['news?scope=portfolio', 'earnings-hub?scope=universe',
    'earnings-hub?scope=universe&view=calendar', 'earnings-hub?scope=universe&view=filings', 'concall?scope=universe',
    'public-chatter?scope=universe', 'public-chatter?scope=universe|Not in coverage', 'public-chatter?scope=universe|Telegram',
    'breakouts/strong-breakouts?scope=universe', 'breakouts/technical-scanner?scope=universe',
    'breakouts/fii-accumulation?scope=universe', 'breakouts/earnings-surprise?scope=universe',
    'super-investors/superstar-investors?scope=universe', 'super-investors/institutions?scope=universe',
    'ipos?scope=universe', 'ipos?scope=universe|directory', 'corp-announcements?scope=universe', 'corporate-actions?scope=universe',
    'nse-filings?scope=universe', 'insider-trades?scope=universe', 'news?scope=universe',
    'ai-alerts?scope=universe', 'daily-alerts?scope=universe', 'ask-research?scope=universe', 'news?scope=portfolio'];
  for (const route of routes) {
    const [path, section] = route.split('|');
    const profiler = process.env.TAB_PERF_PROFILE ? await context.newCDPSession(page) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    const started = await frame.evaluate(route => { window.__longTasks = []; location.hash = `#/research/${route}`; return performance.now(); }, path);
    await frame.waitForFunction(id => document.querySelector(`[data-tab-id="${id}"]`)?.getAttribute('aria-selected') === 'true', route.split(/[/?]/)[0]);
    await frame.waitForFunction(() => {
      const panel = document.querySelector('#content-host');
      return panel?.textContent.trim() && !panel.querySelector('.skeleton-shimmer');
    }, null, { timeout: 60000 });
    if (section === 'directory') await frame.locator('[data-ipo-view]').selectOption('directory');
    else if (section) await frame.locator('[data-chatter-section-tabs]').getByRole('tab', { name: section, exact: true }).click();
    const readyMs = await frame.evaluate(start => performance.now() - start, started);
    // Fixed observation interval, not an application-readiness assumption: expose background fill.
    await frame.waitForTimeout(1500);
    const result = await frame.evaluate(() => ({
      nodes: document.querySelectorAll('*').length,
      tables: [...document.querySelectorAll('[data-score-table]')].map(t => ({ mounted: t.querySelectorAll('tr[data-row-key]').length,
        total: Number(t.dataset.virtualTotal || 0), pending: Number(t.dataset.rowsPending || 0),
        count: t.querySelector('[data-row-count]')?.textContent || '' })),
      cards: document.querySelectorAll('[data-news-key]').length,
      text: document.querySelector('#content-host')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 220),
      maxTaskMs: Math.max(0, ...window.__longTasks.map(t => t.ms)),
    }));
    const search = frame.locator('[data-table-search], [data-news-search]').first();
    if (await search.count()) {
      result.searchMs = await search.evaluate(async el => { const start=performance.now(); el.value='zzzz-no-matching-fixture'; el.dispatchEvent(new Event('input', {bubbles:true})); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return performance.now()-start; });
      await search.fill('');
    }
    const sort = frame.locator('th[data-sort]').first();
    if (await sort.count()) result.sortMs = await sort.evaluate(async el => { const start=performance.now(); el.click(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return performance.now()-start; });
    results.push({ route, readyMs: Math.round(readyMs), ...result });
    console.log(JSON.stringify(results.at(-1)));
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      const samples = new Map();
      profile.samples?.forEach((id, i) => samples.set(id, (samples.get(id) || 0) + profile.timeDeltas[i]));
      console.log(JSON.stringify(profile.nodes.map(n => ({ fn: n.callFrame.functionName, file: n.callFrame.url.split('/').at(-1), line: n.callFrame.lineNumber + 1, ms: Math.round((samples.get(n.id) || 0) / 1000) })).sort((a,b) => b.ms-a.ms).slice(0,20)));
      await profiler.detach();
    }
    if (!audit) {
      assert(result.tables.every(t => t.mounted <= 160), `${route}: table DOM stays bounded`);
      assert(result.cards <= 100, `${route}: news card DOM stays bounded`);
    }
  }
  assert.deepEqual(errors, [], 'zero application exceptions across the complete tab sweep');
  console.log(`PASS: ${routes.length} full-data route/view visits inside an iframe.`);
  if (process.env.TAB_PERF_SCREENSHOT) await page.screenshot({ path: process.env.TAB_PERF_SCREENSHOT });
  await frame.goto(`${origin}/fixture/table`);
  const scroller = frame.locator('[data-table-scroll]');
  await scroller.waitFor();
  await frame.waitForFunction(() => document.querySelector('tr[data-row-key="0"]')?.getBoundingClientRect().height > 100);
  // Native wheel input must advance the embedded scroller; no wheel interception is required.
  await scroller.hover();
  await page.mouse.wheel(0, 1500);
  await frame.waitForFunction(() => document.querySelector('[data-table-scroll]').scrollTop > 500);
  assert(await frame.locator('tr[data-row-key]').count() <= 100);
  for (const fraction of [0.5, 0.9, 1, 0.1]) {
    await scroller.evaluate((el, fraction) => { el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction; }, fraction);
    await frame.evaluate(async () => { for (let i=0;i<5;i++) await new Promise(requestAnimationFrame); });
    const state = await scroller.evaluate(el => {
      const top = el.getBoundingClientRect().top + el.querySelector('thead').getBoundingClientRect().height;
      const bottom = el.getBoundingClientRect().bottom;
      const visible = [...el.querySelectorAll('tr[data-row-key]')].filter(row => row.getBoundingClientRect().bottom > top && row.getBoundingClientRect().top < bottom);
      return { mounted: el.querySelectorAll('tr[data-row-key]').length, visible: visible.length,
        last: el.querySelector('tr[data-row-key="2999"]')?.getBoundingClientRect().bottom,
        bottom, top: visible[0]?.getBoundingClientRect().top };
    });
    assert(state.mounted <= 100 && state.visible > 0, 'deep scrolling remains bounded and never shows an empty window');
    assert(state.top < state.bottom, 'visible content occupies the scroller');
    if (fraction === 1) assert(state.last != null, 'last retained record is reachable');
  }
  const beforeStar = await scroller.evaluate(el => el.scrollTop);
  await frame.locator('tbody [data-watch]').first().evaluate(el => el.click());
  await frame.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  assert(Math.abs(await scroller.evaluate(el => el.scrollTop) - beforeStar) < 2, 'watchlist actions keep the reading position');
  await frame.locator('[data-export]').click();
  assert.deepEqual(await frame.evaluate(() => exportedIds), Array.from({ length: 3000 }, (_, i) => String(i)), 'export receives every record in exact order, not just mounted rows');
  const search = frame.locator('[data-table-search]');
  await search.fill('Record 2999');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 1, 'search finds the final off-screen record');
  assert.equal(await frame.locator('tr[data-row-key]').getAttribute('data-row-key'), '2999');
  await frame.locator('[data-export]').click();
  assert.deepEqual(await frame.evaluate(() => exportedIds), ['2999'], 'filtered export uses the full matching model');
  await search.fill('');
  await frame.locator('th[data-sort="Value"]').click();
  assert.equal(await frame.locator('tr[data-row-key]').first().getAttribute('data-row-key'), '2999', 'sorting is global');
  await frame.evaluate(() => { records[2999].title = 'Updated live title'; fixtureTable.updateRows(['2999']); });
  await search.fill('Updated live title');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 1, 'live patches invalidate search text');
  await search.fill('does-not-exist');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 0, 'empty filtered lists are safe');
  await search.fill('');
  await page.setViewportSize({ width: 680, height: 800 });
  await frame.evaluate(async () => { for (let i=0;i<5;i++) await new Promise(requestAnimationFrame); });
  assert(await frame.locator('tr[data-row-key]').count() <= 100, 'resizing keeps the DOM bounded');
  for (let i=0; i<5; i++) await frame.evaluate(() => renderFixture());
  assert(await frame.locator('tr[data-row-key]').count() <= 100, 'repeated mount/dispose remains bounded');
  assert.deepEqual(errors, []);
  console.log('PASS: native iframe wheel, deep/end scrolling, variable heights, watch position, full/filtered export, off-screen search, live updates, resize and disposal.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
