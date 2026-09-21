#!/usr/bin/env node
// Offline regression checks for the reading layer and immutable downloadable editions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { clusterStories, relatedReports, parseAiNotes, aiItemsFor, readAiNotes, AI_ITEM_LIMIT, AI_RESPONSE_BYTES } from '../worker/newsletter-reading.mjs';
import { buildBrief, briefStoryKeys, briefStats, renderBriefHtml, renderBriefText, PRODUCTION_ORIGIN } from '../worker/newsletter-brief.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { NewsletterSchedule, EMAIL_SEND_URL } from '../worker/newsletter-schedule.mjs';
import { handleNewsletter } from '../worker/newsletter.mjs';
import { istInstant, DEFAULT_SETTINGS } from '../public/js/data/newsletter-shared.js';
import { reviewNewsEvents } from '../worker/newsletter-events.mjs';

const at = istInstant('2026-09-17', '08:00');
const row = (headline, overrides = {}) => ({ kind: 'news', ticker: 'ALANKIT', company: 'Alankit', headline, at, source: 'Reuters', score: 2, ...overrides });
const first = row('Alankit wins airport software contract worth 2600 crore');
const second = row(first.headline, { source: 'Business Line' });
assert.equal(clusterStories([first, second], { company: 'Alankit' }).length, 1);
for (const other of [
  row(first.headline, { source: 'Reuters' }),
  row(first.headline, { ticker: 'OTHER' }),
  row(first.headline, { source: 'Mint', related: true }),
  row(first.headline.replace('2600', '3600'), { source: 'Mint' }),
  row('Alankit denies airport software contract worth 2600 crore', { source: 'Mint' }),
  row(first.headline, { source: 'Mint', at: at + 86400001 }),
  row(first.headline, { kind: 'filing' }),
]) assert.equal(relatedReports(first, other, 'Alankit'), false);
for (const [positive, negative] of [['approves', 'rejects'], ['wins', 'loses'], ['grants', 'revokes'], ['allows', 'bans'], ['authorises', 'prohibits'], ['clears', 'blocks'], ['starts', 'stops']]) {
  assert.equal(relatedReports(row(`Acme ${positive} airport software contract worth 2600 crore`), row(`Acme ${negative} airport software contract worth 2600 crore`, { source: 'Mint' }), 'Acme'), false);
}
assert.equal(clusterStories([row('Regulation 30', { kind: 'filing' }), row('Regulation 30', { kind: 'filing', at: at + 1000 })]).length, 2);
assert.equal(clusterStories([first, second]).flatMap(k => [k.main, ...k.others]).length, 2);
assert.deepEqual(parseAiNotes('[{"id":"x","summary":{},"impact":"bad"}]', new Set(['x'])), {});
assert.deepEqual(parseAiNotes('[{"id":"unknown","summary":"bad","impact":"bad"}]', new Set(['x'])), {});
assert.equal(parseAiNotes('not json', new Set()), null);
assert.equal(parseAiNotes('[{"id":"x","summary":"first","impact":"may"},{"id":"x","summary":"second","impact":"may"}]', new Set(['x'])).x.summary, 'first');

