#!/usr/bin/env node
// Offline evidence-selection and output checks. Model answers are fixtures, not live evaluations.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { priceReasonWindow, priceEvidenceItems, attachPriceReasons, parsePriceReasons, priceReasonText,
  PRICE_REASON_BYTES, PRICE_REASON_SOURCES } from '../worker/newsletter-price-reasons.mjs';
import { attachContent } from '../worker/newsletter-content.mjs';
import { buildBrief, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { renderBriefEmails, EMAIL_HTML_BYTES } from '../worker/newsletter-email.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';

const day = '2026-09-23', at = time => istInstant(day, time), now = at('18:00');
const env = { CLAUDE_KEY: 'ABSKpricefixture123' };
const forbid = async () => { throw Error('Unexpected paid/network request'); };
const fact = quote => ({ field: 'event', value: quote, quote, location: 'paragraph 1' });
const quote = 'Alpha Industries shares rose on September 23 after it won a Rs 100 crore contract, the report said.';
const link = 'https://www.moneycontrol.com/news/business/stocks/alpha-contract.html';
const reading = (facts = [fact(quote)], state = 'ready') => ({ state, sourceUrl: link, facts, checkedAt: now });
const story = (overrides = {}) => ({ ticker: 'ALPHA', headline: 'Alpha Industries wins contract', summary: '', at: at('12:00'),
  url: link, keys: [link], publisher: 'Fixture News', keywords: [], keywordIds: [], keywordGroups: [], attribution: 'confirmed', content: reading(), ...overrides });
const groups = rows => [...new Set(rows.map(r => r.ticker))].map(ticker => ({ ticker, company: `${ticker} Industries`, items: rows.filter(r => r.ticker === ticker) }));
const context = (rows = [story()]) => ({ window: priceReasonWindow(day, at('15:59')),
  announcements: { groups: [], nse: { ok: true, readAt: now }, nseHistory: { ok: true }, bse: { ok: true } },
  news: { groups: groups(rows), source: { ok: true }, tradingview: { ok: true } } });
const brief = (tickers = ['ALPHA']) => ({ moves: { session: day, groups: groups(tickers.map(ticker => ({ ticker, pct: 6.6, at: at('15:59') }))) } });
const move = b => b.moves.groups[0].items[0];
const reply = entries => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(entries) }] });
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };

await test('timing follows the observed session, previous trading close and intraday cutoff', () => {
  assert.deepEqual(priceReasonWindow(day, at('15:59')), { from: istInstant('2026-09-22', '15:30'), to: at('15:30') });
  assert.equal(priceReasonWindow(day, at('11:00')).to, at('11:00'));
  assert.equal(priceReasonWindow('2026-09-21', istInstant('2026-09-21', '15:30')).from, istInstant('2026-09-18', '15:30'));
  assert.equal(priceReasonWindow('2026-09-15', istInstant('2026-09-15', '15:30')).from, istInstant('2026-09-11', '15:30'), 'exchange holiday');
  assert.equal(priceReasonWindow(day, istInstant('2026-09-24', '08:00')), null);
  assert.equal(priceReasonWindow('2027-01-04', istInstant('2027-01-04', '15:30')), null, 'unknown calendars cannot quietly set a cutoff');
  const rows = [story(), story({ at: at('15:31') }), story({ at: istInstant('2026-09-22', '15:30') }),
    story({ dayOnly: true }), story({ attribution: 'related' }), story({ ticker: 'OTHER' }), story({ at: NaN })];
  assert.equal(priceEvidenceItems(context(rows), brief().moves).length, 1);
});

