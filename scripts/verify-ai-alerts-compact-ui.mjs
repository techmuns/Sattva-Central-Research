// AI Alerts' Compact view in a real browser: the default layout, the Compact | Detailed switch and
// its memory, one row per company with the source behind it, broker reports listed on demand,
// nothing that Compact leaves out, phone width and the dark theme. Local fixture only — no
// production reads, no AI requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');

const html = `<!doctype html><html><head><script src="/js/theme-init.js"></script><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body><main id="root" style="padding:24px;max-width:1400px;margin:auto"></main><script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({ holdings: ['TAPE','RESULTCO','BROKERCO','AAA','BBB','CCC','MEETCO','NEWCO'].map(ticker => ({ ticker, name: ticker + ' Limited' })) });
window.show = (scope = 'portfolio') => { tab.destroy(); tab.render({ root: document.querySelector('#root'), scope, params: {} }); };
window.show(); window.ready = true;
</script></body></html>`;

// The collector, replaced: every event the tab ranks, in the shapes the real feeds produce.
const feedModule = `
import { currentDay } from '../ui/ai-alert-utils.js';
import { ATTRIBUTION_VERSION } from './company-news-attribution.js';
export { currentDay as today } from '../ui/ai-alert-utils.js';
const listeners = new Set(); export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
// A source landing, as the real collector announces one: the tab reassembles behind the list.
window.fixtureChanged = () => listeners.forEach(fn => fn());
export async function readCachedAlertWindow() { return null; }
export async function collect({ scope }) {
  const day = currentDay(); let n = 0;
  const ev = (ticker, feed, headline, extra = {}) => ({ id: feed + ':' + ticker + ':' + (++n), ticker, company: ticker + ' Limited', feed, feedLabel: feed,
    headline, detail: '', day, time: '10:' + String(10 + n).padStart(2, '0'), importance: 'high', direction: 'neutral', aiEligible: true,
    url: 'https://example.test/' + ticker + '/' + n, signalReason: 'fixture', importanceReason: 'fixture', ...extra });
  const broker = (ticker, r) => ev(ticker, 'broker-reports', r.broker + ' report', { url: 'https://t.me/researchreportss/' + (900 + n), kind: 'broker-report',
    brokerReport: { id: String(n), ticker, kind: 'view', publishedAt: day + 'T05:00:00.000Z', url: 'https://t.me/researchreportss/' + (900 + n), ...r } });
  const confirmed = { version: ATTRIBUTION_VERSION, status: 'confirmed' };
  const events = [
    ev('TAPE', 'technicals', 'Rose 6.2% at the close', { kind: 'move', movePct: 6.2, direction: 'positive' }),
    ev('RESULTCO', 'earnings', 'YOY quarterly result filed', { resultBasis: 'YOY', metrics: { netProfit: { label: 'Net Profit', kind: 'normal', pct: 21 }, revenue: { label: 'Revenue', kind: 'normal', pct: 16 } }, direction: 'positive' }),
    ev('RESULTCO', 'announcements', 'Unaudited Financial Results for the quarter ended September 30, 2026', { filingSubject: 'Unaudited Financial Results for the quarter ended September 30, 2026', filingSubCategory: 'Financial Results', url: 'https://www.bseindia.com/result.pdf' }),
    ev('RESULTCO', 'news', 'RESULTCO Q2 FY27 results: net profit rises 21%', { namesCompany: true, attribution: confirmed }),
    ev('BROKERCO', 'chatter', 'Bullish public chatter (30d snapshot)', { direction: 'positive' }),
    broker('BROKERCO', { broker: 'Antique', rating: 'BUY', stance: 'bullish', target: 1755, points: 'Margins in-line, PAT beat on lower opex' }),
    broker('BROKERCO', { broker: 'Axis Securities', upsidePct: 34, points: 'Consistent Outperformance Merits a Premium' }),
    broker('BROKERCO', { broker: 'Centrum', upsidePct: 29 }),
    broker('BROKERCO', { broker: 'PL Capital', upsidePct: -8, points: 'Strong Q2' }),
    ev('AAA', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
    ev('BBB', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
    ev('CCC', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
    ev('BBB', 'insider', 'Promoter — Buy', { tradeCategory: 'Block deal', direction: 'positive' }),
    broker('BBB', { broker: 'Nuvama', upsidePct: 12, points: 'Order book visibility' }),
    ev('MEETCO', 'announcements', 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results', { filingSubject: 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results' }),
    ...(window.fixtureExtra || []).map(([ticker, feed, headline, extra]) => ev(ticker, feed, headline, extra)),
  ];
  const feeds = [...new Set(events.map(e => e.feed))].map(id => ({ id, label: id, status: 'ok', reachesToday: true }));
  return { scope, day, events, feeds, pending: 0 };
}`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(html); }
    if (path === '/js/data/holding-sizes.js') { res.setHeader('content-type', 'text/javascript'); return res.end('export const cachedHoldingSizes=()=>null;export const readHoldingSizes=()=>Promise.resolve(null);'); }
    if (path.startsWith('/api/')) { res.writeHead(503); return res.end('{}'); }
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error();
    const body = path === '/js/data/daily-alerts.js' ? feedModule : readFileSync(file);
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ...options });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' })));
  return { context, page };
};
const rows = (page) => page.locator('[data-ai-compact-row]');
const row = (page, ticker) => page.locator(`[data-ai-compact-row][data-ticker="${ticker}"]`);

