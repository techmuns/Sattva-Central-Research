#!/usr/bin/env node
// Isolated browser over local captures and local stand-ins. No production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const data = (path) => JSON.parse(readFileSync(resolve(root, `data/${path}`)));
let version = 1;
const calls = [];
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="padding:16px;background:#f6f7fb"><button id="refresh">Refresh</button><main id="root"></main>
<script>
window.testContext={session:{token:'local-fixture-only',email:'fixture@example.test'}};
window.MunshotDashboardSDK={createClient:()=>({getContext:()=>window.testContext,onMessage:(fn)=>{window.testHostMessage=fn;return()=>{};}})};
window.SATTVA_CHATTER_URL=location.origin+'/chatter';
</script><script type="module">
import * as tab from '/js/tabs/daily-alerts.js';
import * as coverage from '/js/data/coverage.js';
import * as refresh from '/js/core/refresh.js';
coverage.prime({holdings:[{ticker:'STLTECH',name:'Sterlite Technologies'},{ticker:'RELIANCE',name:'Reliance Industries'},{ticker:'JAYNECOIND',name:'Jayaswal Neco Industries'}]});
window.show=(scope='universe')=>tab.render({root:document.querySelector('#root'),params:{},scope,data:{}});
window.dispose=()=>tab.destroy();
document.querySelector('#refresh').onclick=()=>refresh.refreshAll();
window.show();
</script></body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.push(url.pathname);
  const json = (value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/earnings') { json(data('earnings-live.json')); return; }
    if (url.pathname === '/api/concalls') {
      const payload = data('concall-scans.json');
      json({ ...payload, portfolioUpcoming: [
        { id: 'STLTECH|2026-09-10|AGM|day', companyKey: 'STLTECH', ticker: 'STLTECH', name: 'Sterlite Technologies', date: '2026-09-10', time: null, eventType: 'AGM', companyUrl: 'https://www.screener.in/company/STLTECH/', sourceUrl: 'https://www.screener.in/company/STLTECH/', observedAt: '2026-09-04T07:00:00Z' },
      ], meta: { ...payload.meta, screener: { status: 'ok', checkedAt: '2026-09-04T07:00:00Z', portfolioUpcomingAvailable: true } } });
      return;
    }
    if (url.pathname === '/api/super-investors') { const x = data('super-investors.json'); json({ ok: true, investors: x.investors, fetchedAt: x.capturedAt }); return; }
    if (url.pathname === '/api/nse-announcements') { json({ capturedAt: '2026-09-04T08:00:00Z', rows: [
      { company: 'Sterlite Technologies', ticker: 'STLTECH', publishedAt: '2026-09-04T07:00:00Z', subject: 'Analyst day complete source record', description: 'Original analyst presentation', url: 'https://example.test/analyst.pdf' },
      { company: 'Undated issuer', ticker: null, publishedAt: null, subject: 'Undated retained item', url: 'https://example.test/undated.pdf' },
      ...(version > 1 ? [{ company: 'Sterlite Technologies', ticker: 'STLTECH', publishedAt: '2026-09-04T08:00:00Z', subject: 'Newly arrived NSE record', url: 'https://example.test/new.pdf' }] : []),
    ] }); return; }
    if (url.pathname === '/api/ipo-monitor') {
      const date = url.searchParams.get('snapshot');
      json(date ? { ok: true, snapshot: data('ipo-monitor/snapshots/' + date + '.json') } : {
        ok: true, latest: data('ipo-monitor/latest.json'), config: data('ipo-monitor/scoring_config.json'), historyAvailable: true,
        historyDates: data('ipo-monitor/index.json').historyDates,
      }); return;
    }
    if (url.pathname === '/chatter/dashboard') { json(JSON.parse(readFileSync(resolve(root, '../scripts/fixtures/chatter-dashboard.json')))); return; }
    if (url.pathname === '/chatter/health') { json({ ok: true, ageSeconds: 0 }); return; }
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
await page.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
const settled = async () => {
  try {
    await page.waitForFunction(() => {
      const chips = [...document.querySelectorAll('[data-feed]')];
      const panel = document.querySelector('#root');
      return chips.length > 15 && chips.every((c) => !c.textContent.includes('reading…')) && !/Reading \d+ more feeds?/.test(panel?.textContent || '');
    }, null, { timeout: Number(process.env.GENERAL_ALERTS_SETTLE_MS || 90000) });
  } catch (error) {
    const pending = await page.locator('[data-feed]').evaluateAll((chips) => chips.map((chip) => chip.textContent.trim()).filter((label) => label.includes('reading…')));
    const state = await page.locator('#root').innerText().catch(() => 'root unavailable');
    throw new Error(`All Alerts did not settle; pending feeds: ${pending.join(', ') || 'controls unavailable'}; page: ${state.slice(0, 500) || 'empty'}; errors: ${errors.join(' | ') || 'none'}`, { cause: error });
  }
};
try {
  await page.goto(origin);
  await settled();
  console.log('Rendered complete All Alerts pool');
  assert.equal(await page.locator('[data-feed]').count(), 19, 'Universe hides the portfolio-only calendar');
  assert.equal(await page.locator('[data-horizon-toggle]').count(), 2);
  assert.equal(await page.locator('[data-horizon-toggle="through"]').getAttribute('aria-selected'), 'true');
  const sourceControl = await page.locator('[data-feed]').first().evaluate((node) => {
    const checkbox = node.querySelector('span');
    return {
      touchTarget: node.classList.contains('min-h-10'),
      checkbox: checkbox?.classList.contains('h-5') && checkbox?.classList.contains('w-5'),
    };
  });
  assert(
    sourceControl.touchTarget && sourceControl.checkbox,
    'source controls ship comfortable touch targets and legible checkboxes',
  );
  await page.locator('[data-horizon-toggle="through"]').press('ArrowRight');
  assert.equal(await page.locator('[data-horizon-toggle="upcoming"]').getAttribute('aria-selected'), 'true', 'time horizon is keyboard operable');
  await page.locator('[data-horizon-toggle="upcoming"]').press('ArrowLeft');
  assert.equal(await page.locator('[data-horizon-toggle="through"]').getAttribute('aria-selected'), 'true');
  await page.evaluate(() => window.show('portfolio'));
  await settled();
  assert.equal(await page.locator('[data-feed="screener-portfolio-upcoming"]').count(), 1);
  await page.locator('[data-horizon-toggle="upcoming"]').click();
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('AGM scheduled'));
  assert.equal(await page.locator('[data-horizon-toggle="upcoming"]').getAttribute('aria-selected'), 'true');
  assert((await page.locator('[data-alerts-coverage]').innerText()).includes('Portfolio calendar'));
  assert(!(await page.locator('[data-alerts-coverage]').innerText()).includes('Price & volume'), 'Upcoming hides sources that cannot schedule events');
  const upcomingHeaders = await page.locator('thead').innerText();
  assert(upcomingHeaders.includes('WHAT IS SCHEDULED'));
  assert(!upcomingHeaders.includes('DIRECTION') && !upcomingHeaders.includes('IMPORTANCE'));
  if (process.env.GENERAL_ALERTS_UPCOMING_SCREENSHOT) await page.screenshot({ path: process.env.GENERAL_ALERTS_UPCOMING_SCREENSHOT });
  await page.locator('[data-horizon-toggle="through"]').click();
  await page.waitForFunction(() => document.querySelector('[data-horizon-toggle="through"]')?.getAttribute('aria-selected') === 'true');
  await page.evaluate(() => window.show('universe'));
  await settled();
  const coverageText = await page.locator('[data-alerts-coverage]').innerText();
  assert(!/stale\s*\/\s*unknown|incomplete|on-demand|not in scope/i.test(coverageText), 'customer-facing source filters omit feed-health jargon');
  assert.equal(await page.locator('[data-feed][title*="stale" i], [data-feed][title*="unknown" i], [data-feed][title*="incomplete" i], [data-feed][title*="on-demand" i]').count(), 0,
    'feed-health jargon is also absent from hover text');
  await page.locator('[data-table-search]').fill('Undated retained item');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Undated retained item'));
  assert((await page.locator('tbody').innerText()).includes('Date not supplied'));
  await page.locator('[data-table-search]').fill('Analyst day complete source record');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Analyst day complete source record'));
  await page.evaluate(() => window.show('portfolio'));
  await settled();
  assert.equal((await page.locator('[data-table-search]').inputValue()).toLowerCase(), 'analyst day complete source record', 'search survives scope updates');
  assert((await page.locator('tbody').innerText()).includes('STLTECH'));
  await page.locator('[data-table-search]').fill('Newly arrived NSE record');
  version++;
  await page.locator('#refresh').click();
  await settled();
  await page.waitForFunction(async () => {
    const refreshState = await import('/js/core/refresh.js');
    return !refreshState.isRunning('daily-alerts') && document.querySelector('tbody')?.textContent.includes('Newly arrived NSE record');
  }, null, { timeout: 60000 });
  assert.equal((await page.locator('[data-table-search]').inputValue()).toLowerCase(), 'newly arrived nse record');
  console.log('Verified undated search, scope changes and newly arrived filings');

  // Regression: the upstream search padded Jayaswal Neco's result set with a current Investing.com
  // batch. The rows remain retained, but a search for the company must be supported by publisher
  // text rather than by the query-assigned company column. Keep this after the refresh assertion so
  // the extra searches cannot let the tab's deliberate 90-second revalidation race that fixture.
  await page.locator('[data-table-search]').fill('jayaswal');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.toLowerCase().includes('jayaswal'));
  const jayaswalResults = await page.locator('tbody').innerText();
  assert(jayaswalResults.includes('Jayaswal Neco'), 'publisher-supported Jayaswal stories remain searchable');
  assert(!jayaswalResults.includes('Lululemon'), 'query metadata cannot make the unrelated Lululemon story match Jayaswal');
  await page.locator('[data-table-search]').fill('lululemon');
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.toLowerCase().includes('lululemon'));
  assert((await page.locator('tbody').innerText()).includes('Lululemon'), 'the retained story remains searchable by its own publisher text');

  await page.locator('[data-table-search]').fill('Session-private fixture');
  await page.evaluate(async () => (await import('/js/data/alert-records.js')).recordDocuments('company-documents', {
    rows: [{ key: 'session-private', ticker: 'STLTECH', title: 'Session-private fixture', date: null, url: 'https://example.test/private.pdf' }],
  }, { ticker: 'STLTECH', name: 'Sterlite Technologies' }));
  await page.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('Session-private fixture'));
  await page.evaluate(() => { window.testContext = { session: {} }; window.testHostMessage(); });
  await page.waitForFunction(() => !document.querySelector('tbody')?.textContent.includes('Session-private fixture'));
  assert(await page.evaluate(() => !JSON.stringify(localStorage).includes('Session-private fixture')));
  await page.evaluate(() => window.show('universe'));
  await settled();
  await page.locator('[data-table-search]').fill('');
  await page.waitForFunction(() => {
    const first = document.querySelector('tbody [data-event-day]');
    return first?.getAttribute('data-event-day');
  });
  assert(!(await page.locator('tbody tr').first().innerText()).includes('Date not supplied'), 'undated rows sort after dated records');

  const tableContract = await page.evaluate(() => {
    const scroller = document.querySelector('[data-table-scroll]');
    const style = getComputedStyle(scroller);
    return {
      headers: [...document.querySelectorAll('thead th')].map((cell) => cell.innerText.replace(/[▴▾]/g, '').trim()),
      className: scroller.className,
      tabIndex: scroller.tabIndex,
      role: scroller.getAttribute('role'),
      label: scroller.getAttribute('aria-label'),
      overscroll: style.overscrollBehavior,
      touchAction: style.touchAction,
      signals: [...document.querySelectorAll('[data-alert-signal]')].map((cell) => ({
        direction: cell.dataset.alertDirection,
        importance: cell.dataset.alertImportance,
        label: cell.getAttribute('aria-label'),
      })),
    };
  });
  assert.deepEqual(tableContract.headers.slice(0, 3), ['DATE / TIME', 'SIGNAL / PRIORITY', 'COMPANY']);
  assert(!tableContract.headers.includes('DIRECTION') && !tableContract.headers.includes('IMPORTANCE'));
  assert(tableContract.className.includes('table-scroll-surface'));
  assert.equal(tableContract.tabIndex, 0);
  assert.equal(tableContract.role, 'region');
  assert.equal(tableContract.label, 'All Alerts history table');
  assert.equal(tableContract.overscroll, 'contain');
  assert.equal(tableContract.touchAction, 'pan-x pan-y');
  assert(tableContract.signals.length > 0 && tableContract.signals.every((signal) =>
    ['positive', 'negative', 'neutral'].includes(signal.direction) &&
    ['high', 'low'].includes(signal.importance) &&
    /direction, (High|Low) priority/.test(signal.label)));

  // A source refresh can insert rows above the viewport. Preserve the visible event, not merely
  // its old pixel offset, so a reader never loses their place while the stream is live.
  const beforeRefresh = await page.locator('[data-table-scroll]').evaluate((scroller) => {
    scroller.style.scrollBehavior = 'auto';
    scroller.scrollTop = Math.min(900, scroller.scrollHeight - scroller.clientHeight);
    scroller.style.removeProperty('scroll-behavior');
    const boundary = scroller.getBoundingClientRect().top + (scroller.querySelector('thead')?.offsetHeight || 0);
    const row = [...scroller.querySelectorAll('tbody tr[data-row-key]')].find((item) => item.getBoundingClientRect().bottom > boundary);
    return { key: row?.dataset.rowKey || null, offset: row ? row.getBoundingClientRect().top - boundary : 0 };
  });
  assert(beforeRefresh.key && (await page.locator('[data-table-scroll]').evaluate((el) => el.scrollTop)) > 0);
  await page.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  await settled();
  const afterRefresh = await page.locator('[data-table-scroll]').evaluate((scroller, key) => {
    const boundary = scroller.getBoundingClientRect().top + (scroller.querySelector('thead')?.offsetHeight || 0);
    const row = [...scroller.querySelectorAll('tbody tr[data-row-key]')].find((item) => item.dataset.rowKey === key);
    return { key: row?.dataset.rowKey || null, offset: row ? row.getBoundingClientRect().top - boundary : null };
  }, beforeRefresh.key);
  assert.equal(afterRefresh.key, beforeRefresh.key);
  assert(Math.abs(afterRefresh.offset - beforeRefresh.offset) <= 2, `visible row moved ${afterRefresh.offset - beforeRefresh.offset}px during refresh`);

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `no page overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.env.GENERAL_ALERTS_SCREENSHOT) await page.screenshot({ path: process.env.GENERAL_ALERTS_SCREENSHOT });
  await page.evaluate(() => window.dispose());
  const count = calls.length;
  await page.evaluate(async () => { (await import('/js/data/alert-records.js')).clearPrivateRecords(); });
  await page.waitForTimeout(400);
  assert.equal(calls.length, count, 'destroy removes source listeners and does not start another read');
  assert(!calls.some((p) => /\/api\/(combined-filings|drhp-filings|super-investors\/)/.test(p)), 'no per-company fanout');
  assert.deepEqual(errors, [], 'zero application errors');
  console.log('PASS: 20 normalized feed categories (19 visible in Universe), source updates, private-session clearing, filters, responsive layout and cleanup.');
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