await test('a supported explanation keeps its source, literal support and AI attribution', async () => {
  const b = brief(); let asked;
  const result = await attachPriceReasons({ brief: b, context: context(), env, now, fetcher: async (_, init) => {
    asked = JSON.parse(JSON.parse(init.body).messages[0].content).PRICE_MOVES;
    return reply([{ id: 'ALPHA', status: 'reported', reason: 'The report linked the rise to a Rs 100 crore contract win.', sourceId: 's0', factIndexes: [0] }]);
  } });
  assert.equal(result.answered, 1); assert.equal(move(b).why.state, 'reported');
  assert.equal(move(b).why.source.url, link); assert.deepEqual(move(b).why.support, [fact(quote)]);
  assert.match(priceReasonText(move(b).why), /Reported reason \(AI\)/);
  assert.equal(asked[0].window.to, at('15:30')); assert.equal(asked[0].SOURCE_EVIDENCE[0].facts[0].quote, quote);
  for (const bad of [{ sourceId: 'invented' }, { factIndexes: [999] }, { id: 'OTHER' }, { reason: 'x'.repeat(241) }]) {
    const parsed = parsePriceReasons(JSON.stringify([{ id: 'ALPHA', status: 'reported', reason: 'A contract win.', sourceId: 's0', factIndexes: [0], ...bad }]), asked);
    assert.equal(parsed.size, 0);
  }
  const opposite = structuredClone(asked); opposite[0].pct = -6;
  assert.equal(parsePriceReasons(JSON.stringify([{ id: 'ALPHA', status: 'reported', reason: 'A contract win.', sourceId: 's0', factIndexes: [0] }]), opposite).size, 0);
  const filing = structuredClone(asked); filing[0].SOURCE_EVIDENCE[0].kind = 'filing';
  assert.equal(parsePriceReasons(JSON.stringify([{ id: 'ALPHA', status: 'reported', reason: 'A contract win.', sourceId: 's0', factIndexes: [0] }]), filing).size, 0);
});

await test('inference stays unconfirmed and a falling stock can have an explicitly reported reason', async () => {
  for (const [pct, text, status] of [[6, 'Alpha won a contract subject to customer approval.', 'possible'],
    [-6, 'Alpha Industries shares fell on September 23 after a plant closure was announced.', 'reported']]) {
    const b = brief(); move(b).pct = pct;
    await attachPriceReasons({ brief: b, context: context([story({ content: reading([fact(text)]) })]), env, now,
      fetcher: async () => reply([{ id: 'ALPHA', status, reason: text, sourceId: 's0', factIndexes: [0] }]) });
    assert.equal(move(b).why.state, status);
    assert.match(priceReasonText(move(b).why), status === 'possible' ? /unconfirmed/ : /Reported reason/);
  }
});

await test('absent, unread, partial, failed and preview evidence remain distinct', async () => {
  for (const [ctx, enabled, suppliedEnv, expected] of [
    [context([]), true, env, 'no-evidence'], [context([story({ content: { state: 'pending' } })]), true, env, 'content-pending'],
    [context(), false, env, 'preview'], [context(), true, {}, 'no-key']]) {
    const b = brief(); await attachPriceReasons({ brief: b, context: ctx, env: suppliedEnv, enabled, fetcher: forbid, now });
    assert.equal(move(b).why.reason, expected);
    assert.ok(priceReasonText(move(b).why));
  }
  const b = brief(), ctx = context([story({ content: reading([fact(quote)], 'partial') })]);
  ctx.news.source.ok = false;
  await attachPriceReasons({ brief: b, context: ctx, env, now, fetcher: async () => reply([{ id: 'ALPHA', status: 'unknown' }]) });
  assert.match(priceReasonText(move(b).why), /No verified reason.*coverage is incomplete/);
  assert.equal(move(b).why.coverage.partial, 1);
  for (const response of [new Response('private details', { status: 403 }), reply([{ id: 'ALPHA', status: 'possible', reason: 'Unsupported', sourceId: 'absent', factIndexes: [0] }]),
    Response.json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '[]' }] })]) {
    const failed = brief(); await attachPriceReasons({ brief: failed, context: context(), env, now, fetcher: async () => response });
    assert.equal(move(failed).why.state, 'unavailable'); assert.doesNotMatch(JSON.stringify(failed), /private details|Unsupported/);
  }
});

