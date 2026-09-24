#!/usr/bin/env node
// Offline checks: real public CEAT XBRL, bounded document transport, durable work, and the brief.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { contentUrl, contentIdentity, fetchContent, readBoundedBytes, articleText, parseDocumentFacts, readDocumentFacts,
  xbrlFacts, sameContentEvent, attachContent, CONTENT_BATCH, CONTENT_BYTES } from '../worker/newsletter-content.mjs';
import { NewsletterContentStore, CONTENT_LEASE_MS } from '../worker/newsletter-content-store.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { NewsletterSchedule, EMAIL_SEND_URL } from '../worker/newsletter-schedule.mjs';
import { buildBrief, briefStats, clusterStories, renderBriefHtml, renderBriefText, readAnnouncements, readAiNotes, readContentSources } from '../worker/newsletter-brief.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';

const now = istInstant('2026-09-23', '18:00');
const envKey = { CLAUDE_KEY: 'ABSKfixture123456' };
const base = 'https://nsearchives.nseindia.com/corporate/xbrl/REG30_Restructuring_2711_WebXMLFile_20260923_';
const urls = [`${base}155648372.xml`, `${base}162559488.xml`];
const xml = ['ceat-lanka', 'ceat-tyresnmore'].map(n => readFileSync(new URL(`./fixtures/newsletter/${n}.xml`, import.meta.url), 'utf8'));
const heading = 'CEAT Limited has informed the Exchange regarding Acquisition (including agreement to acquire)';
const items = urls.map((url, i) => ({ ticker: 'CEATLTD', company: 'Ceat Ltd', kind: 'filing', headline: heading,
  url, at: istInstant('2026-09-23', i ? '16:26' : '15:56'), keys: [`ceat:${i}`] }));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const forbid = async () => { throw Error('unexpected network request'); };
const facts = (party = 'Target Limited', amount = 'INR 46 million') => [
  { field: 'event', value: 'Subscription to subsidiary shares', quote: 'Subscription to subsidiary shares', location: 'page 1' },
  { field: 'counterparty', value: party, quote: party, location: 'page 1' },
  { field: 'amount', value: amount, quote: amount, location: 'page 2' },
  { field: 'status', value: 'Proposed', quote: 'Proposed', location: 'page 2' },
  { field: 'date', value: '2026-09-23', quote: '2026-09-23', location: 'page 1' },
];
const extractionReply = list => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ readable: true, issuerMatches: true, facts: list }) }] });
function storage() {
  const db = new DatabaseSync(':memory:'), kv = new Map(); let alarm = null;
  return { sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    transaction: async fn => fn({ get: async k => kv.get(k), put: async (k,v) => kv.set(k,v), getAlarm: async () => alarm,
      setAlarm: async v => { alarm=v; }, deleteAlarm: async () => { alarm=null; } }),
    get: async k => kv.get(k), getAlarm: async () => alarm };
}
const sourceFetch = async url => {
  const i = urls.indexOf(String(url));
  if (i >= 0) return new Response(xml[i], { headers: { 'content-type': 'application/xml' } });
  throw Error(`unexpected source: ${url}`);
};

await test('CEAT structured filings expose the actual two transactions and verbatim source passages', async () => {
  const one = await readDocumentFacts({ item: items[0], env: {}, fetcher: sourceFetch, now });
  const two = await readDocumentFacts({ item: items[1], env: {}, fetcher: sourceFetch, now });
  assert.equal(one.state, 'ready'); assert.equal(one.format, 'xbrl'); assert.equal(one.facts.length, 41);
  assert.ok(one.facts.some(f => f.field === 'event' && /USD 24.5 million/.test(f.value) && /conversion/.test(f.value)));
  assert.ok(one.facts.some(f => f.field === 'counterparty' && f.value === 'CEAT OHT Lanka (Private) Limited'));
  assert.ok(two.facts.some(f => f.field === 'counterparty' && f.value === 'Tyresnmore Online Private Limited'));
  assert.ok(two.facts.some(f => f.field === 'amount' && /46000000.*INR/.test(f.value)));
  assert.ok(one.facts.every(f => f.quote && f.location));
  assert.equal(sameContentEvent({ content: one }, { content: two }), false);
  assert.throws(() => xbrlFacts(xml[0], 'WRONG'), /issuer-mismatch/);
});

