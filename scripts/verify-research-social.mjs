#!/usr/bin/env node
// Real browser adapters over isolated public-post fixtures; no production or model calls.
import assert from 'node:assert/strict';
import { telegramCompanyRows, postExcerpt, chatterPostEvidence } from '../public/js/research/social.js';
import { researchLocalBrowser } from './lib/research-local-browser.mjs';
import { providerEvidence } from '../public/js/research/evidence-shared.js';
import { validateResearchBody } from '../worker/research.mjs';

const identities = [
  { ticker: 'BIGCO', name: 'Big Company Ltd', isin: 'INE000000001' },
  { ticker: 'TINYCO', name: 'Tiny Company Ltd', isin: 'INE000000002' },
  { ticker: null, name: 'Unlisted Ventures Ltd', isin: 'INE000000003' },
  { ticker: 'SAIL', name: 'Steel Authority of India Ltd' },
  { ticker: 'VEDL', name: 'Vedanta Ltd' }, { ticker: null, name: 'Vedanta Iron and Steel Ltd', isin: 'INE000000004' },
];
const resolved = telegramCompanyRows([
  { id: 1, text: 'Big Company and Tiny Company have unverified broker commentary.' },
  { id: 2, text: 'Unlisted Ventures discusses expansion.' },
  { id: 3, text: 'SAIL into the future. Big opportunity. TINYCOUS is different.' },
  { id: 4, text: 'NSE:SAIL is discussed here.' },
  { id: 5, text: 'Vedanta Iron and Steel releases a note.' },
  { id: 6, text: null, attachments: [{ name: 'Tiny Company.pdf' }] },
], identities);
assert.deepEqual(resolved.filter(r => r.id === 1).map(r => r.ticker), ['BIGCO', 'TINYCO']);
assert.equal(resolved.find(r => r.id === 2).isin, 'INE000000003');
assert(!resolved.some(r => r.id === 3), 'English words, partial names and embedded symbols cannot assign a company');
assert.equal(resolved.find(r => r.id === 4).ticker, 'SAIL');
assert.deepEqual(resolved.filter(r => r.id === 5).map(r => r.isin), ['INE000000004'], 'a longer issuer name cannot become the parent');
assert.equal(resolved.find(r => r.id === 6).ticker, 'TINYCO');
const excerpt = postExcerpt('Earlier unrelated discussion. '.repeat(100) + 'Tiny Company: exact late evidence.', [null, 'Tiny Company']);
assert(excerpt.text.includes('exact late evidence') && excerpt.textTruncated);

const requested = [];
const topics = identities.slice(0, 2).flatMap((c, i) => Array.from({ length: i ? 1 : 10 }, (_, n) => ({ ticker: c.ticker, slug: `${c.ticker}-${n}`, mentions: 100 - n })));
await chatterPostEvidence({ postsFor: async slug => { requested.push(slug); }, loadedPosts: () => [] }, topics,
  { companies: identities.slice(0, 2), tickers: new Set(['BIGCO', 'TINYCO']), tokens: [] });
assert.equal(requested.length, 6);
assert(requested.slice(0, 2).some(slug => slug.startsWith('TINYCO')), 'large-issuer topics do not crowd out the small holding');
const slowStarted = performance.now();
const slow = await chatterPostEvidence({ postsFor: () => new Promise(() => {}), loadedPosts: () => [] }, topics.slice(0, 1),
  { companies: [], tickers: new Set(), tokens: [] });
assert.equal(slow.failures, 1);
assert(performance.now() - slowStarted < 2500, 'an already-running slow popup request cannot hold up research');

const at = '2026-09-06T08:00:00.000Z';
let capture = { channel: 'researchreportss', capturedAt: at, lastCheckedAt: at, historyComplete: false,
  lastRun: { status: 'ok', at }, posts: [
    { id: 20, text: 'Jayaswal NECO Industries: unverified broker discussion. Read the original.', publishedAt: at },
    { id: 19, text: 'IIFL Finance: discussion about credit demand.', publishedAt: at },
    { id: 18, text: null, publishedAt: at, mediaType: 'document', attachments: [{ type: 'document', name: 'Jayaswal NECO Industries research.pdf' }] },
    { id: 17, text: 'JAYNECOIND: undated channel message.' },
    { id: 16, text: null, publishedAt: at },
    { id: 15, text: 'A completely unrelated issuer has a broker report.', publishedAt: at },
  ] };
