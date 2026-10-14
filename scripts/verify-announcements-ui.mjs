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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
const { startAnnouncementServer } = await import('./lib/announcement-test-server.mjs');
const { buildFixtureIndex, feedbackPair } = await import('./lib/announcement-index-fixture.mjs');
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
let readGate = null, releaseRead;
const readFetcher = async (url, init = {}) => {
  const href = String(url);
  if (/^https:\/\/(?:www\.)?bseindia\.com\/|^https:\/\/(?:nsearchives|archives)\.nseindia\.com\//.test(href)) { counts.documents++; return new Response(pdf, { headers: { 'content-type': 'application/pdf' } }); }
  if (href.startsWith('https://bedrock-runtime.')) {
    counts.model++;
    if (readGate) {
      const gate = readGate, encoder = new TextEncoder(), text = JSON.stringify(READING), cut = text.indexOf('"keyDetails"');
      assert.equal(JSON.parse(init.body).stream, true);
      return new Response(new ReadableStream({ async start(c) {
        const send = value => c.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        send({ type: 'message_start' });
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, cut) } });
        await gate;
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(cut) } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
        send({ type: 'message_stop' }); c.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(READING) }] });
  }
  return new Response('unexpected', { status: 500 });
};
const now = () => clock.getTime();
const srv = await startAnnouncementServer({ indexDir: tmp, publicDir, readFetcher, now });
let fallbackCaps = null, capReads = 0;
const fallback = await startAnnouncementServer({ indexDir: null, publicDir, readFetcher: async () => new Response('down', { status: 503 }), now,
  transformAsset(path, bytes) { if (path === '/data/market-caps.json' && fallbackCaps) { capReads++; return Buffer.from(JSON.stringify(fallbackCaps())); } return bytes; } });

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
  const ready = () => page.waitForFunction(() => window.__ca?.meta().state === 'ready' && document.querySelectorAll('tbody tr[data-row-key]').length > 0, null, { timeout: 60000 });
  // waitForFunction predicates must be synchronous, so the query is held on window once it exists.
  const hold = (p = page) => p.evaluate(async () => { window.__ca = (await import('/js/tabs/corp-announcements.js')).announcementQuery; });
  const caMeta = () => page.evaluate(() => window.__ca.meta());
  const caRows = () => page.evaluate(() => window.__ca.rows());
  const settle = () => page.waitForFunction(() => window.__ca.meta().state === 'ready' && !window.__ca.meta().refreshing);

  // ---- Corporate Announcements, served by the index -------------------------------------------
  await page.goto(`${srv.url}#/research/corp-announcements?scope=universe`);
  await hold();
  await ready();
  assert.equal((await caMeta()).mode, 'server', 'the index answers');
  assert.equal(await page.locator('[data-section-head] [data-filings-info]').count(), 0, 'no collection-status banner');
  const period = page.getByRole('combobox', { name: 'Announcement period (IST)' });
  assert.equal(await period.inputValue(), '3', 'Last 3 days is selected on opening');
  assert.equal(await page.evaluate(() => window.__ca.query().period), '3', 'the initial query uses Last 3 days');
  assert.equal(srv.stats.queries, 1, 'one initial page request');
  ok('Last 3 days is the default dropdown and server query');
  assert.equal(await page.locator('[data-app-content] > footer, #content-host [data-filings-method]').count(), 0,
    'collection and registry links leave the reading column');
  await period.focus();
  await page.locator('[data-beacon-toggle]').hover();
  await page.clock.runFor(400);
  const sources = page.locator('#source-beacon-panel');
  await sources.waitFor();
  assert(await period.evaluate(el => document.activeElement === el), 'hover does not take focus from the reader');
  const method = sources.locator('.beacon-panel-foot [data-filings-method]');
  assert((await method.innerText()).startsWith('Collection details · '));
  assert(await sources.locator('.beacon-panel-foot [data-sources-open]').isVisible());
  await method.click();
  const collection = await page.locator('#modal-content').innerText();
  assert(collection.includes('Collection status:') && collection.includes('How this list is served:') && /companies appear on this feed/.test(collection),
    'the relocated link retains live collection, serving and measured coverage details');
  assert.equal(await page.locator('[data-filings-provenance]').getAttribute('data-scope'), 'universe', 'collection details use the active scope');
  assert.equal(await sources.count(), 0, 'the source panel closes before its details dialog opens');
  await page.keyboard.press('Escape');
  assert(await page.locator('[data-beacon-toggle]').evaluate(el => el === document.activeElement), 'closing details restores the source launcher');
  await page.locator('[data-beacon-toggle]').click();
  await page.locator('#source-beacon-panel [data-sources-open]').click();
  assert((await page.locator('#modal-content').innerText()).includes('Google News search'), 'the canonical registry remains reachable from the panel footer');
  await page.keyboard.press('Escape');
  assert.equal(srv.stats.queries, 1, 'source presentation starts no announcement query');
  ok('table footer links move into the hover panel; measured details, registry and keyboard return remain available');
  await period.focus();
  await period.selectOption('all');
  await page.waitForFunction(() => window.__ca.query().period === 'all' && window.__ca.meta().state === 'ready');
  assert(await period.evaluate(el => el === document.activeElement), 'arriving query rows preserve the focused period control');
  const heads = await page.locator('thead th').allInnerTexts();
  assert.deepEqual(heads.map(h => h.trim().toUpperCase()), ['COMPANY', 'SUBJECT', 'DATE', 'CATEGORIES', 'MARKET CAP', 'LINK'], 'company leads and exchange links replace the separate Source column');
  const meta = await caMeta();
  assert.equal(meta.total, index.counts.rows, 'All time counts every filing');
  assert.equal(srv.stats.queries, 2, 'one page request per selected period, not the history');
  const rows = await caRows();
  const firstSubject = await page.locator('tbody tr[data-row-key]').first().locator('[data-record-name]').getAttribute('title');
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

  const subjects = await page.locator('tbody tr[data-row-key]').evaluateAll(items => items.map(row => {
    const subject = row.querySelector('[data-record-name]'), bookmark = row.querySelector('.record-identity-actions [data-bookmark-key]');
    const text = subject.getBoundingClientRect(), action = bookmark.getBoundingClientRect();
    return { title: subject.textContent, height: text.height, line: parseFloat(getComputedStyle(subject).lineHeight),
      wraps: getComputedStyle(subject).whiteSpace === 'normal', actionRight: action.left >= text.right - 1,
      aligned: Math.abs(action.top + action.height / 2 - text.top - parseFloat(getComputedStyle(subject).lineHeight) / 2) < 7,
      misplacedWatch: !!row.querySelector('.record-subject-column [data-watch]'),
      companyWatch: !row.querySelector('[data-watch]') || !!row.querySelector('.record-company-column [data-watch]') };
  }));
  assert(subjects.every(item => item.wraps && item.actionRight && item.aligned && !item.misplacedWatch && item.companyWatch), 'actions stay beside their own content, aligned with the first title line');
  assert(subjects.some(item => item.height > item.line * 1.5), 'a real long exchange subject wraps completely');
  const firstRow = page.locator('tbody tr[data-row-key]').first();
  const readCount = srv.stats.reads;
  await firstRow.locator('.record-identity-actions [data-bookmark-key]').focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('tbody tr[data-row-key] [data-bookmark-key]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(srv.stats.reads, readCount, 'bookmarking does not open the announcement reader');
  await firstRow.locator('[data-bookmark-key]').click();
  await page.waitForFunction(() => document.querySelector('tbody tr[data-row-key] [data-bookmark-key]')?.getAttribute('aria-pressed') === 'false');
  await page.locator('[data-notebook-toast] [aria-label="Dismiss"]').click();
  await page.locator('.record-company-column [data-watch]').first().click();
  await page.locator('[data-watch-attribution]').waitFor();
  assert.equal(srv.stats.reads, readCount, 'the company watch control keeps its own interaction');
  await page.keyboard.press('Escape');
  ok('complete wrapped subjects, fixed first-line bookmarks, company watch controls, keyboard saving and independent actions');

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
  const target = feedbackPair(await caRows(), { pdf: true })?.row;
  assert(target, 'the page holds an exchange PDF with a comparable same-day peer for the read and feedback checks');
  const targetRow = page.locator(`tbody tr[data-row-key="${target.id}"]`);
  await targetRow.locator('[data-row-open]').focus(); await page.keyboard.press('Enter');
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
  await targetRow.locator('.ca-company-cell').click();
  await popup.locator('[data-slot="what"]').filter({ hasText: 'read in full' }).waitFor();
  assert.equal(counts.model, 1, 'reopening costs nothing');
  ok('AI Read by keyboard and click: five fixed sections, the exchange subject, Open Original Filing, read once and kept');

  // Important / Not important inside the popup trains the shared model and re-orders the list.
  const beforeRows = await caRows();
  const beforeTotal = (await caMeta()).total;
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
  await page.waitForFunction(([id, score]) => {
    const q = window.__ca;
    const row = q.rows().find(r => r.id === id);
    return q.meta().state === 'ready' && !q.meta().refreshing && (!row || row.relevance < score);
  }, [target.id, target.relevance], { timeout: 30000 });
  // A bounded first page is not the whole ranked day. A valid vote can move the
  // filing beyond it; follow the real pagination before asserting retention/order.
  while (!(await caRows()).some(row => row.id === target.id) && (await caMeta()).nextOffset !== null) {
    await page.evaluate(() => window.__ca.loadMore());
    await settle();
  }
  const afterRows = await caRows();
  assert(afterRows.some(row => row.id === target.id), 'the filing is still listed');
  assert(afterRows.find(row => row.id === target.id).relevance < target.relevance, 'the saved negative vote lowers its score');
  assert(afterRows.filter(row => row.date === target.date).findIndex(row => row.id === target.id) > beforeAt, 'the vote reorders the actual day');
  assert.equal((await caMeta()).total, beforeTotal, 'a vote never removes captured filings');
  ok('Important / Not important + Why? in the popup re-orders the day and hides nothing');

  // ---- News: visible controls below the story, separate from the article link ----------------
  await page.goto(`${srv.url}#/research/news?scope=universe`);
  await page.locator('[data-active-tab="news"]').waitFor();
  await page.evaluate(async () => (await import('/js/ui/source-beacon.js')).openBeacon());
  assert(await page.locator('#source-beacon-panel [data-filings-method]').isHidden(), 'leaving Announcements clears its collection action');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-news-key] [data-news-feedback]', { timeout: 60000 });
  await page.evaluate(async () => {
    const { relevanceSettled } = await import('/js/data/surface-relevance.js');
    await relevanceSettled();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const firstCard = page.locator('[data-news-key]').filter({ has: page.locator('a[href^="http"]') }).first();
  const articleHref = await firstCard.locator('a[href^="http"]').first().getAttribute('href');
  assert(/^https?:/.test(articleHref), 'the card is still a link to the article');
  const feedbackKey = await firstCard.locator('[data-news-feedback]').getAttribute('data-news-feedback');
  const control = page.locator(`[data-news-feedback=${JSON.stringify(feedbackKey)}]`);
  assert.equal(await page.locator('[data-feedback-menu]').count(), 0, 'no hidden News importance menu');
  const placement = await firstCard.evaluate(card => ({
    storyBottom: card.querySelector('a').getBoundingClientRect().bottom,
    feedbackTop: card.querySelector('[data-news-feedback]').getBoundingClientRect().top,
    insideLink: !!card.querySelector('a [data-news-feedback]'),
  }));
  assert(!placement.insideLink && placement.feedbackTop >= placement.storyBottom, 'importance controls are directly below and outside the story link');
  const pagesBefore = opened.length;
  await control.locator('[data-why]').click();
  await control.locator('[data-why-text]').fill('material update for the company');
  // Relevance settling/source updates can replace the card while someone is explaining their vote.
  await page.evaluate(async () => {
    await (await import('/js/data/market-news.js')).refresh();
  });
  assert.equal(await control.locator('[data-why-text]').inputValue(), 'material update for the company', 'an optional draft survives repainting');
  const waitVote = (value) => page.waitForFunction(([key, vote]) => {
    const host = document.querySelector(`[data-news-feedback="${CSS.escape(key)}"]`);
    return host?.querySelector(`[data-vote="${vote}"]`)?.getAttribute('aria-pressed') === 'true'
      && /shared ranking learns/.test(host.querySelector('[data-feedback-status]')?.textContent || '');
  }, [feedbackKey, value]);
  await control.locator('[data-vote="important"]').click(); await waitVote('important');
  assert.equal(await control.locator('[data-why-text]').inputValue(), 'material update for the company', 'rating keeps an unsaved optional draft');
  await control.locator('[data-vote="important"]').click();
  await page.waitForFunction(key => /Vote withdrawn/.test(document.querySelector(`[data-news-feedback="${CSS.escape(key)}"] [data-feedback-status]`)?.textContent || ''), feedbackKey);
  assert.equal(await control.locator('[data-vote="important"]').getAttribute('aria-pressed'), 'false', 'clicking the chosen answer withdraws it');
  await control.locator('[data-vote="not-important"]').click(); await waitVote('not-important');
  assert(srv.feedback.model().recent.some(v => v.surface === 'news' && v.vote === 'not-important'), 'the visible negative vote reaches the shared store');
  await control.locator('[data-why-save="important"]').click();
  await page.waitForFunction(key => document.querySelector(`[data-news-feedback="${CSS.escape(key)}"] [data-vote="important"]`)?.getAttribute('aria-pressed') === 'true', feedbackKey);
  await page.waitForFunction(key => /shared ranking learns|Saved on this device/.test(document.querySelector(`[data-news-feedback="${CSS.escape(key)}"] [data-feedback-status]`)?.textContent || ''), feedbackKey);
  assert(srv.feedback.model().recent.some(v => v.surface === 'news' && v.vote === 'important' && v.why === 'material update for the company'), 'the inline News vote and optional reason reached the shared store');
  assert.equal(opened.length, pagesBefore, 'feedback does not open the article');
  assert(await page.locator('[data-news-key] .category-chip').count() > 0, 'news carries category tags');
  const article = control.locator('xpath=ancestor::article').locator('a[href]').first();
  const [articlePage] = await Promise.all([context.waitForEvent('page'), article.click()]);
  await articlePage.waitForLoadState('domcontentloaded');
  assert.equal(articlePage.url(), articleHref, 'the story still opens its original publisher URL');
  await articlePage.close();
  ok('News: visible Important / Not important / Why? below the article, retained drafts and saved feedback after repaint');

  // ---- All Alerts: after opening an item, it asks --------------------------------------------
  await page.goto(`${srv.url}#/research/daily-alerts?scope=universe`);
  await page.waitForSelector('tbody tr[data-row-key]', { timeout: 90000 });
  // The first partial can be replaced while the initial view is still covered. Vote only once
  // the workspace permits interaction, as the reader does after the source handoff.
  await page.waitForFunction(() => document.querySelector('[data-alerts-workspace]')?.getAttribute('aria-busy') === 'false', null, { timeout: 90000 });
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

  // Real popup: neither a held event-history request nor the model's held tail blocks useful text.
  const requestsBefore = srv.stats.reads, modelsBefore = counts.model;
  readGate = new Promise(done => { releaseRead = done; });
  await page.evaluate(async () => {
    const { openAnnouncementRead } = await import('/js/ui/announcement-read.js');
    window.latencyRow = { id: 'a:latency-ui', title: 'Latency fixture', company: 'Fixture Co', sources: ['BSE'],
      url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/latency-ui.pdf', event: { id: 'event-latency-ui', size: 2 } };
    window.historyReleases = [];
    window.openLatencyRead = () => openAnnouncementRead(window.latencyRow, {
      loadEvent: () => new Promise(done => window.historyReleases.push(done)),
      item: { surface: 'announcements', itemKey: window.latencyRow.id, features: [] },
    });
    window.openLatencyRead();
  });
  await popup.locator('[data-slot="what"]').filter({ hasText: 'read in full' }).waitFor();
  assert.match(await popup.locator('[data-read-status]').innerText(), /in progress/);
  assert.equal(await popup.locator('[data-slot="why"] .ann-read-loading').count(), 1, 'analysis waits for validation');
  assert.equal(await popup.locator('[data-slot="history"] .ann-read-loading').count(), 1, 'held history did not delay the read');
  assert.equal(srv.stats.reads, requestsBefore + 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.openLatencyRead());
  await popup.locator('[data-slot="what"]').filter({ hasText: 'read in full' }).waitFor();
  assert.equal(srv.stats.reads, requestsBefore + 1, 'close/reopen shares the pending browser request');
  await page.evaluate(() => {
    for (const done of window.historyReleases) done({ members: [window.latencyRow, { id: 'related-latency', title: 'Prior approval', sources: ['BSE'] }] });
  });
  await popup.locator('[data-slot="history"]').filter({ hasText: 'Prior approval' }).waitFor();
  readGate = null;
  await page.evaluate(async () => {
    const { openAnnouncementRead } = await import('/js/ui/announcement-read.js');
    openAnnouncementRead({ id: 'a:replacement', title: 'Replacement filing', url: 'https://evil.example/no.pdf' },
      { item: { surface: 'announcements', itemKey: 'a:replacement', features: [] } });
  });
  await popup.locator('.ann-read-unavailable').waitFor();
  releaseRead();
  await page.evaluate(async () => {
    const { requestAnnouncementRead } = await import('/js/data/announcement-read-client.js');
    await requestAnnouncementRead(window.latencyRow);
  });
  assert.equal(await popup.locator('.ann-read-subject').innerText(), 'Replacement filing');
  assert.equal(await popup.locator('.ann-read-unavailable').count(), 1, 'a late answer cannot overwrite another filing');
  await page.evaluate(() => window.openLatencyRead());
  await popup.locator('[data-slot="why"]').filter({ hasText: 'Investment impact' }).waitFor();
  assert.equal(counts.model, modelsBefore + 1, 'the completed shared read is reused');
  assert.equal(srv.stats.reads, requestsBefore + 2, 'only the original and the replacement requested the server');
  await page.keyboard.press('Escape');
  ok('streamed facts precede held history/model completion; pending and saved reopen share one request; late answers stay in their own popup');

  // Phone width and dark appearance.
  await page.goto(`${srv.url}#/research/corp-announcements?scope=universe`);
  await ready();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: no sideways page scroll at 390px`);
    const controls = await page.locator('tbody tr[data-row-key]').first().evaluate(row => ({
      subjectWatch: row.querySelector('.record-subject-column [data-watch]') !== null,
      bookmark: row.querySelector('.record-identity-actions [data-bookmark-key]').getBoundingClientRect().width,
      wrap: getComputedStyle(row.querySelector('[data-record-name]')).whiteSpace,
    }));
    assert(!controls.subjectWatch && controls.bookmark >= 28 && controls.wrap === 'normal', `${theme}: mobile keeps separate reachable actions and complete title wrapping`);
    await page.locator('tbody tr[data-row-key]').first().locator('.ca-company-cell').click();
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
  await hold(local);
  await local.waitForFunction(() => window.__ca?.meta().mode === 'local' && document.querySelectorAll('tbody tr[data-row-key]').length > 0, null, { timeout: 180000 });
  assert.equal(await local.getByRole('combobox', { name: 'Announcement period (IST)' }).inputValue(), '3', 'fallback opens on Last 3 days');
  assert.equal(await local.evaluate(() => window.__ca.query().period), '3', 'fallback query uses Last 3 days');
  await local.evaluate(async () => (await import('/js/ui/source-beacon.js')).openBeacon());
  assert.equal(await local.locator('#source-beacon-panel [data-filings-method]').innerText(), 'Collection details · Partial source coverage',
    'the moved action still discloses local fallback coverage');
  await local.locator('#source-beacon-panel [data-filings-method]').click();
  assert((await local.locator('#modal-content').innerText()).includes('server index could not be read'), 'fallback diagnostics remain reachable');
  await local.keyboard.press('Escape');
  assert(await local.locator('tbody .category-chip').count() > 0, 'categories still show');
  const localTarget = await local.evaluate(() => window.__ca.rows().find(r => /^IN[A-Z0-9]{10}$/.test(r.isin || '')));
  assert(localTarget, 'a verified issuer exercises fallback profile refresh');
  const capFixture = JSON.parse(readFileSync(resolve(publicDir, 'data/market-caps.json')));
  // Warm a real service-worker-held data response, then replace the server's capture.
  // Install explicitly in this fixture: the application's deferred registration may still
  // be waiting for its complete static-history preparation after the first rows appear.
  await local.evaluate(() => navigator.serviceWorker.register('/sw.js'));
  await local.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 90000 });
  await local.evaluate(() => fetch('/data/market-caps.json').then(r => r.json()));
  let capPhase = 1;
  fallbackCaps = () => {
    const entries = capFixture.entries.filter(e => e.isin !== localTarget.isin);
    const old = capFixture.entries.find(e => e.isin === localTarget.isin) || {};
    entries.push({ ...old, isin: localTarget.isin, ticker: localTarget.ticker, bseCode: localTarget.scripCode || old.bseCode,
      exchanges: old.exchanges || ['NSE'], cr: capPhase === 1 ? 3333.33 : 4444.44,
      checkedAt: clock.toISOString(), priceDateLabel: null, priceAsOf: null, error: null });
    return { ...capFixture, generated_at: new Date(clock.getTime() + capPhase * 1000).toISOString(), entries };
  };
  await local.evaluate(() => { window.capRefreshClock = Date.now() + 16 * 60_000; Date.now = () => window.capRefreshClock; });
  await local.evaluate(() => window.__ca.refresh());
  assert.equal(await local.evaluate(id => window.__ca.rows().find(r => r.id === id)?.mcapCr, localTarget.id), 3333.33);
  capPhase = 2;
  await local.evaluate(() => { window.capRefreshClock += 16 * 60_000; });
  await local.evaluate(() => window.__ca.refresh());
  assert.equal(await local.evaluate(id => window.__ca.rows().find(r => r.id === id)?.mcapCr, localTarget.id), 4444.44,
    'the normal fallback refresh re-reads profiles even after the source stream has loaded once');
  assert(capReads >= 2);
  fallbackCaps = null;
  ok('a long-lived static fallback adopts updated market caps through its ordinary refresh path');
  await local.locator('tbody tr[data-row-key]').first().locator('.ca-company-cell').click();
  await local.locator('#modal-content [data-ann-read]').waitFor();
  await local.locator('.ann-read-unavailable').waitFor();
  assert.match(await local.locator('.ann-read-unavailable').innerText(), /AI reading unavailable/);
  assert.equal(await local.locator('#modal-content .ann-read-section').count(), 5, 'the same five sections, even without a reading');
  ok('without the index the tab prepares the list in the browser; the popup keeps its shape and says why the AI part is missing');

  assert.deepEqual(errors, [], 'no page errors');
  ok('no page errors');
} finally {
  releaseRead?.();
  await browser.close();
  await srv.close();
  await fallback.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${checks} groups of browser checks passed.`);