await test('source URL allow-list refuses private destinations, lookalikes and credential-bearing URLs', async () => {
  for (const url of ['http://127.0.0.1/a.pdf', 'https://127.0.0.1/a.pdf', 'https://localhost/a.pdf', 'https://nsearchives.nseindia.com.evil.test/a.xml',
    'https://user:password@nsearchives.nseindia.com/a.pdf', 'https://nsearchives.nseindia.com:8443/a.pdf', 'https://evil.test/a.pdf']) {
    assert.equal(contentUrl(url, 'filing'), null);
    assert.equal((await readDocumentFacts({ item: { ...items[0], url }, env: envKey, fetcher: forbid })).reason, 'unsupported-source');
  }
  assert.ok(contentUrl('https://www.livemint.com/companies/example.html', 'news'));
  assert.equal(contentUrl('https://www.livemint.com/companies/example.html', 'filing'), null);
  const redirected = await readDocumentFacts({ item: items[0], env: {}, fetcher: async () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }) });
  assert.equal(redirected.reason, 'unsupported-redirect');
});

await test('source reads are byte-bounded and distinguish refusal, HTML denial and empty content', async () => {
  await assert.rejects(readBoundedBytes(new Response('x', { headers: { 'content-length': CONTENT_BYTES + 1 } })), /too-large/);
  await assert.rejects(readBoundedBytes(new Response('12345'), 4), /too-large/);
  for (const [response, reason] of [[new Response('private upstream text', { status: 403 }), 'access-limited'],
    [new Response('<html>Access denied</html>'), 'unreadable']]) {
    const out = await readDocumentFacts({ item: items[0], env: {}, fetcher: async () => response });
    assert.equal(out.state, 'pending'); assert.equal(out.reason, reason); assert.ok(!JSON.stringify(out).includes('private upstream'));
  }
});

