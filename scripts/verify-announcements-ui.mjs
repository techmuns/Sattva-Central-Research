#!/usr/bin/env node
// CORPORATE ANNOUNCEMENTS, NEWS AND ALL ALERTS IN THE BROWSER — ranking, categories, market cap,
// related filings, AI Read and the shared Important / Not important learning, end to end.
//
// The stand-in Worker (scripts/lib/announcement-test-server.mjs) runs the REAL route handlers and
// store classes over an index the runner's own code builds from the committed BSE and NSE captures,
// so every row on screen is a real filing. Only the AI Read's document fetch and model call are
// stubbed — nothing leaves this machine. A second server with no index proves the browser still
// answers from the captures when the index cannot be read.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
const { startAnnouncementServer } = await import('./lib/announcement-test-server.mjs');
const { buildFixtureIndex } = await import('./lib/announcement-index-fixture.mjs');
const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);

let checks = 0;
const ok = (label) => { checks++; console.log(`  PASS  ${label}`); };

const tmp = mkdtempSync(join(tmpdir(), 'announcement-ui-'));
const { index } = buildFixtureIndex(tmp, { root: publicDir });
const day = index.range.to;
const clock = new Date(`${day}T18:00:00+05:30`);

// The AI Read's two outbound calls, stubbed: an exchange document, and the model's JSON answer.
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
const counts = { documents: 0, model: 0 };
const READING = { readable: true, issuerMatches: true, documentType: 'Exchange filing', whatHappened: 'The company filed the update described in the subject, read in full from the exchange document.',
  keyDetails: [{ label: 'Filing', value: 'As stated in the document', quote: 'trailer', location: 'page 1' }],
  whyItMatters: 'It matters to an investor because it changes what is known about the company this period.',
  impact: { direction: 'unclear', horizon: 'unclear', text: 'Could matter if it changes earnings or plans; the document alone does not say.' } };
