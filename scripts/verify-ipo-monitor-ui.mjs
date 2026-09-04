#!/usr/bin/env node
// Same-table visual/behavior regression. Local browser + real captures; every external call blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const ExcelJS = (await import(`${process.env.EXCELJS_ROOT}/excel.js`)).default;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const capture = JSON.parse(readFileSync(resolve(root, 'data/ipo-filings.json')));
let failure = false, delay = 0, live = structuredClone(capture);
const requests = [], errors = [];
const shellStyles = [...readFileSync(resolve(root, 'index.html'), 'utf8').matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((match) => match[0]).join('');
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/style.css">${shellStyles}<script src="/test-exceljs.js"></script></head><body style="padding:20px;background:#f6f5ff"><main id="root" style="max-width:1200px;margin:auto"></main><script type="module">
import * as tab from '/js/tabs/ipos.js';
import { mount } from '/js/ui/source-beacon.js';
mount();
const live={ register(id,entry){window.poll=entry;},start(){window.pollStarted=true;},stop(){window.pollStopped=true;} };
window.showIpos=(params={})=>{tab.destroy();tab.render({root:document.querySelector('#root'),params,scope:'watchlist',live});};
window.destroyIpos=()=>{tab.destroy();document.querySelector('#root').innerHTML='Destroyed';};
window.showIpos();
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'); requests.push({ path: url.pathname, method: req.method });
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/test-exceljs.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(`${process.env.EXCELJS_ROOT}/dist/exceljs.min.js`)); return; }
    if (url.pathname === '/api/ipo-filings') {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      res.setHeader('content-type', 'application/json'); res.statusCode = failure ? 503 : 200; res.end(JSON.stringify(failure ? {} : live)); return;
    }
    const path = resolve(root, `.${url.pathname}`);
    if (!path.startsWith(root + sep)) throw Error();
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS', label); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.clock.setFixedTime(new Date(capture.checkedAt));
  await page.goto(origin);
  const ready = () => page.locator('[data-ipo-refresh]:not([disabled])').waitFor();
  await ready();
  check('native NSE-style table replaces weekly tracker and scoring', await page.locator('[data-score-table]').count() === 1 && await page.locator('.ipo-board, .ipo-card, [data-ipo-settings]').count() === 0);
  check('empty Watchlist still loads every captured issuer', (await page.locator('[data-row-count]').innerText()).startsWith(`${capture.rows.length} of ${capture.rows.length}`));
  check('newest dated filings appear first', (await page.locator('[data-row-key]').first().innerText()).includes('04 Sept 2026'));
  check('automatic refresh is registered at five minutes', await page.evaluate(() => window.pollStarted && window.poll.intervalMs === 300000));
  check('long source disclosure removed from the IPO table', await page.locator('#root [data-ipo-coverage]').count() === 0);
  await page.locator('[data-ipo-sources]').click();
  const ipoGroup = page.locator('[data-beacon-group="ipo-filings"]');
  check('source shortcut opens existing beacon at all eight IPO sources', await ipoGroup.isVisible() && await ipoGroup.locator('[data-beacon-source]').count() === 8 && await page.locator('[data-beacon-notes="ipo-filings"] > summary').evaluate((el) => el === document.activeElement));
  check('live-feed and source totals are derived from the updated registry', await page.evaluate(async () => {
    const { sourceGroups } = await import('/js/ui/sources.js');
    const items = sourceGroups().flatMap((g) => g.items);
    return document.querySelector('[data-beacon-launch-count]').textContent === `${items.filter((s) => s.status === 'live').length} live feeds` && !items.some((s) => s.name.includes('public IPO monitor'));
  }));
  await page.locator('[data-beacon-notes="ipo-filings"] > summary').click();
  check('coverage limitations moved into expandable source-panel details', (await ipoGroup.innerText()).includes('hourly by GitHub Actions even while closed') && (await ipoGroup.innerText()).includes('BSE-only mainboard'));
  const bseDetails = page.locator('[data-beacon-source="bse-sme"]');
  await bseDetails.locator('summary').click();
  const originalBse = structuredClone(live.sources.find((s) => s.id === 'bse-sme'));
  Object.assign(live.sources.find((s) => s.id === 'bse-sme'), { status: 'failed', note: 'Source unavailable in fixture', count: 0 });
  await page.evaluate(() => window.poll.fetcher());
  check('open source panel updates failures without losing expanded rows or keyboard focus', await bseDetails.getAttribute('open') !== null && (await bseDetails.innerText()).includes('Source unavailable in fixture') && await bseDetails.locator('summary').evaluate((el) => el === document.activeElement && !el.classList.contains('is-live')));
  Object.assign(live.sources.find((s) => s.id === 'bse-sme'), originalBse);
  await page.evaluate(() => window.poll.fetcher());
  check('source recovery updates the existing panel', await bseDetails.locator('summary').evaluate((el) => el.classList.contains('is-live')));
  await page.keyboard.press('Escape');
  check('source panel closes with Escape and returns focus', await page.locator('#source-beacon-panel').count() === 0 && await page.locator('[data-beacon-toggle]').evaluate((el) => el === document.activeElement));
  if (process.env.IPO_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.IPO_SCREENSHOT_DIR}/ipo-filings-desktop.png`, fullPage: true });
  await page.locator('[data-table-search]').fill('EAAA');
  check('retained EAAA supplement is searchable', (await page.locator('[data-row-key]').count()) >= 2 && (await page.locator('[data-score-table]').innerText()).includes('EAAA India Alternatives'));
  await page.locator('[data-table-search]').fill('Edelweiss Alternatives');
  check('issuer aliases are retained', await page.locator('[data-row-key]').count() >= 1);
  await page.locator('[data-table-search]').fill('');
  live.companies = [{ id: '999999', company: 'Directory-only <img src=x onerror="window.ipoXss=1">', url: 'https://www.ipoplatform.com/ipo/directory-only/999999', board: 'SME', status: 'Upcoming', openingWindow: '10 Sep - 15 Sep', listingDate: '2026-09-18', observedAt: capture.checkedAt, retained: false }];
  await page.evaluate(() => window.poll.fetcher());
  await page.locator('[data-ipo-view]').selectOption('directory');
  check('issuer directory uses same native table and includes companies without filings', await page.locator('[data-score-table]').count() === 1 && (await page.locator('[data-row-count]').innerText()).startsWith('1 of 1') && (await page.locator('[data-row-key]').innerText()).includes('Upcoming'));
  check('publisher directory metadata is labelled and HTML escaped', (await page.locator('#root').innerText()).includes('not exchange confirmations') && await page.locator('[data-row-key] img').count() === 0 && await page.evaluate(() => !window.ipoXss));
  const directoryDownload = page.waitForEvent('download'); await page.locator('[data-export]').click();
  const directoryWorkbook = new ExcelJS.Workbook(); await directoryWorkbook.xlsx.readFile(await (await directoryDownload).path());
  check('directory export includes publisher provenance and all matching issuers', directoryWorkbook.worksheets[0].name === 'IPO directory' && directoryWorkbook.worksheets[0].rowCount === 3);
  failure = true; await page.locator('[data-ipo-refresh]').click(); await ready();
  check('directory survives outage without a fresh label', await page.locator('[data-row-key]').count() === 1 && (await page.locator('[data-ipo-freshness]').innerText()).includes('unavailable'));
  failure = false;
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    check(`directory contains overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`directory search remains usable at ${width}px`, await page.locator('[data-table-search]').evaluate((el) => el.getBoundingClientRect().width >= 160));
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.locator('[data-ipo-view]').selectOption('filings');
  await page.locator('[data-table-filter="1"]').selectOption('SME');
  await page.locator('[data-table-filter="2"]').selectOption('BSE SME');
  await page.locator('[data-table-filter="0"]').selectOption('DRHP / Draft prospectus');
  const visibleBefore = await page.locator('[data-row-count]').innerText();
  await page.locator('[data-ipo-refresh]').click(); await ready();
  check('refresh preserves filters and counts', await page.locator('[data-row-count]').innerText() === visibleBefore && await page.locator('[data-table-filter="1"]').inputValue() === 'SME');
  const expectedCount = Number(visibleBefore.split(' ')[0]);
  const downloadPromise = page.waitForEvent('download'); await page.locator('[data-export]').click(); const download = await downloadPromise;
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(await download.path());
  check('Excel exports all filtered rows, not just rendered rows, with provenance', workbook.worksheets[0].rowCount === expectedCount + 2 && workbook.worksheets[1].name === 'Coverage' && String(workbook.worksheets[0].getCell('A1').value).includes('not a complete IPO universe'));
  await page.evaluate(() => window.showIpos()); await ready();
  await page.locator('[data-ipo-history]').selectOption('7');
  check('recent window excludes undated documents without inventing dates', (await page.locator('[data-row-key]').allTextContents()).every((t) => !t.includes('Date not supplied')));
  await page.locator('[data-ipo-history]').selectOption('undated');
  check('undated documents remain accessible separately', await page.locator('[data-row-key]').count() > 0 && (await page.locator('[data-row-key]').first().innerText()).includes('Date not supplied'));
  await page.locator('[data-ipo-history]').selectOption('all');
  await page.locator('[data-table-search]').fill('Example new arrival');
  live.rows.push({ ...capture.rows[0], company: 'Example new arrival', title: 'Example new arrival · DRHP', url: 'https://www.sebi.gov.in/new-arrival.pdf', observedAt: capture.checkedAt });
  await page.evaluate(() => window.poll.fetcher());
  check('a newly published filing arrives through automatic refresh while preserving search', await page.locator('[data-row-key]').count() === 1 && await page.locator('[data-table-search]').inputValue() === 'Example new arrival');
  failure = true; await page.locator('[data-ipo-refresh]').click(); await ready();
  check('source outage retains documents with a visible stale warning', (await page.locator('[data-ipo-freshness]').innerText()).includes('unavailable') && await page.locator('[data-row-key]').count() === 1);
  await page.locator('[data-ipo-sources]').click();
  check('whole-feed outage does not leave green IPO sources in the beacon', await page.locator('[data-beacon-group="ipo-filings"] .beacon-row.is-live').count() === 0);
  await page.keyboard.press('Escape');
  failure = false;
  const bad = { ...capture.rows[0], company: '<img src=x onerror="window.ipoXss=1">', title: 'Escaped document', url: 'https://www.sebi.gov.in/xss-test.pdf', observedAt: capture.checkedAt };
  live.rows.push(bad); await page.locator('[data-table-search]').fill('onerror'); await page.locator('[data-ipo-refresh]').click(); await ready();
  check('source HTML is escaped', await page.locator('[data-row-key] img').count() === 0 && await page.evaluate(() => !window.ipoXss));
  await page.locator('[data-table-search]').fill('');
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    check(`controls remain usable without page overflow at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  if (process.env.IPO_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.IPO_SCREENSHOT_DIR}/ipo-filings-mobile.png`, fullPage: true });
  delay = 250;
  await page.locator('[data-ipo-refresh]').click(); await page.evaluate(() => window.destroyIpos());
  await page.waitForTimeout(400);
  check('leaving stops polling and prevents late repaint', await page.locator('#root').innerText() === 'Destroyed' && await page.evaluate(() => window.pollStopped));
  check('no private lookup, legacy weekly API or production mutation', requests.every((r) => r.method === 'GET') && !requests.some((r) => /ipo-monitor|drhp-filings|\/refresh$/.test(r.path)));
  check('no browser errors', errors.length === 0);
  console.log(`${checks} IPO browser checks passed`);
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