await test('whole-source budgets disclose omissions and prioritize explicit movement reports', async () => {
  const b = brief(); let supplied;
  const rows = Array.from({ length: 30 }, (_, i) => story({ url: `${link}?${i}`, at: at('12:00') + i,
    content: reading([fact(i ? 'Routine facts '.repeat(900) : quote)]) }));
  const result = await attachPriceReasons({ brief: b, context: context(rows), env, now, fetcher: async (_, init) => {
    supplied = JSON.parse(JSON.parse(init.body).messages[0].content).PRICE_MOVES;
    return reply([{ id: 'ALPHA', status: 'unknown' }]);
  } });
  assert.equal(result.requested, 1);
  assert.ok(new TextEncoder().encode(JSON.stringify(supplied)).length <= PRICE_REASON_BYTES);
  assert.ok(supplied[0].SOURCE_EVIDENCE.length <= PRICE_REASON_SOURCES);
  assert.equal(supplied[0].SOURCE_EVIDENCE[0].facts[0].quote, quote);
  assert.ok(move(b).why.coverage.omitted > 0); assert.match(priceReasonText(move(b).why), /incomplete/);
});

await test('overlapping newsletter and price evidence share one extraction job and budget', async () => {
  const original = context(), copy = context(); let jobs, processed = 0;
  await attachContent(original, { extraItems: priceEvidenceItems(copy, brief().moves), service: {
    enqueue(j) { jobs = j; }, async process() { processed++; }, get() { return reading(); },
  }, env, now });
  assert.equal(jobs.length, 1); assert.equal(processed, 1);
  assert.strictEqual(original.news.groups[0].items[0].content, copy.news.groups[0].items[0].content);
});

const holdings = [{ ticker: 'ALPHA', name: 'Alpha Industries' }, { ticker: 'BETA', name: 'Beta Industries' }];
const captures = {
  '/data/portfolio-companies.json': { holdings, count: 2 },
  '/data/nse-filings/index.json': { days: [], capturedAt: new Date(now).toISOString() },
  '/data/corp-announcements.json': { byTicker: {}, capturedAt: new Date(now).toISOString() },
  '/data/market-news.json': { articles: [{ title: 'Alpha Industries shares gain on contract win', url: link,
    publishedAt: new Date(at('12:00')).toISOString(), publisher: 'Fixture News' }] },
  '/data/tradingview-news/latest.json': { byTicker: {} },
  '/data/technicals.json': { price_date: day, generated_at: new Date(now).toISOString(),
    rows: holdings.map(h => ({ ticker: h.ticker, cmp: 106.6, pct_change_today: 6.6 })) },
};
const assets = { fetch: async req => { const data = captures[new URL(req.url).pathname]; return data ? Response.json(data) : new Response('', { status: 404 }); } };
const service = { enqueue() {}, async process() {}, get() { return reading(); } };
let priceRequests = 0;
const fetcher = async (url, init) => {
  if (String(url).includes('bedrock-runtime')) {
    const body = JSON.parse(JSON.parse(init.body).messages[0].content);
    if (body.PRICE_MOVES) { priceRequests++; return reply(body.PRICE_MOVES.map(i => ({ id: i.id, status: 'reported',
      reason: 'The report linked the rise to a Rs 100 crore contract win.', sourceId: 's0', factIndexes: [0] }))); }
    return reply([]);
  }
  if (String(url).includes('rss')) return new Response('<rss><channel></channel></rss>');
  throw Error('Fixture source unavailable');
};
let full;
await test('a relevant source beyond the email company cap still reaches the price assessment', async () => {
  const original = captures['/data/market-news.json'];
  const jobs = new Map();
  captures['/data/market-news.json'] = { articles: [...original.articles, ...Array.from({ length: 10 }, (_, i) => ({
    title: `Alpha Industries wins contract number ${i + 1}`, url: `${link}?new=${i}`, publishedAt: new Date(at('14:00') + i).toISOString(), publisher: 'Fixture News',
  }))] };
  try {
    const b = await buildBrief({ edition: 'evening', day, now, settings: DEFAULT_SETTINGS, env: { ...env, ASSETS: assets }, fetcher,
      contentService: { enqueue(list) { for (const j of list) jobs.set(j.id, j); }, async process() {},
        get(id) { return jobs.get(id)?.url === link ? reading() : { state: 'pending', reason: 'queued' }; } } });
    assert.equal(b.news.groups[0].items.length, 8);
    assert.ok(!b.news.groups[0].items.some(r => r.url === link), 'the older report is outside the displayed eight stories');
    assert.equal(move(b).why.state, 'reported'); assert.equal(move(b).why.source.url, link);
    assert.equal(move(b).why.coverage.candidates, 11); assert.equal(move(b).why.coverage.pending, 10);
  } finally { captures['/data/market-news.json'] = original; priceRequests = 0; }
});