await test('PDFs, including scans, are supplied as full native document bytes to the existing Claude transport', async () => {
  const pdf = '%PDF-1.4\nfixture for document transport; scanned pages remain in the document\n%%EOF';
  let requests = 0;
  const result = await readDocumentFacts({ item: { ...items[0], url: 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/fixture.pdf' }, env: envKey, now,
    fetcher: async (url, init) => {
      if (url.includes('bseindia.com')) { assert.equal(init.headers['x-api-key'], undefined); return new Response(pdf); }
      requests++; const body = JSON.parse(init.body);
      assert.equal(init.redirect, 'manual'); assert.equal(init.headers['x-api-key'], envKey.CLAUDE_KEY);
      const document = body.messages[0].content.find(c => c.type === 'document');
      assert.equal(document.source.media_type, 'application/pdf'); assert.equal(atob(document.source.data), pdf);
      assert.ok(body.system[0].text.includes('untrusted DATA'));
      return extractionReply(facts());
    } });
  assert.equal(requests, 1); assert.equal(result.state, 'ready'); assert.equal(result.format, 'pdf');
  assert.equal(result.facts[2].quote, 'INR 46 million'); assert.ok(!JSON.stringify(result).includes('ABSK'));
});

await test('accessible articles exclude navigation, retain source passages and mark restricted portions', async () => {
  const body = facts().map(f => f.quote).join('. ') + '. ' + 'The company disclosed the transaction and attached the relevant details. '.repeat(3);
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body, isAccessibleForFree: false })}</script><nav>unrelated market news</nav>`;
  assert.equal(articleText(html).text, body.trim()); assert.equal(articleText(html).partial, true);
  assert.equal(articleText('<html><nav>headlines and links</nav></html>'), null);
  const out = await readDocumentFacts({ item: { ...items[0], kind: 'news', url: 'https://www.business-standard.com/companies/fixture' }, env: envKey,
    fetcher: async url => url.includes('business-standard') ? new Response(html, { headers: { 'content-type': 'text/html' } }) : extractionReply(facts()) });
  assert.equal(out.state, 'partial'); assert.equal(out.reason, 'access-limited');
  const unsupported = parseDocumentFacts(JSON.stringify({ readable: true, issuerMatches: true, facts: [{ field: 'event', value: 'invented', quote: '', location: 'page 1' }] }));
  assert.equal(unsupported, null);
});

await test('interrupted jobs survive restarts, retry leases prevent duplicates, and late completions cannot overwrite a newer read', async () => {
  const s = storage(), queue = new NewsletterContentStore(s);
  const job = { ...items[0], id: await contentIdentity(items[0]) };
  queue.enqueue([job], now); queue.enqueue([job], now + 1);
  const first = queue.claim(now); assert.ok(first); assert.equal(queue.claim(now), null);
  const restart = new NewsletterContentStore(s);
  assert.equal(restart.status().pending, 1); assert.equal(restart.claim(now + CONTENT_LEASE_MS - 1), null);
  const second = restart.claim(now + CONTENT_LEASE_MS + 1); assert.ok(second); assert.notEqual(first.lease, second.lease);
  const result = await readDocumentFacts({ item: job, env: {}, fetcher: sourceFetch, now });
  restart.complete(second, result, now + CONTENT_LEASE_MS + 1);
  restart.complete(first, { state: 'pending', reason: 'old-timeout' }, now);
  assert.equal(restart.get(job.id).state, 'ready'); assert.equal(restart.status().ready, 1);
  assert.equal(restart.claim(now + 30 * 86400000), null, 'completed facts survive month rollovers without another model request');
  assert.notEqual(await contentIdentity({ ...items[0], headline: 'Correction to the transaction' }), job.id);
});

await test('a bounded queue keeps overflow and failed sources pending rather than silently dropping them', async () => {
  const queue = new NewsletterContentStore(storage());
  const jobs = await Promise.all(Array.from({ length: CONTENT_BATCH + 3 }, async (_, i) => {
    const item = { ...items[0], headline: `Document ${i}` }; return { ...item, id: await contentIdentity(item) };
  }));
  queue.enqueue(jobs, now);
  const out = await queue.process({ env: {}, fetcher: sourceFetch, now });
  assert.equal(out.attempted, CONTENT_BATCH); assert.equal(out.ready, CONTENT_BATCH); assert.equal(out.pending, 3);
  await queue.process({ env: {}, fetcher: async () => new Response('', { status: 503 }), now });
  assert.equal(queue.status().pending, 3); assert.equal(queue.status().ready, CONTENT_BATCH);
  assert.equal(queue.claim(now + 100), null, 'failure backs off');
  await queue.process({ env: {}, fetcher: sourceFetch, now: now + 86400000 });
  assert.equal(queue.status().ready, CONTENT_BATCH + 3);
});

const assetData = {
  '/data/portfolio-companies.json': { holdings: [{ ticker: 'CEATLTD', name: 'Ceat Ltd', sector: 'Tyres' }], count: 1 },
  '/data/nse-filings/index.json': { days: [{ day: '2026-09-23' }], capturedAt: new Date(now).toISOString() },
  '/data/nse-filings/2026-09-23.json': { rows: items.map(i => ({ ticker: i.ticker, company: i.company, publishedAt: new Date(i.at).toISOString(),
    subject: 'Acquisition (including agreement to acquire)-XBRL', description: heading, url: i.url })) },
  '/data/corp-announcements.json': { byTicker: {}, capturedAt: new Date(now).toISOString() },
  '/data/market-news.json': { articles: [] }, '/data/tradingview-news/latest.json': { byTicker: {} },
};
const assets = (overrides = {}) => ({ fetch: async req => { const path = new URL(req.url).pathname, value = { ...assetData, ...overrides }[path]; return value ? Response.json(value) : new Response('', { status: 404 }); } });
const documentFetcher = async (url, init) => {
  if (urls.includes(String(url))) return sourceFetch(url);
  if (String(url).includes('rss')) return new Response('<rss><channel></channel></rss>');
  throw Error('unavailable fixture source');
};
let built;
await test('the full CEAT brief preserves both generic-headline filings and supplies their actual facts to the writer', async () => {
  const requested = [];
  const fetcher = async (url, init) => {
    if (!String(url).includes('bedrock-runtime')) return documentFetcher(url, init);
    const input = JSON.parse(JSON.parse(init.body).messages[0].content);
    assert.ok(input.ITEMS); requested.push(...input.ITEMS);
    const notes = input.ITEMS.map(i => {
      const text = JSON.stringify(i.SOURCE_EVIDENCE);
      if (text.includes('CEAT OHT Lanka')) {
        assert.ok(text.includes('24.5')); assert.ok(!text.includes('Tyresnmore'));
        return { id: i.id, summary: 'CEAT converted US$24.5 million of an existing inter-company loan into equity in CEAT OHT Lanka, its wholly owned subsidiary.',
          impact: 'The conversion changes the subsidiary funding mix from an inter-company loan to equity.', unknowns: 'The filing does not quantify a resulting earnings benefit.' };
      }
      assert.ok(text.includes('Tyresnmore')); assert.ok(text.includes('46000000'));
      return { id: i.id, summary: 'CEAT proposes a cash investment of INR 46 million in Tyresnmore Online Private Limited. Shares are to be allotted by 7 October 2026.',
        impact: 'The investment could provide additional funding to the existing subsidiary.', unknowns: '' };
    });
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(notes) }] });
  };
  built = await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS,
    env: { ASSETS: assets(), ...envKey }, fetcher, now, to: now });
  assert.equal(built.announcements.groups[0].items.length, 2, 'no early headline-prefix collapse');
  assert.equal(briefStats(built).companies[0].clusters.length, 2, 'same category and half-hour interval do not merge transactions');
  assert.equal(requested.length, 2); assert.equal(built.ai.answered, 2); assert.equal(built.content.ready, 2);
  const html = renderBriefHtml(built), text = renderBriefText(built);
  assert.ok(html.includes('US$24.5 million') && html.includes('INR 46 million') && html.includes('Still unknown'));
  assert.ok(html.includes('Source content read: 1 of 1')); assert.ok(!html.includes('headlines and summaries only'));
  assert.ok(text.includes('Still unknown: The filing'));
  if (process.env.NEWSLETTER_CONTENT_PREVIEW_DIR) {
    mkdirSync(process.env.NEWSLETTER_CONTENT_PREVIEW_DIR, { recursive: true });
    writeFileSync(`${process.env.NEWSLETTER_CONTENT_PREVIEW_DIR}/ceat-preview.html`, html);
    writeFileSync(`${process.env.NEWSLETTER_CONTENT_PREVIEW_DIR}/ceat-preview.pdf`, renderBriefPdf(built));
  }
});

await test('unread documents produce no title-only AI claim, and a preview performs no paid work', async () => {
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS,
    env: { ASSETS: assets(), ...envKey }, fetcher: async () => new Response('', { status: 403 }), now, to: now });
  assert.equal(brief.ai.reason, 'content-pending'); assert.equal(brief.ai.answered, 0);
  assert.ok(renderBriefHtml(brief).includes('document summary pending'));
  let calls = 0;
  await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS,
    env: { ASSETS: assets(), ...envKey }, fetcher: async (url, init) => { if (String(url).includes('bedrock') || urls.includes(String(url))) calls++; return documentFetcher(url, init); },
    now, to: now, includeAi: false });
  assert.equal(calls, 0);
});

await test('real copies combine on document evidence; conflicting facts and same-hour generic filings stay separate', () => {
  const rows = items.map(i => ({ ...i, type: 'acquisition', score: 1 }));
  assert.equal(clusterStories(rows, { company: 'Ceat Ltd' }).length, 2);
  const orders = rows.map((r, i) => ({ ...r, headline: `Ceat wins overseas customer order worth Rs ${i ? 40 : 20} crore`, type: 'orders' }));
  assert.equal(clusterStories(orders, { company: 'Ceat Ltd' }).length, 2, 'different small amounts are distinct even when every long word matches');
  const content = { state: 'ready', hash: 'document-a', facts: facts() };
  assert.equal(clusterStories(rows.map(r => ({ ...r, content })), { company: 'Ceat Ltd' }).length, 1);
  assert.equal(clusterStories(rows.map((r,i) => ({ ...r, content: { ...content, hash: `document-${i}`, facts: facts(i ? 'Different Limited' : 'Target Limited') } })), { company: 'Ceat Ltd' }).length, 2);
  assert.equal(sameContentEvent({ content }, { content: { ...content, hash: 'different', facts: [...facts(), { field: 'conditions', value: 'Subject to approval' }] } }), false);
});

await test('background discovery includes rows beyond email limits and records failed retained-day reads', async () => {
  const extra = Array.from({ length: 20 }, (_, i) => ({ ...assetData['/data/nse-filings/2026-09-23.json'].rows[0], url: `${urls[0]}?source=${i}`, description: `Specific transaction ${i}` }));
  const sources = await readContentSources({ env: { ASSETS: assets({ '/data/nse-filings/2026-09-23.json': { rows: extra } }) }, fetcher: documentFetcher, now, from: now - 86400000 });
  assert.equal(sources.announcements.groups[0].items.length, 20); assert.equal(sources.announcements.more, 0);
  const failed = await readContentSources({ env: { ASSETS: assets({ '/data/nse-filings/2026-09-23.json': null }) }, fetcher: documentFetcher, now, from: now - 86400000 });
  assert.equal(failed.announcements.nseHistory.ok, false); assert.deepEqual(failed.announcements.nseHistory.failedDays, ['2026-09-23']);
});

await test('the durable alarm collects without a browser or an email, then retains pending state through source failure', async () => {
  const s = storage(); let clock = now;
  const store = new NewsletterStore(s, { now: () => clock });
  store.apply([{ op: 'subscribe', email: 'fixture@example.test', by: 'Fixture' }]);
  const schedule = new NewsletterSchedule(s, { ASSETS: assets(), ...envKey }, store, { now: () => clock, fetcher: documentFetcher });
  await schedule.arm(); assert.equal(await s.getAlarm(), now + 60000);
  clock += 60000; await schedule.wake();
  assert.equal(schedule.content.status().ready, 2); assert.equal(store.deliveries().length, 0);
  assert.ok((await s.getAlarm()) > clock); assert.equal(schedule.content.status().reason, 'captured-sources-read');
  const restart = new NewsletterSchedule(s, { ASSETS: assets({ '/data/nse-filings/2026-09-23.json': null }), ...envKey }, store, { now: () => clock, fetcher: documentFetcher });
  clock += 3600000; await restart.wake();
  assert.equal(restart.content.status().ready, 2); assert.equal(restart.content.status().reason, 'partial-source-read');
  assert.equal(store.deliveries().length, 0);
});
console.log(`${passed} source-content checks passed. Model replies are fixtures; live inference quality is not certified.`);
