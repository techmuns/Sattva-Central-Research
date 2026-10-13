#!/usr/bin/env node
// Full-data interaction sweep. Only local captures/fixtures; no production API or write calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const baseline = process.env.PERF_BASE_REF, code = new Map();
const asset = path => {
  if (!baseline || !path.startsWith(root + '/js/')) return readFileSync(path);
  if (!code.has(path)) code.set(path, execFileSync('git', ['show', baseline + ':public' + path.slice(root.length)], {maxBuffer: 12*1024*1024}));
  return code.get(path);
};
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
  try { res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream'); res.end(asset(path)); }
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
  // Hold the trading date constant across the midnight boundary and both comparison runs.
  await page.clock.setFixedTime(new Date(process.env.PERF_CLOCK || '2026-09-16T17:00:00Z'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/embed`);
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('[data-tab-id="news"][aria-selected="true"]').waitFor();
  const routes = ['news?scope=portfolio', 'daily-alerts?scope=portfolio', 'earnings-hub?scope=universe', 'ai-alerts?scope=portfolio'];
  const cdp=await context.newCDPSession(page);
  const start=Date.now(), duration=Number(process.env.PERF_SESSION_MS || 1800000);
  let visits=0;
  while(Date.now()-start<duration) {
    const route=routes[visits++%routes.length];
    const [path, section] = route.split('|');
    const profiler = process.env.TAB_PERF_PROFILE ? await context.newCDPSession(page) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    const started = await frame.evaluate(route => { window.__longTasks = []; location.hash = `#/research/${route}`; return performance.now(); }, section === 'directory' ? `${path}&view=directory` : path);
    await frame.waitForFunction(id => document.querySelector(`[data-tab-id="${id}"]`)?.getAttribute('aria-selected') === 'true', route.split(/[/?]/)[0]);
    await frame.waitForFunction(() => {
      const panel = document.querySelector('#content-host');
      return panel?.textContent.trim() && !panel.inert && !panel.querySelector('.skeleton-shimmer');
    }, null, { timeout: 60000 });
    if (section && section !== 'directory') await frame.locator('[data-chatter-section-tabs]').getByRole('tab', { name: section, exact: true }).click();
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
    // Live tabs may replace their search input while a source update is painting. Resolve both the
    // probe and its cleanup inside the page, where each current node can be used synchronously;
    // a Playwright locator would otherwise keep retrying against successively detached inputs.
    const searchMs = await frame.evaluate(async () => {
      const selector = '[data-table-search], [data-news-search]';
      const el = document.querySelector(selector);
      if (!el) return null;
      const start = performance.now();
      el.value = 'zzzz-no-matching-fixture';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const elapsed = performance.now() - start;
      const current = document.querySelector(selector);
      for (const input of new Set([el, current].filter(Boolean))) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return elapsed;
    });
    if (searchMs != null) result.searchMs = searchMs;
    const sort = frame.locator('th[data-sort]').first();
    if (await sort.count()) result.sortMs = await sort.evaluate(async el => { 
      const start = performance.now(); 
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
      el.click(); 
      await new Promise(requestAnimationFrame); 
      await new Promise(requestAnimationFrame); 
      return performance.now() - start; 
    });
    await cdp.send('HeapProfiler.collectGarbage');
    const heap=await cdp.send('Runtime.getHeapUsage'),dom=await cdp.send('Memory.getDOMCounters');
    results.push({route, elapsedMs:Date.now()-start, readyMs:Math.round(readyMs),heapBytes:heap.usedSize,...dom,...result});
    console.log(JSON.stringify(results.at(-1)));
    if(process.env.PERF_SESSION_OUTPUT)writeFileSync(process.env.PERF_SESSION_OUTPUT, JSON.stringify({baseline,results},null,2));

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
    await frame.evaluate(async()=>{
      const scroller=document.querySelector('[data-table-scroll]');
      if(!scroller)return;
      for(const fraction of [0.2,0.7,1,0]){
        scroller.scrollTop=(scroller.scrollHeight-scroller.clientHeight)*fraction;
        scroller.dispatchEvent(new Event('scroll'));
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      }
    });
    await page.waitForTimeout(10000);
  }
  assert.deepEqual(errors, [], 'zero application exceptions during repeated full-data reading');
  console.log('PASS full-data session '+Math.round((Date.now()-start)/60000)+' minutes, '+visits+' visits.');
} finally {await browser.close();await new Promise(done=>server.close(done));}
