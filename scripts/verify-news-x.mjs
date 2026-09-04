#!/usr/bin/env node
// Focused browser checks for the combined News tab, with fictional feed fixtures and no dispatch.
// Serve public/ locally, then run: node scripts/verify-news-x.mjs http://127.0.0.1:8080
import assert from 'node:assert/strict';
const root = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${root}/index.mjs`);
const base = process.argv[2] || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60000).toISOString();
const posts = [
  { tweet_id: '901', handle: 'sattva_desk', display_name: 'Fixture Desk', text: 'Fixture factory fire reported. Moneycontrol is named verbatim in this fictional test.', created_at: at(10), url: 'https://x.com/sattva_desk/status/901' },
  { tweet_id: '902', handle: 'sattva_wire', display_name: 'Fixture Wire', text: 'Fixture analyst update.', created_at: at(30), url: 'https://x.com/sattva_wire/status/902' },
];
const handles = { handles: [{ handle: 'sattva_desk' }, { handle: 'sattva_wire' }] };
const articles = [
  { id: '100', publisher: 'Fixture News', title: 'Fixture issuer wins new order', publishedAt: at(20), section: 'stocks', url: 'https://example.test/news/100' },
  { id: '101', publisher: 'Fixture Journal', title: 'Fixture market roundup', publishedAt: at(5), section: 'markets', url: 'https://example.test/news/101' },
];
let checks = 0;
const ok = (name, test) => { assert.ok(test, name); checks++; console.log(`PASS ${name}`); };

async function open(capture) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'offline test' } }));
  await page.route('**/market-news.json*', (r) => r.fulfill({ json: { capturedAt: at(1), articles, archive: [] } }));
  await page.route('**/twitter-handles.json*', (r) => r.fulfill({ json: handles }));
  await page.route('**/twitter-posts.json*', (r) => r.fulfill({ json: capture }));
  await page.goto(`${base}/#/research/news?scope=universe`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-news-source]');
  await page.waitForFunction(() => document.querySelector('[data-news-coverage]')?.textContent.includes('2 monitored X accounts'));
  return page;
}
const keys = (page) => page.locator('[data-news-key]').evaluateAll((els) => els.map((el) => el.dataset.newsKey));

try {
  const page = await open({ capturedAt: at(1), posts, failed: [] });
  await page.waitForFunction(() => document.querySelectorAll('[data-news-key]').length === 4);
  ok('all publisher stories and X posts share chronological order', JSON.stringify(await keys(page)) === JSON.stringify(['101', 'tw:901', '100', 'tw:902']));
  ok('coverage states both source counts and the X collection time', /2 publisher stories · 2 X posts · 2 monitored X accounts.*X last read/s.test(await page.locator('[data-news-coverage]').innerText()));
  await page.selectOption('[data-news-publisher]', 'Fixture News');
  ok('a publisher filter narrows publisher stories', (await keys(page)).join() === '100');
  await page.selectOption('[data-news-source]', 'twitter');
  ok('switching to X clears publisher-only filters', (await keys(page)).length === 2 && await page.locator('[data-news-publisher]').count() === 0);
  await page.selectOption('[data-news-handle]', 'sattva_wire');
  ok('X accounts can be filtered within this News tab', (await keys(page)).join() === 'tw:902');
  await page.selectOption('[data-news-handle]', 'all');
  await page.fill('[data-news-search]', '@sattva_desk');
  ok('search accepts an @handle', (await keys(page)).join() === 'tw:901');
  await page.fill('[data-news-search]', '');
  await page.selectOption('[data-news-topic]', 'tracked');
  ok('topic filters also search X post text', (await keys(page)).join() === 'tw:901');
  await page.selectOption('[data-news-topic]', 'all');
  ok('X-only history never claims to be a complete X archive', /recent collections/i.test(await page.locator('[data-news-more]').innerText()) && await page.locator('[data-news-more-btn]').count() === 0);

  // Exercise the actual export column getters while replacing only the workbook serializer.
  await page.evaluate(() => {
    window.exportedNews = [];
    window.ExcelJS = { Workbook: class {
      addWorksheet() { return { addRow: (row) => window.exportedNews.push(row), getRow: () => ({}) }; }
      xlsx = { writeBuffer: async () => new Uint8Array() };
    } };
  });
  await page.locator('[data-news-export]').click();
  await page.waitForFunction(() => window.exportedNews.length === 3);
  const exported = await page.evaluate(() => window.exportedNews.slice(1));
  ok('Excel preserves complete X text, author, handle and original link', exported.every((row, i) => row.type === 'X post' && row.h === posts[i].text && row.pub === posts[i].display_name && row.handle === `@${posts[i].handle}` && row.u === posts[i].url));
  await page.locator('[data-news-manage-x]').click();
  ok('X account management opens directly from News', await page.locator('[data-twitter-sources]').isVisible());
  await page.locator('[data-twitter-sources] [data-modal-close]').click();
  await page.selectOption('[data-news-handle]', 'sattva_wire');
  await page.locator('[data-news-manage-x]').click();
  await page.locator('[data-tw-remove="sattva_wire"]').click();
  await page.locator('[data-twitter-sources] [data-modal-close]').click();
  ok('removing the selected account restores the remaining X posts', (await keys(page)).join() === 'tw:901' && await page.locator('[data-news-handle]').inputValue() === 'all');
  await page.evaluate(async () => (await import('/js/core/twitter-handles.js')).add('sattva_wire'));
  await page.fill('[data-news-search]', 'no-matching-fixture');
  await page.locator('[data-news-clear]').click();
  ok('empty results offer a working reset to all sources', (await keys(page)).length === 4 && await page.locator('[data-news-source]').inputValue() === 'all');
  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    ok(`News controls fit the viewport at ${width}px`, await page.locator('[data-mcnews-list]').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  }
  await page.close();

  const empty = await open({ capturedAt: null, posts: [], failed: [] });
  ok('X remains discoverable before the first capture', (await empty.locator('[data-news-source] option[value="twitter"]').count()) === 1);
  await empty.selectOption('[data-news-source]', 'twitter');
  ok('an empty X capture explains setup instead of disappearing', /awaiting its first successful collection/i.test(await empty.locator('[data-news-coverage]').innerText()) && /No X posts are available yet/i.test(await empty.locator('[data-news-scroll]').innerText()));
  await empty.close();
  console.log(`${checks} News/X checks passed.`);
} finally {
  await browser.close();
}
