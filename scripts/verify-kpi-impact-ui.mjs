#!/usr/bin/env node
// AI Alerts retains KPI search and evidence after removing the card's KPI heading and chips.
// The real tab and ranking read locally collected fixture events; no production requests.
//
//   PLAYWRIGHT_ROOT=/path/to/node_modules/playwright node scripts/verify-kpi-impact-ui.mjs [screenshot.png]

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const { announcementEvent } = await import('../public/js/data/daily-alerts.js');
const { matchKeywords } = await import('../public/js/data/news-keywords.js');
const { ATTRIBUTION_VERSION } = await import('../public/js/data/company-news-attribution.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const screenshot = process.argv[2] || null;

let seq = 0;
const filing = (ticker, company, title, subCategory) => {
  const event = announcementEvent({ newsId: `ui-${++seq}`, ticker, company, title, headline: title, subCategory, category: 'Company Update',
    date: '2026-09-22', time: '10:30:00', url: `https://www.bseindia.com/fixture/${seq}.pdf`, source: 'BSE' });
  const { sourceRecord, ...rest } = event;
  return { ...rest, feed: 'announcements', feedLabel: 'Corporate Announcements', company };
};
const story = (ticker, company, headline) => {
  const hits = matchKeywords(headline);
  return { id: `news:${++seq}`, feed: 'news', feedLabel: 'Company News', ticker, company, time: '09:00', headline, detail: 'Published by Fixture Wire',
    url: `https://news.example.test/${seq}`, importance: 'high', direction: 'neutral', keywordIds: hits.map((h) => h.id), keywords: hits.map((h) => h.label),
    attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed', reason: 'fixture' }, namesCompany: true, aiEligible: true };
};
const events = [
  filing('BHEL', 'Bharat Heavy Electricals', 'Receipt of order worth Rs. 2,500 crore for supply of boilers', 'Award of Order / Receipt of Order'),
  story('SBIN', 'State Bank of India', 'SBI raises Rs 10,000 crore via QIP'),
  { id: 'call:SBIN', feed: 'concalls', feedLabel: 'Con-call', ticker: 'SBIN', company: 'State Bank of India', time: '17:00',
    headline: 'Con-call analysis published', detail: 'Good result score 72.0 · ▲ NIM expanded 20bps QoQ', url: 'https://stockscans.example.test/call',
    importance: 'high', direction: 'positive', tags: ['▲ NIM expanded 20bps QoQ', '▲ Cost-to-income 42.3% → 38.4%'] },
  story('LUPIN', 'Lupin', 'Lupin receives USFDA approval for generic diabetes drug'),
  { id: 'earnings:LUPIN', feed: 'earnings', feedLabel: 'Earnings', ticker: 'LUPIN', company: 'Lupin', time: null, headline: 'YoY quarterly result filed',
    detail: 'Revenue +13.0% · Net Profit to profit', url: 'https://www.moneycontrol.com/fixture', importance: 'high', direction: 'positive',
    resultBasis: 'YoY', metrics: { revenue: { label: 'Revenue', pct: 13, kind: 'normal' }, netProfit: { label: 'Net Profit', pct: null, kind: 'turnaround' } } },
  filing('ZZUNKNOWN', 'Unclassified Industries', 'Receipt of order worth Rs. 90 crore for supply of pumps', 'Award of Order / Receipt of Order'),
];
const holdings = [...new Map(events.map((e) => [e.ticker, { ticker: e.ticker, name: e.company }])).values()]
  .map((h, i) => ({ ...h, isin: `INE${String(i).padStart(9, '0')}`, sector: 'Test' }));
const feeds = ['announcements', 'news', 'concalls', 'earnings'].map((id) => ({ id, status: 'ok', reachesToday: true }));

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head>
<body style="padding:16px;background:#f6f4fb;font-family:Arial,sans-serif"><main id="root" class="mx-auto max-w-7xl"></main>
<script>window.fixtureEvents=${JSON.stringify(events)};</script>
<script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({holdings:${JSON.stringify(holdings)}});
tab.render({root:document.querySelector('#root'),scope:'portfolio',params:{}});
</script></body></html>`;
const fixtureModule = `
import { currentDay } from '../ui/ai-alert-utils.js';
export { currentDay as today } from '../ui/ai-alert-utils.js';
const listeners=new Set(); export const onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
export async function readCachedAlertWindow(){ return null; }
export async function collect({scope,onPartial}) {
  const day=currentDay();
  const report={day,scope,events:window.fixtureEvents.map(e=>({...e,day,at:day})),feeds:${JSON.stringify(feeds)},pending:0};
  onPartial?.(report);
  return report;
}`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (pathname === '/js/data/daily-alerts.js') { res.setHeader('content-type', 'text/javascript'); res.end(fixtureModule); return; }
    if (pathname === '/js/data/capture-watchdog.js') { res.setHeader('content-type', 'text/javascript'); res.end('export const onCaptureLanded=()=>()=>{};'); return; }
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] || 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' })));
  await page.goto(origin);
  const card = (ticker) => page.locator(`[data-ai-card][data-ticker="${ticker}"]`);
  await card('BHEL').waitFor({ timeout: 15000 });

  // textContent, not innerText: every card is `content-visibility: auto`, and Chromium keeps one it
  // has not yet rendered near the viewport SKIPPED — empty innerText — while its text is all there.
  const text = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(await page.locator('[data-ai-kpis], [data-ai-kpi], [data-ai-kpi-more]').count(), 0,
    'classified cards render no KPI heading, chips or overflow count');
  assert(!/KPIs in play/i.test(await text(page.locator('[data-ai-cards]'))), 'the removed heading is absent');

  // All five bank KPIs remain searchable, including the one previously hidden behind +1.
  for (const name of ['Capital Adequacy Ratio', 'EPS', 'Book Value Per Share', 'Net Interest Margin', 'Cost to Income Ratio']) {
    await page.locator('[data-ai-search]').fill(name.toLowerCase());
    await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-card]')].some(el => el.dataset.ticker === 'SBIN'));
  }
  await page.locator('[data-ai-search]').fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-ai-card]').length >= 4);
  assert.match(await text(card('LUPIN').locator('[data-ai-evidence]')), /Result filed \(YoY\) · net profit swung to profit, revenue \+13\.0%/,
    'and the row states it, from the event itself');

  // The headline still leads directly into the dated evidence list.
  const order = await card('BHEL').evaluate((el) => {
    const pos = (sel) => [...el.querySelectorAll('*')].indexOf(el.querySelector(sel));
    return { insight: pos('[data-ai-insight]'), head: pos('[data-ai-list-head]'), evidence: pos('[data-ai-evidence]') };
  });
  assert(order.insight < order.head && order.head < order.evidence, `section order: ${JSON.stringify(order)}`);
  // ONE PLACE FOR THE READING: the card carries no figure strip, no question paragraph and no bullet list.
  assert.equal(await page.locator('[data-ai-metrics], [data-ai-drivers], [data-ai-brief], [data-ai-impact-line]').count(), 0, 'the removed blocks stay removed');
  assert.equal(await card('ZZUNKNOWN').count(), 1, 'the unclassified company still has its card');
  assert.equal(await card('ZZUNKNOWN').locator('[data-ai-kpis]').count(), 0, 'no sector, no KPI row');

  // Searching by a KPI name finds the card that names it.
  await page.locator('[data-ai-search]').fill('order book');
  await page.waitForFunction(() => document.querySelectorAll('[data-ai-card]').length === 1);
  assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), 'BHEL');
  await page.locator('[data-ai-search]').fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-ai-card]').length >= 4);

  if (screenshot) await card('BHEL').screenshot({ path: screenshot });

  // Phone width: the simplified cards stay within the viewport.
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'no sideways scroll at 390px');
  assert.equal(await page.locator('[data-ai-kpis], [data-ai-kpi]').count(), 0, 'phone cards omit the KPI row too');
  if (screenshot) await card('LUPIN').screenshot({ path: screenshot.replace(/\.png$/, '-390.png') });

  assert.deepEqual(errors, [], 'zero page errors');

  // Failure status still explains incomplete KPI search and saved details.
  const broken = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  broken.on('pageerror', (error) => errors.push(error.message));
  await broken.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('/data/sector-kpis.json')) return route.fulfill({ status: 404, body: 'not found' });
    return url.startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' });
  });
  await broken.goto(origin);
  await broken.locator('[data-ai-card][data-ticker="BHEL"]').waitFor({ timeout: 15000 });
  await broken.locator('[data-ai-kpi-status]').waitFor({ timeout: 15000 });
  assert.match(await broken.locator('[data-ai-kpi-status]').innerText(), /Sector KPI data unavailable · KPI search and bookmark details may be incomplete/);
  assert.equal(await broken.locator('[data-ai-kpis]').count(), 0, 'no card claims a KPI line it could not read');
  assert.deepEqual(errors, [], 'zero page errors with the sector file missing');
  await broken.close();
  console.log('PASS simplified cards: no KPI heading or chips, complete KPI search, retained result figures, honest sector failure status, 390px layout, zero page errors.');
} finally {
  await browser.close();
  server.close();
}
