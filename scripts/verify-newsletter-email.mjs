#!/usr/bin/env node
// Size, evidence conservation and delivery-failure regressions. All email/AI I/O is stubbed.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildBrief, briefStats, briefStories, briefStoryKeys, renderBriefHtml, PRODUCTION_ORIGIN } from '../worker/newsletter-brief.mjs';
import { renderBriefEmails, emailBytes, EMAIL_HTML_BYTES, acceptedStoryKeys } from '../worker/newsletter-email.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { NewsletterSchedule, sendEmail, EMAIL_SEND_URL } from '../worker/newsletter-schedule.mjs';
import { handleNewsletter } from '../worker/newsletter.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';

const at = istInstant('2026-09-17', '08:00');
const day = '2026-09-17';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8'));
const payloads = {
  '/data/portfolio-companies.json': fixture('book.json'),
  '/data/corp-announcements.json': fixture('corp-announcements.json'),
  '/data/market-news.json': fixture('market-news.json'),
  '/data/nse-filings/index.json': fixture('nse-filings-index.json'),
  '/data/nse-filings/2026-09-16.json': fixture('nse-filings-2026-09-16.json'),
  '/data/tradingview-news/latest.json': fixture('tradingview-news.json'),
  '/data/technicals.json': fixture('technicals.json'),
};
const assets = data => ({ fetch: async r => data[new URL(r.url).pathname] ? Response.json(data[new URL(r.url).pathname]) : new Response('', { status: 404 }) });
const unavailable = async () => new Response('', { status: 503 });
const env = { ASSETS: assets(payloads), MUNS_TOKEN: 'fixture-only-token', DASHBOARD_ORIGIN: PRODUCTION_ORIGIN };
const brief = await buildBrief({ edition: 'morning', day, settings: DEFAULT_SETTINGS, env, now: at, fetcher: unavailable });
const pdfUrl = `${PRODUCTION_ORIGIN}/api/newsletter/pdf/00000000-0000-0000-0000-000000000001`;
const options = { pdfUrl, recipient: { addedBy: 'Fixture & <Test>' } };
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function checkParts(b, messages) {
  const keys = messages.flatMap(m => m.keys);
  assert.deepEqual([...new Set(keys)].sort(), briefStoryKeys(b).sort(), 'every source identity is preserved');
  assert.equal(keys.length, new Set(keys).size, 'no source is duplicated between parts');
  assert.equal(new Set(messages.map(m => m.subject)).size, messages.length, 'distinct subjects prevent part threading');
  const content = messages.map(m => m.html).join('\n');
  for (const story of briefStories(b)) {
    assert.ok(content.includes(escape(story.headline)), `headline retained: ${story.headline}`);
    if (story.dek) assert.ok(content.includes(escape(story.dek)), 'source summary retained in full');
  }
  for (const [i, m] of messages.entries()) {
    assert.ok(m.bytes <= EMAIL_HTML_BYTES);
    assert.equal(m.bytes, Buffer.byteLength(m.html));
    assert.ok(m.html.includes(pdfUrl) && m.html.includes('Automated by Munshot') && m.html.includes('Unsubscribe'));
    if (messages.length > 1) {
      assert.ok(m.html.includes(`Part ${i + 1} of ${messages.length}`));
      assert.ok(m.subject.endsWith(`Part ${i + 1} of ${messages.length}`));
      assert.equal(m.html.includes('Global market scan'), i === messages.length - 1);
    }
  }
}

