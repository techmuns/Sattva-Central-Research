#!/usr/bin/env node
// Full-data interaction sweep. Only local captures/fixtures; no production API or write calls.
import assert from 'node:assert/strict';
import { dashboardFixture } from './lib/dashboard-browser-fixture.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const { server, origin } = await dashboardFixture();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const audit = process.env.TAB_PERF_AUDIT === '1';
const results = [];
// Local captures only; every other origin answers 503. Long tasks are recorded in every frame.
async function fixtureContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...options });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await context.addInitScript(origin => {
    localStorage.setItem('sattva:chatter-base', `${origin}/fixture/chatter`);
    window.__longTasks = [];
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
  }, origin);
  return context;
}
try {
  const context = await fixtureContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/embed`);
  const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
  await frame.locator('[data-tab-id="news"][aria-selected="true"]').waitFor();
  const routes = process.env.TAB_PERF_ROUTES?.split(',') || ['news?scope=portfolio', 'earnings-hub?scope=universe',
    'earnings-hub?scope=universe&view=calendar', 'earnings-hub?scope=universe&view=filings', 'concall?scope=universe',
    'public-chatter?scope=universe', 'public-chatter?scope=universe|Telegram',
    'breakouts/strong-breakouts?scope=universe', 'breakouts/technical-scanner?scope=universe',
    'breakouts/fii-accumulation?scope=universe',
    'super-investors/superstar-investors?scope=universe', 'super-investors/institutions?scope=universe',
    'ipos?scope=universe', 'ipos?scope=universe|directory', 'corp-announcements?scope=universe', 'corporate-actions?scope=universe',
    'nse-filings?scope=universe', 'insider-trades?scope=universe', 'news?scope=universe',
    'ai-alerts?scope=universe', 'daily-alerts?scope=universe', 'ask-research?scope=universe',
    'bookmarks?scope=universe', 'mutual-funds/company-holdings?scope=universe',
    'mutual-funds/all-schemes?scope=universe', 'mutual-funds/category-performance?scope=universe', 'news?scope=portfolio'];
  for (const route of routes) {
    const [path, section] = route.split('|');
    const profiler = process.env.TAB_PERF_PROFILE ? await context.newCDPSession(page) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Performance.enable'); await profiler.send('Profiler.start'); }
    const started = await frame.evaluate(route => { window.__longTasks = []; location.hash = `#/research/${route}`; return performance.now(); }, section === 'directory' ? `${path}&view=directory` : path);
    await frame.waitForFunction(id => document.querySelector('#content-host')?.dataset.activeTab === id, route.split(/[/?]/)[0]);
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
      longestTask: window.__longTasks.reduce((longest, task) => !longest || task.ms > longest.ms ? task : longest, null),
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
    results.push({ route, readyMs: Math.round(readyMs), ...result });
    console.log(JSON.stringify(results.at(-1)));
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      const metrics = await profiler.send('Performance.getMetrics');
      const frameNow = await frame.evaluate(() => performance.now());
      const samples = new Map();
      profile.samples?.forEach((id, i) => samples.set(id, (samples.get(id) || 0) + profile.timeDeltas[i]));
      console.log(JSON.stringify(profile.nodes.map(n => ({ fn: n.callFrame.functionName, file: n.callFrame.url.split('/').at(-1), line: n.callFrame.lineNumber + 1, ms: Math.round((samples.get(n.id) || 0) / 1000) })).sort((a,b) => b.ms-a.ms).slice(0,20)));
      if (result.longestTask?.ms > 300) {
        const stamp = metrics.metrics.find(metric => metric.name === 'Timestamp')?.value;
        const offset = stamp * 1000 - frameNow;
        const start = (result.longestTask.at + offset) * 1000, end = start + result.longestTask.ms * 1000;
        const taskSamples = new Map(), parents = new Map(), nodes = new Map(profile.nodes.map(node => [node.id, node]));
        for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
        let sampleTime = profile.startTime;
        profile.samples?.forEach((id, i) => {
          sampleTime += profile.timeDeltas[i];
          if (sampleTime >= start && sampleTime <= end) taskSamples.set(id, (taskSamples.get(id) || 0) + profile.timeDeltas[i]);
        });
        const stack = id => {
          const names = [];
          for (let at = id; at && names.length < 12; at = parents.get(at)) {
            const call = nodes.get(at)?.callFrame;
            if (call) names.push(`${call.functionName || '(anonymous)'} ${call.url.split('/').at(-1)}:${call.lineNumber + 1}`);
          }
          return names;
        };
        console.log(JSON.stringify({ route, longestTask: result.longestTask,
          heapBytes: metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value,
          taskStacks: [...taskSamples].sort((a,b) => b[1]-a[1]).slice(0,8).map(([id, us]) => ({ ms: Math.round(us / 1000), stack: stack(id) })) }));
      }
      await profiler.detach();
    }
    if (!audit) {
      assert(result.tables.every(t => t.mounted <= 160), `${route}: table DOM stays bounded`);
      assert(result.cards <= 100, `${route}: news card DOM stays bounded`);
      // Insider Trades froze the page for 1,367ms here before its per-row readings were memoised
      // (docs/PERFORMANCE-HOT-PATHS-2026-09-17.md) and 748ms after. The budget leaves room for a
      // CI runner at half local speed while still failing on a return to per-row recomputation.
      // AI Alerts and All Alerts under Universe are budgeted against the sliced ranking and the
      // sliced assembly (round two in that document): the longest task on each was 2.4 and 2.7
      // seconds before, and is bounded by garbage collection and the readers' seed merges now
      // (roughly 200–550ms locally). The budgets fail on a return to one-task ranking or sorting
      // while leaving a slow runner room.
      const taskBudgetMs = { 'insider-trades?scope=universe': 2500, 'ai-alerts?scope=universe': 1800, 'daily-alerts?scope=universe': 1800 }[route];
      if (taskBudgetMs) assert(result.maxTaskMs < taskBudgetMs, `${route}: longest main-thread task ${result.maxTaskMs}ms stays under ${taskBudgetMs}ms`);
    }
    if (route === 'daily-alerts?scope=universe') {
      // Exercise the shipped shell as well as the table: the isolated tab fixture cannot catch
      // a body scroll lock or flex rules that clip the table beneath the header/subview controls.
      await frame.getByRole('combobox', { name: 'Date range' }).selectOption('all');
      await frame.waitForFunction(() => !document.querySelector('[data-table-loading]') &&
        Number(document.querySelector('[data-score-table]')?.dataset.virtualTotal) > 100);
      for (const viewport of [{ width: 1345, height: 622 }, { width: 1024, height: 640 },
        { width: 390, height: 600 }, { width: 1440, height: 1100 }]) {
        await page.setViewportSize(viewport);
        await frame.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frame.waitForTimeout(250);
        const scroller = frame.locator('[data-table-scroll]');
        const layout = await scroller.evaluate(el => ({ height: el.getBoundingClientRect().height,
          bottom: el.getBoundingClientRect().bottom, viewport: innerHeight,
          overflow: document.documentElement.scrollWidth - innerWidth }));
        assert(layout.height >= 319, `All Alerts retains a usable table at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
        assert(layout.overflow <= 2, 'short frames do not introduce horizontal page overflow');
        if (layout.bottom > layout.viewport + 2) {
          const iframe = await page.locator('iframe').boundingBox();
          await page.mouse.move(iframe.x + 4, iframe.y + 100);
          await page.mouse.wheel(0, 2000);
          await frame.waitForFunction(() => window.scrollY > 0 &&
            document.querySelector('[data-table-scroll]').getBoundingClientRect().bottom <= innerHeight + 2);
          // Refitting while the page is scrolled must not add that scroll offset to its height.
          await frame.evaluate(() => window.dispatchEvent(new Event('resize')));
          await frame.waitForTimeout(100);
          assert(Math.abs(await scroller.evaluate(el => el.getBoundingClientRect().height) - layout.height) <= 1,
            'resizing a scrolled page preserves the bounded table height');
        }
        await scroller.evaluate(el => { el.scrollTop = 0; });
        await scroller.hover({ position: { x: 100, y: 100 } });
        await page.mouse.wheel(0, 1000);
        await frame.waitForFunction(() => document.querySelector('[data-table-scroll]').scrollTop > 100);
        await scroller.focus();
        await page.keyboard.press('Control+End');
        await frame.waitForFunction(() => {
          const el = document.querySelector('[data-table-scroll]');
          const rows = [...el.querySelectorAll('tr[data-row-key]')];
          return el.scrollHeight - el.clientHeight - el.scrollTop < 2 && rows.length > 0 && rows.length <= 160 &&
            rows.at(-1).getBoundingClientRect().bottom <= Math.min(el.getBoundingClientRect().bottom, innerHeight) + 2;
        });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
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
  await frame.locator('tbody [data-watch]').first().evaluate(el => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    el.click();
  });
  await frame.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
  assert(Math.abs(await scroller.evaluate(el => el.scrollTop) - beforeStar) < 2, 'watchlist actions keep the reading position');
  await frame.locator('[data-export]').click();
  assert.deepEqual(await frame.evaluate(() => exportedIds), Array.from({ length: 3000 }, (_, i) => String(i)), 'export receives every record in exact order, not just mounted rows');
  const search = frame.locator('[data-table-search]');
  const applySearch = async value => {
    await search.fill(value);
    await frame.waitForFunction(() => !document.querySelector('[data-table-loading]'));
  };
  await applySearch('Record 2999');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 1, 'search finds the final off-screen record');
  assert.equal(await frame.locator('tr[data-row-key]').getAttribute('data-row-key'), '2999');
  await frame.locator('[data-export]').click();
  assert.deepEqual(await frame.evaluate(() => exportedIds), ['2999'], 'filtered export uses the full matching model');
  await applySearch('');
  await frame.locator('th[data-sort="Value"]').click();
  await frame.waitForFunction(() => !document.querySelector('[data-table-loading]'));
  assert.equal(await frame.locator('tr[data-row-key]').first().getAttribute('data-row-key'), '2999', 'sorting is global');
  await frame.evaluate(() => { records[2999].title = 'Updated live title'; fixtureTable.updateRows(['2999']); });
  await applySearch('Updated live title');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 1, 'live patches invalidate search text');
  await frame.evaluate(() => {
    records = records.map(row => row.id === '2999' ? { ...row, title: 'Replacement live title' } : row);
    fixtureTable.updateData(records);
  });
  assert.equal(await frame.locator('tr[data-row-key]').count(), 0, 'replacing same-ID records invalidates the old search match');
  await applySearch('Replacement live title');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 1);
  assert((await frame.locator('tr[data-row-key]').innerText()).includes('Replacement live title'),
    'a correction without an optional revision field replaces the mounted row markup');
  await applySearch('does-not-exist');
  assert.equal(await frame.locator('tr[data-row-key]').count(), 0, 'empty filtered lists are safe');
  await applySearch('');
  await scroller.evaluate(el => { el.scrollTop = 30000; });
  await frame.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); });
  const readAnchor = () => scroller.evaluate(el => {
    const boundary = el.getBoundingClientRect().top + el.querySelector('thead').offsetHeight;
    const row = [...el.querySelectorAll('tr[data-row-key]')].find(row => row.getBoundingClientRect().bottom > boundary);
    return { key: row.dataset.rowKey, offset: row.getBoundingClientRect().top - boundary };
  });
  const beforeArrival = await readAnchor();
  await frame.evaluate(() => {
    records = [...records.map(row => ({ ...row })), ...Array.from({ length: 50 }, (_, i) => ({
      id: String(3000 + i), title: 'New arrival ' + i, value: 3000 + i, detail: 'Arrived while reading',
    }))];
    fixtureTable.updateData(records);
  });
  await frame.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); });
  const afterArrival = await readAnchor();
  assert.equal(afterArrival.key, beforeArrival.key, 'arrivals before the viewport preserve the record being read');
  assert(Math.abs(afterArrival.offset - beforeArrival.offset) <= 2, 'replaced row objects retain their reading offset');
  await page.setViewportSize({ width: 680, height: 800 });
  await frame.evaluate(async () => { for (let i=0;i<5;i++) await new Promise(requestAnimationFrame); });
  assert(await frame.locator('tr[data-row-key]').count() <= 100, 'resizing keeps the DOM bounded');
  for (let i=0; i<5; i++) await frame.evaluate(() => renderFixture());
  assert(await frame.locator('tr[data-row-key]').count() <= 100, 'repeated mount/dispose remains bounded');
  assert.deepEqual(errors, []);
  console.log('PASS: native iframe wheel, deep/end scrolling, variable heights, watch position, full/filtered export, off-screen search, live updates, resize and disposal.');
  await context.close();

  // ALL ALERTS OPENED ON AN EMPTY NEW DAY. Just after IST midnight nothing captured is dated Today,
  // so the table holds its placeholders until every source has been read: the reader waits for the
  // whole live collection, and every long task in it lands while they wait. The sweep above runs on
  // the real clock and measures until the first paint, so it met this case only when CI ran between
  // 18:30 UTC and the first capture of the new day: browser jobs in that window failed at 4.8–5.9
  // seconds while the same code had passed earlier the same day. Pin the page clock ten
  // minutes past the next IST midnight (after every committed capture, in UTC as the runners are)
  // and measure through the last source, not the first paint.
  if (process.env.TAB_PERF_MIDNIGHT !== '0') {
    const IST_MS = 5.5 * 3600000, DAY_MS = 86400000;
    const pinnedAt = (Math.floor((Date.now() + IST_MS) / DAY_MS) + 1) * DAY_MS - IST_MS + 10 * 60000;
    const midnight = await fixtureContext({ timezoneId: 'UTC' });
    await midnight.clock.install({ time: pinnedAt });
    await midnight.clock.resume();
    const midnightPage = await midnight.newPage();
    const midnightErrors = [], partReads = new Map();
    midnightPage.on('pageerror', error => midnightErrors.push(error.message));
    // Every retained news part this open reads, and how often. The companion index is built once per
    // set of captures and shared by every read of the same day; one open used to walk it three or
    // four times (seed, the refresh after it, the second collection a book update starts).
    midnightPage.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/^\/data\/(?:news|company-news\/[^/]+|tradingview-news\/[^/]+)\.parts\//.test(path)) partReads.set(path, (partReads.get(path) || 0) + 1);
    });
    await midnightPage.goto(`${origin}/embed?route=${encodeURIComponent('daily-alerts?scope=universe')}`);
    const allAlerts = await (await midnightPage.locator('iframe').elementHandle()).contentFrame();
    await allAlerts.locator('[data-tab-id="daily-alerts"][aria-selected="true"]').waitFor();
    const istClock = await allAlerts.evaluate(() => new Intl.DateTimeFormat('en-GB',
      { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now()));
    assert.match(istClock, /^00:[1-5]\d$/, `the page clock reads just after IST midnight (${istClock})`);
    await allAlerts.waitForFunction(() => {
      const panel = document.querySelector('#content-host');
      return panel?.textContent.trim() && !panel.inert && !panel.querySelector('.skeleton-shimmer');
    }, null, { timeout: 120000 });
    const readyMs = Math.round(await allAlerts.evaluate(() => performance.now()));
    // Settled: the Sources label no longer reads "Loading sources" and no source is still being read.
    await allAlerts.waitForFunction(() => {
      const coverage = document.querySelector('[data-alerts-coverage-state]');
      return coverage && coverage.dataset.alertsCoverageState !== 'loading' && !/still being read/.test(coverage.title);
    }, null, { timeout: 120000 });
    const settled = await allAlerts.evaluate(() => ({ settledMs: Math.round(performance.now()),
      maxTaskMs: Math.max(0, ...window.__longTasks.map(t => t.ms)), longTasks: window.__longTasks.filter(t => t.ms >= 200).length,
      text: document.querySelector('#content-host')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 160) }));
    const repeatedParts = [...partReads].filter(([, count]) => count > 1);
    console.log(JSON.stringify({ route: 'daily-alerts?scope=universe', pinnedAt: new Date(pinnedAt).toISOString(), istClock, readyMs, ...settled,
      newsParts: partReads.size, repeatedParts: repeatedParts.length }));
    assert.match(settled.text, /^All Alerts\b/, 'the measured page is All Alerts');
    assert(partReads.size > 0, 'the open read the retained company-news index');
    assert.deepEqual(repeatedParts, [], 'each retained news part is read once per open: the companion index is built once and shared');
    // The same budget as the sweep above, now over the whole collection rather than its first paint.
    if (!audit) assert(settled.maxTaskMs < 1800, `daily-alerts on a new IST day: longest main-thread task ${settled.maxTaskMs}ms stays under 1800ms`);
    assert.deepEqual(midnightErrors, [], 'zero application exceptions on an empty new day');
    console.log(`PASS: All Alerts opened at ${istClock} IST settles every source with no task over 1800ms.`);
    await midnight.close();
  }
} finally { await browser.close(); await new Promise(done => server.close(done)); }