const fixture = name => readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8');
const paths = {
  '/data/portfolio-companies.json': 'book.json', '/data/corp-announcements.json': 'corp-announcements.json',
  '/data/market-news.json': 'market-news.json', '/data/nse-filings/index.json': 'nse-filings-index.json',
  '/data/nse-filings/2026-09-16.json': 'nse-filings-2026-09-16.json',
  '/data/tradingview-news/latest.json': 'tradingview-news.json', '/data/technicals.json': 'technicals.json',
};
const ASSETS = { fetch: async request => {
  const path = new URL(request.url).pathname;
  return paths[path] ? new Response(fixture(paths[path])) : new Response('', { status: 404 });
} };
const env = { ASSETS, CLAUDE_KEY: 'ABSKfixture-only-key', MUNS_TOKEN: 'fixture-token', DASHBOARD_ORIGIN: PRODUCTION_ORIGIN };
let aiCalls = 0;
const emails = [];
const fetcher = async (url, init = {}) => {
  if (String(url).includes('.amazonaws.com/')) {
    aiCalls++;
    assert.equal(init.redirect, 'manual');
    const request = JSON.parse(init.body), input = JSON.parse(request.messages[0].content), items = input.ITEMS;
    if (input.REPORTS) {
      const groups = new Map();
      for (const r of input.REPORTS) { const key = `${r.ticker}:${r.headline}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r.id); }
      return Response.json({ content: [{ type: 'text', text: JSON.stringify([...groups.values()]) }] });
    }
    assert.ok(items.length <= AI_ITEM_LIMIT);
    assert.ok(!init.body.includes('fixture-token'));
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(items.map(i => ({ id: i.id, summary: i.headline, impact: 'The business impact cannot be assessed from the headline alone; the source provides the details.' }))) }] });
  }
  if (url === EMAIL_SEND_URL) { emails.push(JSON.parse(init.body)); return Response.json({ success: true }); }
  if (String(url).includes('query1.finance.yahoo.com')) return new Response(fixture('yahoo-sp500.json'));
  return new Response('', { status: 503 });
};
const brief = await buildBrief({ edition: 'morning', day: '2026-09-17', settings: DEFAULT_SETTINGS, env, fetcher, now: at });
assert.equal(aiCalls, 2, 'one repeated-news check, then one notes request');
assert.ok(brief.ai.answered > 0);
const beforeKeys = briefStoryKeys(brief);
const company = brief.news.groups[0];
// Same report, another publisher: all original links, source text and sent keys must survive.
const original = company.items[0];
company.items.push({ ...original, publisher: 'Another publisher', url: 'https://example.test/related?x=1&y=2', summary: 'The transaction remains subject to approval.', keys: ['related-key'], late: true });
brief.news.dedup = await reviewNewsEvents({ news: brief.news, env, fetcher });
const stats = briefStats(brief);
assert.ok(stats.updates < stats.stories);
assert.ok(aiItemsFor(stats.companies).some(i => i.related.some(r => r.summary === 'The transaction remains subject to approval.')), 'the model sees the related report caveat');
assert.ok(briefStoryKeys(brief).includes('related-key'));
for (const key of beforeKeys) assert.ok(briefStoryKeys(brief).includes(key));
brief.ai = await readAiNotes({ env, fetcher, companies: stats.companies, now: at });
const id = Object.keys(brief.ai.items)[0];
const cleanNote = { ...brief.ai.items[id] };
brief.ai.items[id].summary = '<script>alert("unsafe")</script>';
const hostile = renderBriefHtml(brief);
assert.ok(hostile.includes('&lt;script&gt;'));
assert.ok(!hostile.includes('<script>'));
brief.ai.items[id] = cleanNote;
const html = renderBriefHtml(brief, { pdfUrl: 'https://example.test/api/newsletter/pdf/test-document' });
assert.ok(html.includes('Download PDF ↓') && html.indexOf('Download PDF ↓') < html.indexOf('SATTVA VENTURES</div>'));
assert.ok(html.includes('AI SUMMARY') && html.includes('POTENTIAL IMPACT · AI'));
assert.ok(html.includes('Related coverage') && html.includes('https://example.test/related?x=1&amp;y=2'));
assert.ok(html.includes('Automated by Munshot') && renderBriefText(brief).includes('Automated by Munshot'));
assert.ok(renderBriefText(brief).includes('Related:'));

const companies = stats.companies;
for (const [response, expected] of [[new Response('', { status: 429 }), 'rate-limited'], [Response.json({ content: [] }), 'unreadable'], [new Response('x'.repeat(AI_RESPONSE_BYTES+1)), 'unreadable']]) {
  const notes = await readAiNotes({ env, companies, fetcher: async () => response });
  assert.equal(notes.ok, false); assert.equal(notes.reason, expected);
}
const timeout = await readAiNotes({ env, companies, fetcher: async () => { throw new DOMException('deadline', 'TimeoutError'); } });
assert.equal(timeout.reason, 'timeout');
const noKey = await readAiNotes({ env: {}, companies, fetcher: async () => { throw new Error('must not call'); } });
assert.equal(noKey.reason, 'not-configured');
const partial = await readAiNotes({ env, companies, fetcher: async () => Response.json({ content: [{ type: 'text', text: JSON.stringify([{ id: companies[0].clusters.find(k => k.kind === 'story').id, summary: 'Reported in the source.', impact: 'Details require reading the source.' }]) }] }) });
assert.equal(partial.partial, true);

const pdf = renderBriefPdf(brief);
const pdfText = new TextDecoder().decode(pdf);
assert.ok(pdfText.startsWith('%PDF-1.4'));
assert.ok(pdfText.includes('/Creator (Automated by Munshot)'));
assert.ok(pdfText.includes('Another publisher'));
assert.ok(pdfText.includes('/URI (https://example.test/related?x=1&y=2)'));
const xrefAt = Number(pdfText.match(/startxref\n(\d+)/)[1]);
assert.equal(pdfText.slice(xrefAt, xrefAt + 4), 'xref');
assert.equal((pdfText.match(/SATTVA VENTURES \/ Automated by Munshot/g) || []).length, Number(pdfText.match(/\/Type \/Pages \/Count (\d+)/)[1]));

const db = new DatabaseSync(':memory:');
const storage = {
  sql: { exec: (query, ...args) => { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
  transactionSync: fn => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
};
const store = new NewsletterStore(storage, { now: () => at });
store.apply([{ op: 'subscribe', email: 'test@example.test', by: 'Fixture' }]);
const schedule = new NewsletterSchedule(storage, env, store, { fetcher, now: () => at });
const delivery = await schedule.deliver({ edition: 'morning', day: '2026-09-17', at, key: 'fixture-edition', source: 'timer', now: at });
assert.equal(delivery.sent, 1);
const download = emails[0].html.match(/href="([^"]+\/api\/newsletter\/pdf\/[^"]+)"/)[1];
const documentId = download.split('/').at(-1), saved = store.document(documentId);
assert.ok(saved.body.byteLength > 1000);
assert.ok(!new TextDecoder().decode(saved.body).includes('test@example.test'));
const restarted = new NewsletterStore(storage);
assert.deepEqual(restarted.document(documentId), saved);
const apiEnv = { NEWSLETTER_LIMITER: { limit: async () => ({ success: true }) }, NEWSLETTER: { getByName: () => ({ newsletterPdf: id => restarted.document(id), newsletterPreview: input => schedule.preview(input) }) } };
const callsBefore = aiCalls;
const response = await handleNewsletter(new Request(download), apiEnv);
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-type'), 'application/pdf');
assert.match(response.headers.get('content-disposition'), /^attachment; filename="sattva-2026-09-17-morning-brief.pdf"$/);
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), saved.body);
assert.equal(aiCalls, callsBefore, 'downloads never call the model or current source feeds');
assert.equal((await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/pdf/${crypto.randomUUID()}`), apiEnv)).status, 404);
assert.equal((await handleNewsletter(new Request(download, { method: 'POST' }), apiEnv)).status, 405);
assert.equal((await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/pdf/not-a-token`), apiEnv)).status, 404);
const blockedPreview = await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/preview`), { ...apiEnv, NEWSLETTER_LIMITER: { limit: async () => ({ success: false }) } });
assert.equal(blockedPreview.status, 429);
assert.equal(aiCalls, callsBefore, 'rejected previews never start AI');
const savedKeys = [...store.sentStoryKeys()];
const preview = await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/preview?format=pdf`), apiEnv);
assert.equal(preview.headers.get('content-type'), 'application/pdf');
assert.equal(aiCalls, callsBefore, 'public previews never call paid AI even with configured credentials');
assert.equal(emails.length, 1, 'PDF requests and previews do not send email');
assert.deepEqual([...store.sentStoryKeys()], savedKeys);
assert.deepEqual(restarted.document(documentId), saved, 'new previews cannot overwrite a sent edition');
const after = await schedule.deliver({ edition: 'morning', day: '2026-09-17', at, key: 'fixture-edition', source: 'timer', now: at });
assert.equal(after.reason, 'already-sent');
assert.equal(emails.length, 1);

// Confirmed rejection reclaims its PDF. Unknown outcomes preserve a possibly delivered link,
// retaining its own delivery association even after the short delivery log has been pruned.
for (const [name, emailResponse, expectedDocs, state] of [
  ['refused', async () => new Response('', { status: 403 }), 0, null],
  ['timeout', async () => { throw new DOMException('timeout', 'TimeoutError'); }, 1, 'delivery-uncertain'],
]) {
  const before = store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n;
  const failing = new NewsletterSchedule(storage, env, store, { now: () => at, fetcher: (url, init) => url === EMAIL_SEND_URL ? emailResponse() : fetcher(url, init) });
  const result = await failing.deliver({ edition: 'morning', day: '2026-09-17', at, key: `failed-${name}`, source: 'test', now: at });
  assert.equal(result.sent, 0);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n, before + expectedDocs);
  if (state) assert.equal(store.rows('SELECT delivery_state FROM newsletter_documents WHERE delivery_key = ?', `failed-${name}`)[0].delivery_state, state);
}
assert.deepEqual(store.document(documentId), saved, 'failed later sends cannot remove a successfully sent PDF');

// Manual sends have a desk-wide durable budget; no source, model or email I/O follows refusal.
for (let n = 0; n < 4; n++) assert.equal(restarted.claimManualDelivery(at + n).ok, true);
assert.equal(new NewsletterStore(storage).claimManualDelivery(at + 100).ok, false);
const noWork = new NewsletterSchedule(storage, env, restarted, { now: () => at + 200, fetcher: async () => { throw new Error('budget refusal must precede network work'); } });
assert.equal((await noWork.sendNow({ edition: 'morning', to: 'me', email: 'another@example.test' })).reason, 'manual-send-budget');
assert.equal((await noWork.sendNow({ edition: 'evening', to: 'all' })).reason, 'manual-send-budget');
assert.equal(restarted.claimManualDelivery(at + 86400000).ok, true, 'an expired reservation becomes available again');

if (process.env.NEWSLETTER_PREVIEW_DIR) {
  mkdirSync(process.env.NEWSLETTER_PREVIEW_DIR, { recursive: true });
  writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/sattva-portfolio-brief.pdf`, pdf);
  writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/sattva-portfolio-brief.html`, html.replace('https://example.test/api/newsletter/pdf/test-document', 'sattva-portfolio-brief.pdf'));
}
console.log('PASS: grouping, evidence retention, AI success/failure/escaping, branded PDF, immutable downloads, routes, and no duplicate sends');

if (process.env.NEWSLETTER_LAYOUT === '1') {
  const { createServer } = await import('node:http');
  const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
  const server = createServer((req, res) => {
    if (req.url === '/edition.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="sattva-portfolio-brief.pdf"' }); res.end(pdf); }
    else { res.setHeader('content-type', 'text/html'); res.end(html.replace('https://example.test/api/newsletter/pdf/test-document', '/edition.pdf')); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1440, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal overflow at ${width}px`);
      const button = page.getByRole('link', { name: 'Download PDF' });
      assert.ok(await button.isVisible());
      const box = await button.boundingBox();
      assert.ok(box.y < 100 && box.x + box.width / 2 > width / 2, 'button is at the top right');
      if (process.env.NEWSLETTER_PREVIEW_DIR && [1440, 390].includes(width)) await page.screenshot({ path: `${process.env.NEWSLETTER_PREVIEW_DIR}/email-${width}.png`, fullPage: false });
    }
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download PDF' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'sattva-portfolio-brief.pdf');
    assert.equal(await download.failure(), null);
    assert.deepEqual(errors, []);
    console.log('PASS: fluid email at 1440/760/390/320px, top-right PDF button, browser download, zero page errors');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