const single = renderBriefEmails(brief, options);
assert.equal(single.length, 1, 'a normal short edition is one email');
checkParts(brief, single);
const boundary = emailBytes(renderBriefHtml(brief, options));
assert.equal(renderBriefEmails(brief, options, { maxBytes: boundary }).length, 1);
assert.ok(renderBriefEmails(brief, options, { maxBytes: boundary - 1 }).length > 1, 'one byte over the limit splits');
assert.equal(emailBytes('₹漢😀'), Buffer.byteLength('₹漢😀'));
const overlapping = [{ keys: ['url:first', 'shared-text-prefix'] }, { keys: ['url:second', 'shared-text-prefix'] }];
assert.deepEqual(acceptedStoryKeys(overlapping, new Set([0])), ['url:first'], 'a shared fallback identity cannot hide an unsent filing');
assert.deepEqual(acceptedStoryKeys(overlapping, new Set([0, 1])).sort(), ['url:first', 'url:second', 'shared-text-prefix'].sort());
const unicode = structuredClone(brief);
unicode.news.groups[0].items[0].summary = '₹漢😀'.repeat(7500);
assert.ok(renderBriefHtml(unicode, options).length < EMAIL_HTML_BYTES, 'the character count misleadingly fits');
const unicodeParts = renderBriefEmails(unicode, options);
assert.ok(unicodeParts.length > 1, 'encoded bytes, including multibyte text, control splitting');
checkParts(unicode, unicodeParts);

// More than two emails and a company bigger than an entire email. Preserve every full update,
// related-source caveat, escaping and AI annotation rather than truncate at a character count.
const huge = structuredClone(brief);
const original = huge.news.groups[0].items[0];
huge.announcements.groups = []; huge.moves.rows = [];
huge.news.groups = [{ ...huge.news.groups[0], items: Array.from({ length: 48 }, (_, i) => ({ ...original,
  headline: `Fixture update ${i} <script>source text</script>`, summary: `Full source text ${i}. ` + 'Business details & conditions. '.repeat(120),
  at: at - i * 1000 - 1000, url: `https://example.test/evidence/${i}?a=1&b=2`, keys: [`fixture:${i}`] })) }];
huge.news.groups[0].items.push({ ...huge.news.groups[0].items[0], publisher: 'Another publisher',
  summary: 'Related report: the proposal remains conditional.', url: 'https://example.test/related', keys: ['related-evidence'] });
const hugeStats = briefStats(huge);
huge.ai = { ok: true, eligible: 48, answered: 40, items: Object.fromEntries(hugeStats.companies[0].clusters.slice(0, 40).map(k => [k.id, { summary: `AI summary for ${k.id}`, impact: `Possible impact for ${k.id}` }])) };
const hugeParts = renderBriefEmails(huge, options);
assert.ok(hugeParts.length > 2);
assert.ok(hugeParts.slice(1).some(m => m.html.includes('(continued)')));
checkParts(huge, hugeParts);
for (const note of Object.values(huge.ai.items)) {
  assert.equal(hugeParts.filter(m => m.html.includes(`${note.summary}<br>`)).length, 1);
  assert.equal(hugeParts.filter(m => m.html.includes(`${note.impact}</div>`)).length, 1);
}
assert.ok(hugeParts.every(m => !m.html.includes('<script>')));
const impossible = structuredClone(brief);
impossible.news.groups[0].items[0].summary = 'x'.repeat(100000);
assert.throws(() => renderBriefEmails(impossible, options), { code: 'email-too-large' }, 'a pathological update fails visibly before any send');
assert.equal((await sendEmail({ html: 'x'.repeat(EMAIL_HTML_BYTES + 1), fetcher: () => { throw new Error('must not send'); } })).reason, 'email-too-large');

// Build a deterministic busy edition through the real source adapters and schedule.
const busyPayloads = structuredClone(payloads);
busyPayloads['/data/market-news.json'].articles = busyPayloads['/data/portfolio-companies.json'].holdings.filter(h => h.ticker).flatMap(h => Array.from({ length: 8 }, (_, i) => ({
  id: `${h.ticker}-${i}`, title: `${h.name} announces fixture business update ${i}`,
  summary: `${h.name} supplied details ${i}. ` + 'Full fixture source details. '.repeat(120),
  url: `https://example.test/${h.ticker}/${i}`, publisher: 'Fixture publisher', publishedAt: new Date(at - 60000 * (i + 1)).toISOString(),
})));
const busyEnv = { ...env, ASSETS: assets(busyPayloads) };
const busy = await buildBrief({ edition: 'morning', day, settings: DEFAULT_SETTINGS, env: busyEnv, now: at, fetcher: unavailable });
const busyMessages = renderBriefEmails(busy, options);
assert.equal(busyMessages.length, 2, 'a busy edition fits two complete, readable emails');
checkParts(busy, busyMessages);
// Keep all small company blocks together; split only a company too large to fit alone.
const companyParts = new Map();
for (const [i, message] of busyMessages.entries()) for (const c of message.part.companies) {
  assert.ok(!companyParts.has(c.ticker), 'small company is not split'); companyParts.set(c.ticker, i);
}