let failTelegram = false, failPosts = false, wrongTopic = false;
const postReads = [];
const { page, close } = await researchLocalBrowser({ intercept: async (route, url) => {
  const json = async (body, status = 200) => { await route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }); return true; };
  if (url.pathname === '/data/telegram-posts.json' || url.pathname === '/api/telegram/posts') return json(failTelegram ? { error: 'fixture outage' } : capture, failTelegram ? 503 : 200);
  if (url.pathname === '/v1/dashboard') return json({ generatedAt: at, window: '30d', stocks: [
    { ticker: 'jaynecoind', name: 'Jayaswal Neco Industries', mentions: 30, changePct: 200, sentiment: { label: 'neutral' } },
    { ticker: 'stltech', name: 'Sterlite Technologies', mentions: 5 },
    { ticker: 'iifl', name: 'IIFL Finance', mentions: 3 },
    { ticker: 'fiis', name: 'FIIs', mentions: 100 },
  ] });
  if (url.pathname === '/v1/health') return json({ status: 'ok', data: { ageSeconds: 30 } });
  if (url.pathname.includes('/posts') && url.pathname.startsWith('/v1/stocks/')) {
    const slug = url.pathname.split('/')[3]; postReads.push(slug);
    return json(failPosts ? { error: 'fixture outage' } : { ticker: wrongTopic ? 'wrong-company' : slug, generatedAt: at,
      counts: { total: 2, filtered: 1 }, posts: [{ id: `post-${slug}`, ticker: slug, source: 'valuepickr', timestamp: at,
        text: `Literal ${slug} forum text. ${'Discussion context. '.repeat(15)}No independent confirmation.`, url: `https://forum.valuepickr.com/t/${slug}/123?reference=${'a'.repeat(220)}` }] }, failPosts ? 503 : 200);
  }
  return false;
} });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const build = question => page.evaluate(question => research.buildResearchEvidence({ question, scope: 'portfolio', prepared }), question);
  const packet = await build('What are Telegram and public chatter saying about Jayaswal Neco?');
  const tg = packet.sources.find(s => s.id === 'telegram');
  const posts = packet.sources.find(s => s.id === 'chatter-posts');
  const summary = packet.sources.find(s => s.id === 'public-chatter');
  assert(tg.rows.length > 0 && tg.rows.every(r => r.ticker === 'JAYNECOIND'));
  assert.equal(tg.dataQuality, 'partial');
  assert.match(tg.note, /history incomplete/);
  const documentPacket = await build('Show Telegram PDF attachments for Jayaswal Neco');
  assert(documentPacket.sources.find(s => s.id === 'telegram').rows.some(r => r.messageId === 18 && r.attachments[0].name.endsWith('.pdf')), 'document names are searchable without claiming PDF contents');
  const undatedPacket = await build('Show undated Telegram messages for JAYNECOIND');
  const undated = undatedPacket.sources.find(s => s.id === 'telegram').rows.find(r => r.messageId === 17);
  assert(undated && !undated.publishedAt, 'undated messages must not receive collection time as publication time');
  assert(tg.rows.every(r => r.url.startsWith('https://t.me/researchreportss/')));
  assert.deepEqual(postReads, ['jaynecoind'], 'named-company question fetches its posts without visiting the tab or unrelated topics');
  assert(posts.rows.some(r => r.text.includes('No independent confirmation.') && r.url.includes('valuepickr')));
  assert.equal(posts.rows[0].url, `https://forum.valuepickr.com/t/jaynecoind/123?reference=${'a'.repeat(220)}`, 'long source links remain exact');
  assert(summary.rows.some(r => r.mentionCountChangePct === 200));
  assert.match(summary.definition, /not a price return/);
  assert.match(posts.definition, /Unverified/);
  assert.equal(providerEvidence(packet).sources.find(s => s.id === 'telegram').rows.length, tg.rows.length);
  assert(validateResearchBody({ question: 'Summarise available evidence.', evidence: packet }).ok);
  await build('Any new Telegram updates on Jayaswal Neco?');
  assert.equal(postReads.length, 1, 'warm repeated question reuses recent post read');
  const generic = await build('What is the latest info on jayaswal neco for me?');
  for (const id of ['telegram', 'chatter-posts']) assert(generic.sources.find(s => s.id === id).rows.length, `${id} is retrieved even when the question does not name that source`);

  const next = await build('What is public chatter saying about IIFL Finance?');
  const nextRows = next.sources.find(s => s.id === 'chatter-posts').rows;
  assert(nextRows.length && nextRows.every(r => r.ticker === 'IIFL'));
  assert.deepEqual(postReads, ['jaynecoind', 'iifl']);
  const outside = await build('What is public chatter saying about Sterlite Technologies?');
  assert.equal(outside.sources.find(s => s.id === 'chatter-posts').rows.length, 0);
  assert(!postReads.includes('stltech'), 'a topic outside the saved portfolio cannot leak into portfolio evidence');
  const empty = await page.evaluate(() => research.buildResearchEvidence({ question: 'What are Telegram and public chatter saying?', scope: 'watchlist', prepared }));
  assert.equal(empty.sources.find(s => s.id === 'telegram').rows.length, 0);
  assert.equal(empty.sources.find(s => s.id === 'chatter-posts').rows.length, 0);

  // Force a stale cache, then fail a fresh read. Prior text survives with partial status.
  await page.evaluate(async () => { for (const group of (await import('/js/data/chatter-live.js')).loadedPosts()) group.checkedAt = '2020-01-01T00:00:00Z'; });
  failPosts = true;
  const partial = (await build('Latest chatter on Jayaswal Neco?')).sources.find(s => s.id === 'chatter-posts');
  assert.equal(partial.dataQuality, 'partial'); assert(partial.rows.length); assert.match(partial.note, /failed/);
  failPosts = false; wrongTopic = true;
  const wrong = (await build('Latest chatter on Jayaswal Neco?')).sources.find(s => s.id === 'chatter-posts');
  assert.equal(wrong.dataQuality, 'partial'); assert(!JSON.stringify(wrong).includes('wrong-company'));
  wrongTopic = false;
  const recovered = (await build('Latest chatter on Jayaswal Neco?')).sources.find(s => s.id === 'chatter-posts');
  assert.equal(recovered.dataQuality, 'source-reported');

  capture = { ...capture, lastCheckedAt: '2026-09-06T09:00:00Z', lastRun: { status: 'ok', at: '2026-09-06T09:00:00Z' },
    posts: [{ id: 21, text: 'JAYNECOIND: new captured message after the initial question.', publishedAt: '2026-09-06T08:30:00Z' }, ...capture.posts] };
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  assert.equal((await build('Any new Telegram updates on Jayaswal Neco?')).sources.find(s => s.id === 'telegram').rows[0].messageId, 21);
  failTelegram = true;
  await page.evaluate(async () => (await import('/js/data/telegram-posts.js')).refresh());
  const retained = (await build('Any new Telegram updates on Jayaswal Neco?')).sources.find(s => s.id === 'telegram');
  assert.equal(retained.dataQuality, 'partial'); assert(retained.rows.some(r => r.messageId === 21));
  assert(retained.asOf.startsWith('2026-09-06T09:00'), 'failed browser read cannot advance the source check time');
  assert.deepEqual(errors, []);
  console.log('PASS: Telegram and Public Chatter reach the provider packet; issuer isolation, small holdings, tickerless names, citations, excerpts, dates, incomplete history, warm reuse, fresh arrivals, failed reads and recovery.');
} finally { await close(); }