try {
  const { context, page } = await open();
  await page.goto(origin);
  await page.waitForSelector('[data-ai-compact-row]');

  // Compact is the default, and the switch says so.
  assert.equal(await page.locator('[data-ai-card]').count(), 0, 'Compact is the default layout');
  assert.equal(await page.locator('[data-ai-view="compact"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-ai-view="detailed"]').getAttribute('aria-pressed'), 'false');

  // One row per company; what Compact leaves out is not drawn, and the pill says how many.
  const tickers = await rows(page).evaluateAll((nodes) => nodes.map((n) => n.dataset.ticker));
  assert.equal(new Set(tickers).size, tickers.length, 'one row per company');
  assert(!tickers.includes('TAPE'), 'a price-and-volume only company is left to Detailed');
  assert(!tickers.includes('MEETCO'), 'a board-meeting intimation is a date');
  const pillTitle = await page.locator('[data-ai-feed-status] [title]').first().getAttribute('title');
  assert.match(pillTitle, /Compact shows the Detailed alerts filtered/);
  assert.match(pillTitle, /3 companies appear only in Detailed/);
  // A company whose only item is a story already on another row is left to Detailed, and every
  // count counts rows: the companies line and the All chip agree with what is drawn.
  assert.equal(['AAA', 'CCC'].filter((t) => tickers.includes(t)).length, 1, 'of two companies whose only item is one story, one row carries it');
  assert.match(await page.locator('.ai-alert-count').textContent(), new RegExp(`${tickers.length}\\s+companies`));
  assert.match(await page.locator('[data-ai-filter="all"]').textContent(), new RegExp(`· ${tickers.length}$`));

  // A result is one row and opens the company's own filing, in a new tab.
  const result = row(page, 'RESULTCO');
  assert.equal(await result.getAttribute('data-kind'), 'result');
  assert.match(await result.locator('.ai-compact-text').textContent(), /net profit \+21\.0%, revenue \+16\.0%/);
  const link = result.locator('a.ai-compact-hit');
  assert.equal(await link.getAttribute('href'), 'https://www.bseindia.com/result.pdf');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await result.locator('[data-ai-mcap]').count(), 1, 'a market cap cell on every row');
  // The whole row is the control: the link's overlay covers the row.
  const box = await result.boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a, button')?.className || '', { x: box.x + box.width * 0.6, y: box.y + box.height / 2 });
  assert.match(hit, /ai-compact-hit/, 'a click anywhere on the row opens its source');

  // A story tagged to two companies leads one row; the second leads with its own item.
  const shared = await rows(page).locator('a.ai-compact-hit[href="https://example.test/shared-story"]').count();
  assert.equal(shared, 1, 'a story leads one row');

  // Broker views: the row lists every report on demand, each linking to its post.
  const brokerRow = row(page, 'BROKERCO');
  assert.equal(await brokerRow.getAttribute('data-kind'), 'broker', 'four broker reports lead over a chatter snapshot');
  assert.match(await brokerRow.locator('.ai-compact-text').textContent(), /4 broker reports in 14 days\. Antique rates it BUY with a ₹1,755 target; (?:Axis Securities and Centrum|Centrum and Axis Securities) see 29–34% upside; PL Capital sees 8% downside\./);
  assert.equal(await brokerRow.locator('.ai-compact-reports').isVisible(), false, 'reports are closed until asked for');
  // The reports sit behind a button that says what it does: a count and an explicit Show / Hide.
  const pill = brokerRow.locator('button.ai-compact-brokers');
  assert.equal(await pill.count(), 1, 'a broker-led row has its own reports button too');
  assert.match(await pill.innerText(), /4 reports\s*Show/);
  await brokerRow.locator('button.ai-compact-hit').click();
  await brokerRow.locator('.ai-compact-reports').waitFor({ state: 'visible' });
  assert.equal(await brokerRow.locator('button.ai-compact-hit').getAttribute('aria-expanded'), 'true');
  assert.equal(await pill.getAttribute('aria-expanded'), 'true', 'every control for the list agrees it is open');
  assert.match(await pill.innerText(), /Hide/);
  assert.doesNotMatch(await pill.innerText(), /Show/);
  await pill.click();
  assert.equal(await brokerRow.locator('.ai-compact-reports').isVisible(), false, 'the same button closes it');
  assert.match(await pill.innerText(), /Show/);
  await pill.click();
  await brokerRow.locator('.ai-compact-reports').waitFor({ state: 'visible' });
  const reports = await brokerRow.locator('.ai-compact-report').evaluateAll((nodes) => nodes.map((n) => [n.querySelector('.ai-compact-report-broker').textContent, n.getAttribute('href'), n.getAttribute('target')]));
  assert.equal(reports.length, 4);
  assert(reports.every(([, href, target]) => href.startsWith('https://t.me/researchreportss/') && target === '_blank'), 'each report links to its own post');
  assert.equal(await brokerRow.locator('.ai-compact-stance').first().textContent(), 'BUY', 'a stance only where the broker printed a rating');
  // A secondary broker line on a row led by something else.
  const bbb = row(page, 'BBB');
  assert.match(await bbb.locator('button.ai-compact-brokers').innerText(), /1 broker report\s*·?\s*.*Show/s, 'a secondary line names the count, the call and the action');
  await bbb.locator('button.ai-compact-brokers').click();
  assert.equal(await bbb.locator('.ai-compact-report').count(), 1);
  assert.equal(await bbb.locator('.ai-compact-reports').isVisible(), true);

  // Nothing Compact leaves out leaks into the text, and every line is within sixty words.
  for (const text of await page.locator('.ai-compact-text').allTextContents()) {
    assert(!/RSI|check both directions below/i.test(text), text);
    assert(text.trim().split(/\s+/).length <= 63, `sixty words: ${text}`);
  }

  // Search reads what Compact keeps: a query found only in an excluded RSI-style reading draws nothing.
  await page.locator('[data-ai-search]').fill('Rose 6.2%');
  await page.waitForSelector('[data-ai-compact-empty]');
  assert.equal(await rows(page).count(), 0, 'no unrelated row is drawn as a match');
  await page.locator('[data-ai-search]').fill('Award of order');
  // The story's row, and BBB — whose own retained filing matches — leading with its next item.
  await page.waitForFunction(() => document.querySelectorAll('[data-ai-compact-row]').length === 2);
  assert.match(await page.locator('.ai-alert-count').textContent(), /2\s+companies matching/);
  await page.locator('[data-ai-search]').fill('');
  await page.waitForFunction((n) => document.querySelectorAll('[data-ai-compact-row]').length === n, tickers.length);

  // The switch: Detailed draws today's cards, and the choice survives a reload.
  await page.locator('[data-ai-view="detailed"]').click();
  await page.waitForSelector('[data-ai-card]');
  assert.equal(await page.locator('[data-ai-compact]').count(), 0);
  assert(await page.locator('[data-ai-card][data-ticker="TAPE"]').count() === 1, 'Detailed still shows what Compact leaves out');
  assert.equal(await page.evaluate(() => localStorage.getItem('sattva:ai-alerts:layout:v1')), 'detailed');
  await page.reload();
  await page.waitForSelector('[data-ai-card]');
  assert.equal(await page.locator('[data-ai-view="detailed"]').getAttribute('aria-pressed'), 'true', 'the reader\'s layout is remembered');
  await page.locator('[data-ai-view="compact"]').click();
  await page.waitForSelector('[data-ai-compact-row]');

  // Keyboard: the row's control takes focus and shows it.
  await page.locator('[data-ai-compact-row] .ai-compact-hit').first().focus();
  assert(await page.evaluate(() => document.activeElement?.matches('.ai-compact-hit:focus-visible') || document.activeElement?.classList.contains('ai-compact-hit')));

  // THE LIST HOLDS STILL WHILE IT UPDATES. A background update may add a company on top, marked
  // NEW; it never moves the rows already there — not even one whose ranking rose without a newer
  // alert — and the reader's own re-sort puts everything back in order and clears the marks.
  await page.locator('[data-ai-sort]').selectOption('priority');
  await page.waitForTimeout(150);
  const keysNow = () => rows(page).evaluateAll(nodes => nodes.map(n => n.dataset.aiKey));
  const settledOrder = await keysNow();
  const lowest = settledOrder.at(-1);
  const yesterday = new Date(Date.now() + 19800000 - 86400000).toISOString().slice(0, 10);
  await page.evaluate(({ lowest, yesterday }) => {
    window.fixtureExtra = [
      ['NEWCO', 'announcements', 'Award of order worth ₹900 crore', { filingSubject: 'Award of order worth ₹900 crore' }],
      // Raises the bottom row's priority with OLDER evidence: a fresh sort would lift it, the list must not.
      [lowest, 'insider', 'Promoter — Sell', { tradeCategory: 'Block deal', direction: 'negative', day: yesterday, time: '09:00' }],
    ];
    window.fixtureChanged();
  }, { lowest, yesterday });
  await page.waitForSelector('[data-ai-compact-row][data-ai-key="NEWCO"]');
  await page.waitForFunction(() => document.querySelector('[data-ai-layout]')?.getAttribute('data-ai-collecting') === 'false');
  const afterArrival = await keysNow();
  const arrivals = afterArrival.filter(key => !settledOrder.includes(key));
  assert(arrivals.includes('NEWCO'), 'the new company is listed');
  assert.deepEqual(afterArrival.slice(0, arrivals.length).sort(), [...arrivals].sort(), 'every arrival stacks on top');
  assert.deepEqual(afterArrival.slice(arrivals.length), settledOrder, 'every row already listed keeps its place, the risen one included');
  assert.equal(await row(page, 'NEWCO').getAttribute('data-ai-new'), '', 'the arrival is marked');
  assert.equal((await row(page, 'NEWCO').locator('.ai-new-chip').textContent()).trim(), 'New');
  assert.match(await page.locator('[data-ai-arrivals]').textContent(), new RegExp(`${arrivals.length} new alerts? added at the top`), 'announced politely for screen readers');
  assert.equal(await page.locator('[data-ai-compact-row][data-ai-new]').count(), arrivals.length, 'only arrivals are marked');
  for (const key of settledOrder) assert.equal(await page.locator(`[data-ai-compact-row][data-ai-key="${key}"][data-ai-new]`).count(), 0, `${key} is not marked new`);
  // The reader's own re-sort puts it in order and clears the mark.
  await page.locator('[data-ai-sort]').selectOption('newest');
  await page.waitForTimeout(150);
  await page.locator('[data-ai-sort]').selectOption('priority');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-ai-compact-row][data-ai-new]').count(), 0, 'a re-sort clears the marks');
  assert.notDeepEqual(await keysNow(), afterArrival, 'and re-sorts the list');
  await page.evaluate(() => { window.fixtureExtra = []; window.fixtureChanged(); });
  await page.waitForFunction(() => !document.querySelector('[data-ai-compact-row][data-ai-key="NEWCO"]'));

  // A READER SCROLLED INTO THE LIST IS NOT INTERRUPTED: an arrival waits behind the "new alerts"
  // pill, and the pill — or scrolling back to the top — lets it in on top.
  await page.setViewportSize({ width: 1440, height: 360 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.mouse.wheel(0, 50);
  const beforeWait = await keysNow();
  await page.evaluate(() => { window.fixtureExtra = [['NEWCO', 'announcements', 'Award of order worth ₹900 crore', { filingSubject: 'Award of order worth ₹900 crore' }]]; window.fixtureChanged(); });
  await page.locator('[data-ai-reveal]').waitFor();
  assert.match(await page.locator('[data-ai-reveal]').innerText(), /1 new alert/);
  assert.equal(await page.locator('[data-ai-compact-row][data-ai-key="NEWCO"]').count(), 0, 'nothing is inserted above a reader who has scrolled');
  assert.deepEqual(await keysNow(), beforeWait, 'and nothing moves');
  await page.locator('[data-ai-reveal]').click();
  await page.waitForSelector('[data-ai-compact-row][data-ai-key="NEWCO"]');
  assert.equal((await keysNow())[0], 'NEWCO', 'the pill lets the arrival in on top');
  assert.equal(await page.locator('[data-ai-reveal]').count(), 0, 'and goes');
  await page.evaluate(() => { window.fixtureExtra = []; window.fixtureChanged(); });
  await page.waitForFunction(() => !document.querySelector('[data-ai-compact-row][data-ai-key="NEWCO"]'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));

  // SEARCH: the company first, one clear control, a keyboard typeahead, mentions one click away.
  const search = page.locator('[data-ai-search]');
  assert(await page.evaluate(() => [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => /ai-alert-search-box input\[type="search"\]::-webkit-search-cancel-button/.test(rule.selectorText || '') && /display: none/.test(rule.cssText)); } catch { return false; } })),
    'the browser\'s own clear button is hidden; the box has one ×');
  await search.click();
  await search.fill('');
  await search.type('broker', { delay: 10 });
  await page.locator('[data-ai-suggest]').waitFor();
  assert.equal(await search.getAttribute('aria-expanded'), 'true');
  assert.match(await page.locator('[data-ai-suggest] .ai-suggest-name').first().innerHTML(), /<mark class="ai-search-mark">BROKER<\/mark>/i, 'the typed part is marked');
  await page.keyboard.press('ArrowDown');
  assert.equal(await search.getAttribute('aria-activedescendant'), 'ai-suggest-0', 'arrows move through the list');
  await page.keyboard.press('Enter');
  assert.equal(await search.inputValue(), 'BROKERCO Limited', 'Enter picks the company');
  assert.equal(await search.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await keysNow(), ['BROKERCO'], 'and the list is that company');
  assert.match(await row(page, 'BROKERCO').locator('.ai-compact-name').innerHTML(), /<mark class="ai-search-mark">BROKERCO<\/mark>/, 'its name is marked in the list');
  // A topic that names no company reads every alert, words together in one line.
  await search.fill('award of order');
  await page.waitForTimeout(150);
  assert((await keysNow()).length >= 1);
  assert.equal((await page.locator('[data-ai-search-note]').textContent()).trim(), 'Alerts that mention “award of order”', 'and says these alerts mention the words, not that they are a company');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await search.inputValue(), '', 'Escape closes the list, then clears the search');
  await page.locator('[data-ai-search]').blur();

  // ARCHIVE ON EVERY ROW: an always-visible ✕ in the row's top-right corner, above the row's link.
  const shown = await rows(page).count();
  assert.equal(await page.locator('[data-ai-compact-row] [data-ai-compact-archive]').count(), shown, 'every row carries an archive control');
  const first = rows(page).first();
  const firstKey = await first.getAttribute('data-ai-key');
  const [rowBox, xBox] = [await first.boundingBox(), await first.locator('[data-ai-compact-archive]').boundingBox()];
  assert(xBox.x + xBox.width > rowBox.x + rowBox.width - 40 && xBox.y < rowBox.y + 24, 'the control sits in the top-right corner');
  assert(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-ai-compact-archive]'), { x: xBox.x + xBox.width / 2, y: xBox.y + xBox.height / 2 }), 'it is above the row\'s link layer');
  assert.match(await first.locator('[data-ai-compact-archive]').getAttribute('aria-label'), /^Archive /);
  await first.locator('[data-ai-compact-archive]').click();
  // It leaves with motion — transform and opacity only — and is then gone, into the archive.
  assert(await page.evaluate((key) => { const node = document.querySelector(`[data-ai-compact-row][data-ai-key="${key}"]`);
    return !node || node.getAnimations().some(a => a.effect.getKeyframes().every(k => Object.keys(k).every(p => ['offset', 'easing', 'composite', 'computedOffset', 'opacity', 'transform'].includes(p)))); }, firstKey), 'the row animates out on transform and opacity');
  await page.waitForFunction((key) => !document.querySelector(`[data-ai-compact-row][data-ai-key="${key}"]`), firstKey, { timeout: 2000 });
  assert.equal(await rows(page).count(), shown - 1);
  assert.match(await page.locator('[data-ai-filter="archived"]').textContent(), /· 1$/, 'the archive counts it');
  await page.locator('[data-ai-filter="archived"]').click();
  await page.waitForSelector(`[data-ai-compact-row][data-ai-key="${firstKey}"] [data-ai-compact-restore]`);
  await page.locator(`[data-ai-compact-row][data-ai-key="${firstKey}"] [data-ai-compact-restore]`).click();
  await page.waitForFunction(() => /· 0$/.test(document.querySelector('[data-ai-filter="archived"]').textContent));
  await page.locator('[data-ai-filter="all"]').click();
  await page.waitForSelector(`[data-ai-compact-row][data-ai-key="${firstKey}"]`);
  assert.equal(await rows(page).count(), shown, 'restored from the archive with the same control');
  // From the keyboard it archives at once, with no motion, and focus moves on to the next row's ✕.
  const [kbKey, nextKey] = await rows(page).evaluateAll(nodes => nodes.slice(0, 2).map(n => n.dataset.aiKey));
  await page.locator(`[data-ai-compact-row][data-ai-key="${kbKey}"] [data-ai-compact-archive]`).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(`[data-ai-compact-row][data-ai-key="${kbKey}"]`).count(), 0, 'a keyboard archive is immediate');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-ai-compact-row]')?.dataset.aiKey), nextKey, 'focus moves to the next row');
  await page.evaluate(() => localStorage.removeItem('sattva:ai-muted:v1'));
  await context.close();

  // Phone width and the dark theme.
  const phone = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await phone.page.goto(origin);
  await phone.page.waitForSelector('[data-ai-compact-row]');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 1, `no sideways page scroll at 390px (${overflow}px)`);
  assert.equal(await phone.page.locator('.ai-compact-head').isVisible(), false, 'the column header gives way on a phone');
  // Dark theme: the row's own text is light on the dark surface, not the light theme's ink.
  const luminance = await phone.page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    return { name: lum(getComputedStyle(document.querySelector('.ai-compact-name')).color), cmp: lum(getComputedStyle(document.querySelector('.ai-compact-cmp-value')).color),
      surface: lum(getComputedStyle(document.querySelector('.ai-compact')).backgroundColor) };
  });
  assert(luminance.name - luminance.surface > 0.4 && luminance.cmp - luminance.surface > 0.4, `readable in the dark theme (${JSON.stringify(luminance)})`);
  await phone.context.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS AI Alerts Compact UI: default layout and remembered switch, ${tickers.length} rows, results opened at the filing, broker reports listed on demand, updates that never move a listed row and stack arrivals on top (or wait behind a pill for a scrolled reader), a company-first keyboard search, archive and restore on every row, nothing left out leaks, phone width and dark theme`);
} finally {
  await browser.close();
  server.close();
}