function harness(response = () => Response.json({ success: true })) {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec: (query, ...args) => { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync: fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const store = new NewsletterStore(storage, { now: () => at });
  store.apply([{ op: 'subscribe', email: 'reader@example.test', by: 'Fixture & <Test>' }]);
  const emails = [];
  const schedule = new NewsletterSchedule(storage, busyEnv, store, { now: () => at, fetcher: async (url, init) => {
    if (url !== EMAIL_SEND_URL) return unavailable();
    const email = JSON.parse(init.body); emails.push(email); return response(email, emails.length);
  } });
  return { storage, store, schedule, emails };
}
const args = { edition: 'morning', day, at, now: at, key: 'fixture:busy', source: 'timer' };
const good = harness();
good.store.apply([{ op: 'subscribe', email: 'second@example.test', by: 'Long & <name>'.repeat(4) }]);
const delivered = await good.schedule.deliver(args);
assert.equal(delivered.sent, 2); assert.equal(delivered.failed, 0); assert.equal(delivered.summary.emailParts, 2);
assert.equal(good.emails.length, 4);
for (const address of ['reader@example.test', 'second@example.test']) {
  const emails = good.emails.filter(e => e.email === address);
  assert.ok(emails[0].subject.endsWith('Part 1 of 2') && emails[1].subject.endsWith('Part 2 of 2'));
  for (const email of emails) assert.ok(Buffer.byteLength(email.html) <= EMAIL_HTML_BYTES);
}
assert.deepEqual([...good.store.sentStoryKeys()].sort(), briefStoryKeys(busy).sort());
assert.equal(new Set(good.emails.map(e => e.html.match(/\/api\/newsletter\/pdf\/([a-f0-9-]+)/)[1])).size, 1, 'all parts use the same immutable complete PDF');
assert.equal((await good.schedule.deliver(args)).reason, 'already-sent'); assert.equal(good.emails.length, 4);

const partial = harness((_email, index) => index === 2 ? new Response('', { status: 403 }) : Response.json({ success: true }));
const partDelivery = await partial.schedule.deliver(args);
assert.equal(partDelivery.ok, false); assert.equal(partDelivery.reason, 'partial-send');
assert.equal(partDelivery.sent, 0); assert.equal(partDelivery.failed, 1);
assert.deepEqual(partDelivery.outcomes[0].parts.map(p => p.ok), [true, false]);
assert.deepEqual([...new NewsletterStore(partial.storage).sentStoryKeys()].sort(), busyMessages[0].keys.sort(), 'only accepted parts become read history after restart');
assert.equal(partial.store.rows('SELECT delivery_state FROM newsletter_documents')[0].delivery_state, 'sent', 'a delivered first part keeps the complete PDF usable');

const interrupted = harness();
const record = interrupted.store.recordDeliveryProgress.bind(interrupted.store);
interrupted.store.recordDeliveryProgress = (...values) => {
  record(...values);
  if (values[1].outcomes.some(o => o.parts.some(p => p.ok))) throw new Error('simulated object interruption');
};
await assert.rejects(interrupted.schedule.deliver(args), /simulated object interruption/);
const restarted = new NewsletterStore(interrupted.storage);
assert.equal(restarted.delivery(args.key).finishedAt, null);
assert.deepEqual([...restarted.sentStoryKeys()].sort(), busyMessages[0].keys.sort());
assert.equal(restarted.delivery(args.key).outcomes[0].parts[1].reason, 'not-attempted');
assert.equal((await interrupted.schedule.deliver(args)).reason, 'already-sent');
assert.equal(interrupted.emails.length, 1, 'a replay does not resend an accepted or uncertain part');

const testCopy = harness();
await testCopy.schedule.deliver({ ...args, source: 'test' });
assert.equal(testCopy.store.sentStoryKeys().size, 0, 'multi-part tests do not suppress desk history');
const rejected = harness(() => new Response('', { status: 403 }));
const rejectedDelivery = await rejected.schedule.deliver(args);
assert.equal(rejectedDelivery.sent, 0); assert.equal(rejected.store.sentStoryKeys().size, 0);
assert.equal(rejected.store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n, 0, 'all-definite rejection reclaims the unused PDF');
const unknown = harness(() => { throw new DOMException('timeout', 'TimeoutError'); });
await unknown.schedule.deliver(args);
assert.equal(unknown.store.sentStoryKeys().size, 0);
assert.equal(unknown.store.rows('SELECT delivery_state FROM newsletter_documents')[0].delivery_state, 'delivery-uncertain');
const partlyUnknown = harness((_email, index) => { if (index === 1) throw new DOMException('timeout', 'TimeoutError'); return Response.json({ success: true }); });
const partlyUnknownDelivery = await partlyUnknown.schedule.deliver(args);
assert.equal(partlyUnknownDelivery.reason, 'partial-send');
assert.equal(partlyUnknownDelivery.outcomes[0].status, null, 'a later successful part cannot overwrite an earlier timeout status');
assert.deepEqual([...partlyUnknown.store.sentStoryKeys()].sort(), busyMessages[1].keys.sort());

const previewHarness = harness();
const apiEnv = { NEWSLETTER_LIMITER: { limit: async () => ({ success: true }) }, NEWSLETTER: { getByName: () => ({ newsletterPreview: input => previewHarness.schedule.preview(input) }) } };
for (const part of [1, 2]) {
  const response = await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/preview?part=${part}`), apiEnv);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-newsletter-parts'), '2');
  const html = await response.text(); assert.ok(html.includes(`Part ${part} of 2`) && html.includes('Preview Part 2'));
}
for (const part of ['0', '3', '-1', '1.5', 'foo']) assert.equal((await handleNewsletter(new Request(`${PRODUCTION_ORIGIN}/api/newsletter/preview?part=${part}`), apiEnv)).status, 400);
assert.equal(previewHarness.emails.length, 0);
assert.equal(previewHarness.store.rows('SELECT COUNT(*) AS n FROM newsletter_documents')[0].n, 0);
console.log('PASS: exact UTF-8 budgets, one/two/extra parts, whole-company grouping, evidence and AI preservation, per-part delivery, failures/restarts, PDF retention, numbered previews');

if (process.env.NEWSLETTER_PREVIEW_DIR) {
  mkdirSync(process.env.NEWSLETTER_PREVIEW_DIR, { recursive: true });
  busyMessages.forEach((m, i) => writeFileSync(`${process.env.NEWSLETTER_PREVIEW_DIR}/email-part-${i + 1}.html`, m.html));
}
if (process.env.NEWSLETTER_LAYOUT === '1') {
  const { createServer } = await import('node:http');
  const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(busyMessages[req.url === '/2' ? 1 : 0].html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [1440, 390, 320]) for (const part of [1, 2]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`http://127.0.0.1:${server.address().port}/${part}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.ok(await page.getByText(`Part ${part} of 2`, { exact: true }).first().isVisible());
      assert.equal(await page.locator('body').innerText().then(t => /global market scan/i.test(t)), part === 2);
      const download = await page.getByRole('link', { name: 'Download PDF' }).boundingBox();
      assert.ok(download.y < 100 && download.x + download.width / 2 > width / 2);
      const summary = page.getByText(/^(?:Alankit Limited|Aditya Birla Capital|Adani Enterprises) supplied details/).first();
      assert.ok(await summary.count(), 'each fixture part contains full source text');
      const style = await summary.evaluate(el => ({ font: getComputedStyle(el).fontFamily, size: getComputedStyle(el).fontSize }));
      assert.ok(style.font.includes('Arial') && style.size === '14px', 'shared inline typography inherits correctly');
      if (process.env.NEWSLETTER_PREVIEW_DIR && width !== 320) await page.screenshot({ path: `${process.env.NEWSLETTER_PREVIEW_DIR}/part-${part}-${width}.png` });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: both email parts at desktop and mobile widths, readable inherited styles, clear numbering, top-right PDF button, no horizontal overflow or page errors');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