await test('morning price-only cards reuse prior-session evidence already sent in an earlier brief', async () => {
  full = await buildBrief({ edition: 'morning', day: '2026-09-24', now: istInstant('2026-09-24', '08:00'), settings: DEFAULT_SETTINGS,
    env: { ...env, ASSETS: assets }, fetcher, contentService: service,
    reported: { empty: false, since: istInstant('2026-09-22'), has: key => key.startsWith('news:') } });
  assert.equal(full.news.groups.length, 0, 'sent story is not repeated as a newsletter story');
  assert.equal(full.moves.groups.length, 2); assert.equal(move(full).why.state, 'reported');
  assert.equal(move(full).why.source.at, at('12:00'));
  assert.equal(full.moves.groups[1].items[0].why.reason, 'no-evidence');
  assert.equal(priceRequests, 1);
  const preview = await buildBrief({ edition: 'morning', day: '2026-09-24', now: istInstant('2026-09-24', '08:00'), settings: DEFAULT_SETTINGS,
    env: { ...env, ASSETS: assets }, fetcher, contentService: service, includeAi: false,
    reported: { empty: false, since: istInstant('2026-09-22'), has: key => key.startsWith('news:') } });
  assert.equal(priceRequests, 1); assert.match(renderBriefHtml(preview), /preview does not run AI/);
});

await test('HTML, text, PDF and split emails retain the reason, source link and unknown fallback', () => {
  const html = renderBriefHtml(full), text = renderBriefText(full), pdf = renderBriefPdf(full);
  for (const output of [html, text, new TextDecoder().decode(pdf)]) {
    assert.match(output, /Why it moved/); assert.match(output, /Rs 100 crore contract win/);
    assert.ok(output.includes(link)); assert.match(output, /No verified reason found/);
  }
  const parts = renderBriefEmails(full);
  assert.ok(parts.every(p => p.bytes <= EMAIL_HTML_BYTES));
  assert.equal(parts.map(p => p.html).join('').match(/Why it moved:/g).length, 2);
  const unsafe = structuredClone(full); move(unsafe).why.text = '<script>alert(1)</script>';
  assert.ok(!renderBriefHtml(unsafe).includes('<script>alert(1)</script>'));
  if (process.env.PRICE_REASON_PREVIEW_DIR) {
    mkdirSync(process.env.PRICE_REASON_PREVIEW_DIR, { recursive: true });
    writeFileSync(`${process.env.PRICE_REASON_PREVIEW_DIR}/price-reasons.html`, html);
    writeFileSync(`${process.env.PRICE_REASON_PREVIEW_DIR}/price-reasons.pdf`, pdf);
  }
});

console.log(`${passed} price-reason checks passed. Model answers are fixtures; live inference quality is not certified.`);