const readFetcher = async (url, init = {}) => {
  const href = String(url);
  if (/^https:\/\/(?:www\.)?bseindia\.com\/|^https:\/\/(?:nsearchives|archives)\.nseindia\.com\//.test(href)) { counts.documents++; return new Response(pdf, { headers: { 'content-type': 'application/pdf' } }); }
  if (href.startsWith('https://bedrock-runtime.')) { counts.model++; void init; return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(READING) }] }); }
  return new Response('unexpected', { status: 500 });
};
const now = () => clock.getTime();
const srv = await startAnnouncementServer({ indexDir: tmp, publicDir, readFetcher, now });
const fallback = await startAnnouncementServer({ indexDir: null, publicDir, readFetcher: async () => new Response('down', { status: 503 }), now });

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Nothing leaves the machine: CDNs and publishers answer empty, new windows are noted and closed.
  await context.route('**/*', (route) => (route.request().url().startsWith('http://127.0.0.1') ? route.continue() : route.fulfill({ status: 200, body: '' })));
  const opened = [];
  context.on('page', (p) => { opened.push(p.url()); });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.clock.install({ time: clock });
  const ready = () => page.waitForFunction(() => document.querySelector('[data-filings-info]')?.dataset.caState === 'ready' && document.querySelectorAll('tbody tr[data-row-key]').length > 0, null, { timeout: 60000 });
  // waitForFunction predicates must be synchronous, so the query is held on window once it exists.
  const hold = (p = page) => p.evaluate(async () => { window.__ca = (await import('/js/tabs/corp-announcements.js')).announcementQuery; });
  const caMeta = () => page.evaluate(() => window.__ca.meta());
  const caRows = () => page.evaluate(() => window.__ca.rows());
  const settle = () => page.waitForFunction(() => window.__ca.meta().state === 'ready' && !window.__ca.meta().refreshing);

  // ---- Corporate Announcements, served by the index -------------------------------------------
  await page.goto(`${srv.url}#/research/corp-announcements?scope=universe`);
  await ready();
  await hold();
  assert.equal(await page.locator('[data-filings-info]').getAttribute('data-ca-mode'), 'server', 'the index answers');
  const heads = await page.locator('thead th').allInnerTexts();
  for (const head of ['SUBJECT', 'DATE', 'CATEGORIES', 'MARKET CAP', 'SOURCE']) assert(heads.map((h) => h.trim().toUpperCase()).includes(head), `column ${head}`);
  const meta = await caMeta();
  assert.equal(meta.total, index.counts.rows, 'All time counts every filing');
  assert.equal(srv.stats.queries, 1, 'one page request, not the history');
  const rows = await caRows();
  const firstSubject = await page.locator('tbody tr[data-row-key]').first().locator('div.truncate.font-semibold').getAttribute('title');
  assert.equal(firstSubject, rows[0].title.replace(/\s+/g, ' ').trim(), 'the subject is the exchange’s own words');
  assert.doesNotMatch(await page.locator('tbody').innerText(), /\b(?:High|Medium|Low) (?:priority|relevance|importance)\b/i, 'no rank label is printed');
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].date) continue;
    assert(rows[i - 1].date >= rows[i].date, 'newest day first');
    if (rows[i - 1].date === rows[i].date) assert(rows[i - 1].relevance >= rows[i].relevance - 0.011, 'most relevant first within the day');
  }
  assert(await page.locator('tbody .category-chip').count() > 0, 'category tags are visible');
  assert(await page.locator('tbody td.text-right').filter({ hasText: /₹/ }).count() > 0, 'market caps are visible');
  ok(`server mode: ${meta.total} real filings, one page request, exchange subjects, categories, market cap, ranked within day, no labels`);

  // Category filter (multi-select).
  await page.locator('[data-ca-open="categories"]').click();
  const popover = page.locator('.ca-popover');
  await popover.waitFor();
  const resultsCount = Number((await popover.locator('label', { hasText: 'Results' }).first().locator('small').innerText()).replace(/,/g, ''));
  await popover.locator('input[value="results"]').check();
  await popover.locator('input[value="order-win"]').check();
  await popover.locator('[data-ca-apply]').click();
  await page.waitForFunction(() => window.__ca.query().categories.length === 2 && window.__ca.meta().state === 'ready');
  const filtered = await caRows();
  assert(filtered.length && filtered.every((r) => r.categories.includes('results') || r.categories.includes('order-win')), 'every row carries a ticked category');
  assert((await caMeta()).total >= resultsCount, 'any-of: at least the Results count');
  assert.match(await page.locator('[data-ca-open="categories"]').innerText(), /2 selected/);
  await page.locator('[data-ca-open="categories"]').click();
  await page.locator('.ca-popover [data-ca-clear]').click();
  await settle();
  ok('category multi-select filters, counts and clears');

  // Market cap: a band, a custom range, and "not available".
  const pickMcap = async (fn) => {
    await page.locator('[data-ca-open="mcap"]').click();
    await page.locator('.ca-popover').waitFor();
    await fn(page.locator('.ca-popover'));
    await page.locator('.ca-popover [data-ca-apply]').click();
    await settle();
  };
  await pickMcap((p) => p.locator('input[value="large"]').check());
  let band = await caRows();
  assert(band.length && band.every((r) => r.band === 'large'), 'a band keeps only that band');
  await pickMcap(async (p) => { await p.locator('[data-ca-min]').fill('5000'); await p.locator('[data-ca-max]').fill('20000'); });
  band = await caRows();
  assert(band.length && band.every((r) => r.mcapCr >= 5000 && r.mcapCr <= 20000), 'a custom ₹ crore range');
  await pickMcap((p) => p.locator('input[value="unknown"]').check());
  band = await caRows();
  assert(band.every((r) => r.mcapCr === null), '"Not available" keeps companies with no market cap');
  assert(await page.locator('tbody tr[data-row-key]').first().innerText().then((t) => /—/.test(t)), 'an unknown market cap is a dash, never zero');
  await page.locator('[data-ca-open="mcap"]').click();
  await page.locator('.ca-popover [data-ca-clear]').click();
  await settle();
  ok('market cap: band, custom range and "Not available"');

  // Related filings expand inline.
  const related = page.locator('[data-ca-related]').first();
  await related.waitFor();
  const expected = Number((await related.locator('summary').innerText()).match(/\d+/)[0]);
  await related.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('[data-ca-related][open] [data-ca-related-list] li'));
  assert.equal(await related.locator('[data-ca-related-list] li').count(), expected, 'the expanded list holds every related filing');
  assert.equal(await page.locator('#modal-content [data-ann-read]').count(), 0, 'expanding does not open the popup');
  ok(`"${expected} related filing(s)" expands inline`);

  // AI Read: one click, one read, the same five sections, the original filing one click away.
  // An exchange PDF: the stand-in answers with a PDF, and which filing leads the page moves with the
  // data (an NSE XBRL file there is read as XBRL and correctly refused as unreadable).
  const target = (await caRows()).find((r) => /bseindia|nseindia/.test(r.url || '') && /\.pdf(?:$|[?#])/i.test(r.url || ''));
  assert(target, 'the newest page holds an exchange PDF filing to read');
  const targetRow = page.locator(`tbody tr[data-row-key="${target.id}"]`);
  await targetRow.locator('td').nth(1).click();
  const popup = page.locator('#modal-content [data-ann-read]');
  await popup.waitFor();
  assert.deepEqual(await popup.locator('.ann-read-section h3').allInnerTexts().then((t) => t.map((s) => s.trim().toLowerCase())),
    ['what happened', 'key details', 'why it matters / investment impact', 'related event history', 'source']);
  assert.equal(await popup.locator('.ann-read-original').getAttribute('href'), target.url, 'Open Original Filing links the exchange document');
  assert.equal(await popup.locator('.ann-read-subject').innerText(), target.title.replace(/\s+/g, ' ').trim());
  await popup.locator('[data-slot="what"]').filter({ hasText: 'read in full' }).waitFor();
  assert.match(await popup.locator('[data-slot="why"]').innerText(), /Investment impact/);
  assert.equal(counts.model, 1, 'one model read');
  await page.locator('#modal-content [data-modal-close]').first().click();
  await targetRow.locator('td').nth(1).click();
  await popup.locator('[data-slot="what"]').filter({ hasText: 'read in full' }).waitFor();
  assert.equal(counts.model, 1, 'reopening costs nothing');
  ok('AI Read on click: five fixed sections, the exchange subject, Open Original Filing, read once and kept');

  // Important / Not important inside the popup trains the shared model and re-orders the list.
  const beforeRows = await caRows();
  const sameDay = beforeRows.filter((r) => r.date === target.date);
  const beforeAt = sameDay.findIndex((r) => r.id === target.id);
  await popup.locator('[data-vote="not-important"]').click();
  await page.waitForFunction(() => document.querySelector('#modal-content [data-vote="not-important"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(srv.stats.votes, 1);
  assert.equal(srv.feedback.model().votes, 1);
  await popup.locator('[data-why]').click();
  await popup.locator('[data-why-text]').fill('routine for a company this size');
  await popup.locator('[data-why-save="not-important"]').click();
  await page.waitForFunction(() => /shared ranking learns/.test(document.querySelector('#modal-content [data-feedback-status]')?.textContent || ''));
  assert(srv.feedback.model().recent.some((v) => v.why === 'routine for a company this size'), 'the why travels with the vote');
  await page.locator('#modal-content [data-modal-close]').first().click();
  await page.waitForFunction(([id, at]) => {
    const q = window.__ca;
    const rows = q.rows(); const day = rows.find((r) => r.id === id)?.date;
    return q.meta().state === 'ready' && rows.filter((r) => r.date === day).findIndex((r) => r.id === id) > at;
  }, [target.id, beforeAt], { timeout: 30000 });
  assert((await caRows()).some((r) => r.id === target.id), 'the filing is still listed');
  ok('Important / Not important + Why? in the popup re-orders the day and hides nothing');

  // ---- News: the row still opens the article; the ⋯ is a separate control ---------------------
  await page.goto(`${srv.url}#/research/news?scope=universe`);
  await page.waitForSelector('[data-news-key] [data-feedback-menu]', { timeout: 60000 });
  // The order within a day can still be settling (readings past the first budget are made in
  // slices); act on the list once it has, as a reader would after the first second.
  await page.evaluate(async () => {
    const { relevanceSettled } = await import('/js/data/surface-relevance.js');
    await relevanceSettled();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const card = page.locator('[data-news-key]').filter({ has: page.locator('a[href^="http"]') }).first();
  const articleHref = await card.locator('a[href^="http"]').first().getAttribute('href');
  assert(/^https?:/.test(articleHref), 'the card is still a link to the article');
  const pagesBefore = opened.length;
  await card.locator('[data-feedback-menu]').click();
  const menu = page.locator('.relevance-menu');
  await menu.waitFor();
  assert.equal(opened.length, pagesBefore, 'the ⋯ does not open the article');
  await menu.locator('[data-vote="important"]').click();
  await page.waitForFunction(() => document.querySelector('.relevance-menu [data-vote="important"]')?.getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => /shared ranking learns|Saved on this device/.test(document.querySelector('.relevance-menu [data-feedback-status]')?.textContent || ''));
  assert(srv.feedback.model().recent.some((v) => v.surface === 'news' && v.vote === 'important'), 'the News vote reached the shared store');
  await page.keyboard.press('Escape');
  assert(await page.locator('[data-news-key] .category-chip').count() > 0, 'news carries category tags');
  ok('News: ⋯ menu votes without opening the article; tags under the headline');

  // ---- All Alerts: after opening an item, it asks --------------------------------------------
  await page.goto(`${srv.url}#/research/daily-alerts?scope=universe`);
  await page.waitForSelector('tbody tr[data-row-key]', { timeout: 90000 });
  await page.locator('tbody tr[data-row-key]').first().locator('td').first().click();
  const prompt = page.locator('.relevance-prompt');
  await prompt.waitFor();
  await prompt.locator('[data-vote="important"]').click();
  await page.waitForFunction(() => document.querySelector('.relevance-prompt [data-vote="important"]')?.getAttribute('aria-pressed') === 'true');
  await page.waitForFunction(() => /shared ranking learns/.test(document.querySelector('.relevance-prompt [data-feedback-status]')?.textContent || ''));
  assert(srv.feedback.model().recent.some((v) => v.surface === 'alerts' && v.vote === 'important'), 'the All Alerts vote reached the shared store');
  assert(await page.locator('tbody .category-chip').count() > 0, 'All Alerts carries category tags');
  ok('All Alerts: opening an item brings the Important / Not important prompt; tags in the feed column');

  // One shared preference across the three surfaces.
  const model = await page.evaluate(async () => (await fetch('/api/relevance/model')).json());
  assert.equal(model.model.votes, 3);
  for (const surface of ['announcements', 'news', 'alerts']) assert(Object.keys(model.model.surfaces[surface]).length, `${surface} learned`);
  assert(Object.keys(model.model.weights).length, 'and every vote trained the shared weights');
  ok('one shared model: votes from all three surfaces');

  // Phone width and dark appearance.
  await page.goto(`${srv.url}#/research/corp-announcements?scope=universe`);
  await ready();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: no sideways page scroll at 390px`);
    await page.locator('tbody tr[data-row-key]').first().locator('td').nth(1).click();
    await popup.waitFor();
    const box = await popup.boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 390 + 1, `${theme}: the popup fits the phone`);
    if (theme === 'dark') {
      const bg = await page.evaluate(() => getComputedStyle(document.getElementById('modal-container')).backgroundColor);
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      assert(r + g + b < 240, `dark popup surface (${bg})`);
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  ok('phone width and dark appearance');

  // ---- No index: the browser answers from the captures, and says so ---------------------------
  const local = await context.newPage();
  local.on('pageerror', (e) => errors.push(String(e)));
  await local.clock.install({ time: clock });
  await local.goto(`${fallback.url}#/research/corp-announcements?scope=universe`);
  await local.waitForFunction(() => document.querySelector('[data-filings-info]')?.dataset.caMode === 'local' && document.querySelectorAll('tbody tr[data-row-key]').length > 0, null, { timeout: 180000 });
  assert(await local.locator('tbody .category-chip').count() > 0, 'categories still show');
  await local.locator('tbody tr[data-row-key]').first().locator('td').nth(1).click();
  await local.locator('#modal-content [data-ann-read]').waitFor();
  await local.locator('.ann-read-unavailable').waitFor();
  assert.match(await local.locator('.ann-read-unavailable').innerText(), /AI reading unavailable/);
  assert.equal(await local.locator('#modal-content .ann-read-section').count(), 5, 'the same five sections, even without a reading');
  ok('without the index the tab prepares the list in the browser; the popup keeps its shape and says why the AI part is missing');

  assert.deepEqual(errors, [], 'no page errors');
  ok('no page errors');
} finally {
  await browser.close();
  await srv.close();
  await fallback.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks} groups of browser checks passed.`);
