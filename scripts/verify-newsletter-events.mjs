#!/usr/bin/env node
// Offline contracts for semantic news grouping. Model replies are fixtures, not a live accuracy benchmark.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  EVENT_INSTRUCTIONS, EVENT_REPORT_LIMIT, EVENT_REQUEST_BYTES, EVENT_RESPONSE_BYTES,
  eventCandidates, compatibleReports, parseEventGroups, reviewNewsEvents, relatedNewsReports,
} from '../worker/newsletter-events.mjs';
import { buildBrief, briefStats, briefStories, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { DEFAULT_SETTINGS, istInstant } from '../public/js/data/newsletter-shared.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/newsletter/repeated-news.json', import.meta.url)));
const news = () => ({ groups: [{ ticker: fixture.ticker, company: fixture.company, items: fixture.reports.map((r, i) => ({
  ...r, at: Date.parse(r.publishedAt), summary: '', attribution: 'confirmed', keywords: [], keys: [`source:${i}`, r.url],
})) }] });
const env = { CLAUDE_KEY: 'ABSKfixture-only-key' };
const expectedPartition = reports => [reports.filter(r => r.headline.startsWith('EIL ')).map(r => r.id), reports.filter(r => !r.headline.startsWith('EIL ')).map(r => r.id)];
const answer = groups => Response.json({ content: [{ type: 'text', text: JSON.stringify(groups) }] });
let calls = 0;
const fetcher = async (url, init) => {
  calls++;
  const body = JSON.parse(init.body), { REPORTS } = JSON.parse(body.messages[0].content);
  assert.equal(init.redirect, 'manual');
  assert.equal(body.system[0].text, EVENT_INSTRUCTIONS);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.max_tokens, 4000);
  assert.ok(!JSON.stringify(REPORTS).includes('https://'), 'only source text, no source URLs or document requests');
  assert.equal(REPORTS.length, 5);
  assert.ok(REPORTS.every(r => fixture.reports.some(f => f.headline === r.headline)), 'full original headlines enter the check');
  return answer(expectedPartition(REPORTS));
};
const checked = news(), original = structuredClone(checked);
checked.dedup = await reviewNewsEvents({ news: checked, env, fetcher });
assert.equal(calls, 1);
assert.deepEqual([checked.dedup.reviewed, checked.dedup.combined], [5, 3]);
assert.equal(new Set(checked.groups[0].items.map(r => r.eventId)).size, 2);
const sourceRows = checked.groups[0].items.map(({ eventId, ...row }) => row);
assert.deepEqual(sourceRows, original.groups[0].items, 'only presentation membership changes; all source content and keys survive');

const reports = eventCandidates(news()).reports;
const valid = expectedPartition(reports);
assert.deepEqual(parseEventGroups(JSON.stringify(valid), reports), valid);
for (const bad of [[], [[reports[0].id]], [...valid, [reports[0].id]], [...valid, ['unknown']], { groups: valid }, [reports.map(r => r.id), null]]) {
  assert.equal(parseEventGroups(JSON.stringify(bad), reports), null, 'missing, duplicate, unknown and malformed memberships fail closed');
}
const base = reports[0];
for (const [a, b] of [
  [base, { ...base, ticker: 'OTHER' }], [base, { ...base, related: true }],
  [base, { ...base, at: base.at + 86400001 }], [base, { ...base, at: NaN }],
  [{ ...base, headline: 'Company wins contract worth 2600 crore' }, { ...base, headline: 'Company wins contract worth 3600 crore' }],
  [{ ...base, headline: 'Company approves airport project' }, { ...base, headline: 'Company rejects airport project' }],
  [{ ...base, headline: 'Company grants airport permit' }, { ...base, headline: 'Company revokes airport permit' }],
  [{ ...base, headline: 'Company allows new exports' }, { ...base, headline: 'Company bans new exports' }],
  [{ ...base, headline: 'Company in talks for oil projects' }, { ...base, headline: 'Company signs oil project contract' }],
  [{ ...base, headline: 'Company announces quarterly results', summary: 'Profit 40 crore' }, { ...base, headline: 'Company announces quarterly results', summary: 'Profit 50 crore' }],
]) {
  assert.equal(compatibleReports(a, b), false);
  assert.equal(parseEventGroups('[["a","b"]]', [{ ...a, id: 'a' }, { ...b, id: 'b' }]), null);
}
// A-B and B-C time proximity cannot silently join A-C outside the event window.
const chain = [0, 12, 25].map((hours, i) => ({ ...base, id: String(i), at: base.at + hours * 3600000 }));
assert.equal(parseEventGroups('[["0","1","2"]]', chain), null);
const asStory = (r, extra = {}) => ({ ...r, kind: 'news', source: r.source, dek: r.summary, ...extra });
assert.equal(relatedNewsReports(asStory(base), asStory(base, { source: 'Another publisher' })), true);
assert.equal(relatedNewsReports(asStory(base, { eventId: 'a' }), asStory(base, { eventId: 'b', source: 'Another publisher' })), false, 'reviewed singletons override identical headlines');
assert.equal(relatedNewsReports(asStory(base), asStory(base, { kind: 'filing' })), false);
assert.equal(relatedNewsReports(asStory(base), asStory(base, { source: 'Another publisher', headline: 'EIL signs an oil infrastructure deal in Saudi Arabia and UAE' })), false, 'no fuzzy grouping on failure');

for (const [reply, reason] of [
  [async () => new Response('', { status: 429 }), 'rate-limited'],
  [async () => new Response('', { status: 503 }), 'upstream'],
  [async () => answer([['unknown']]), 'unreadable'],
  [async () => new Response('x'.repeat(EVENT_RESPONSE_BYTES + 1)), 'unreadable'],
  [async () => { throw new DOMException('deadline', 'TimeoutError'); }, 'timeout'],
]) {
  const input = structuredClone(checked);
  const state = await reviewNewsEvents({ news: input, env, fetcher: reply });
  assert.equal(state.reason, reason);
  assert.ok(input.groups[0].items.every(r => !r.eventId), 'failure cannot keep stale group membership');
  assert.deepEqual(input.groups[0].items, original.groups[0].items);
}
const forbidden = async () => { throw new Error('must not call'); };
assert.equal((await reviewNewsEvents({ news: news(), env, fetcher: forbidden, enabled: false })).reason, 'preview');
assert.equal((await reviewNewsEvents({ news: news(), env: {}, fetcher: forbidden })).reason, 'not-configured');
assert.equal((await reviewNewsEvents({ news: { groups: [] }, env, fetcher: forbidden })).reason, 'nothing-to-check');
const tooMany = news();
tooMany.groups[0].items = Array.from({ length: EVENT_REPORT_LIMIT + 1 }, () => ({ ...tooMany.groups[0].items[0] }));
assert.equal((await reviewNewsEvents({ news: tooMany, env, fetcher: forbidden })).reason, 'limit');
const tooLong = news();
tooLong.groups[0].items[0].summary = 'अ'.repeat(EVENT_REQUEST_BYTES);
assert.equal(eventCandidates(tooLong).reports.length, 0, 'UTF-8 budget excludes whole company instead of clipping away qualifications');
tooLong.groups.push({ ...news().groups[0], ticker: 'SECOND' });
assert.equal(eventCandidates(tooLong).reports.length, 5, 'an oversized company does not starve a later one');
const partial = await reviewNewsEvents({ news: tooLong, env, fetcher: async (url, init) => answer(JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS.map(r => [r.id])) });
assert.equal(partial.partial, true);
assert.equal(partial.reviewed, 5);
assert.equal(partial.eligible, 10);
const longReports = news();
for (const r of longReports.groups[0].items) r.summary = '&'.repeat(3500);
assert.ok(JSON.stringify(longReports).length < EVENT_REQUEST_BYTES, 'raw model input alone would fit');
assert.equal((await reviewNewsEvents({ news: longReports, env, fetcher: forbidden })).reason, 'limit', 'HTML escaping and cumulative source size prevent oversized semantic groups');

// Exercise each deployment's actual company grouping, rendering and delivery identities.
const ASSETS = { fetch: async request => new URL(request.url).pathname === '/data/portfolio-companies.json'
  ? Response.json({ count: 1, asOf: '2026-09-21', holdings: [{ ticker: fixture.ticker, name: fixture.company }] })
  : new Response('', { status: 404 }) };
const brief = await buildBrief({ edition: 'morning', day: '2026-09-21', settings: DEFAULT_SETTINGS,
  env: { ASSETS }, now: istInstant('2026-09-21', '08:00'), includeAi: false, fetcher: async () => new Response('', { status: 503 }) });
brief.news = { ...brief.news, ...checked, count: 5, more: 0 };
const stats = briefStats(brief);
assert.equal(stats.stories, 5);
assert.equal(stats.updates, 2, 'four Gulf opportunity reports are one update; order book stays separate');
assert.deepEqual(briefStats(JSON.parse(JSON.stringify(brief))), stats, 'stored/restarted editions reproduce the same memberships and IDs');
assert.equal(stats.companies[0].clusters.find(c => c.main.headline.startsWith('EIL ')).others.length, 3);
assert.equal(new Set(briefStories(brief).flatMap(r => r.keys)).size, 10, 'every source identity remains available to the delivered-story ledger');
const html = renderBriefHtml(brief), text = renderBriefText(brief);
for (const r of fixture.reports) {
  assert.ok(html.includes(r.headline));
  assert.ok(text.includes(r.headline));
  assert.ok(html.includes(r.url));
  assert.ok(text.includes(r.url));
}
assert.ok(html.includes('3 repeat reports combined'));
const out = process.env.NEWSLETTER_EVENT_OUTPUT;
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/repeated-news.html`, html); }
if (existsSync(new URL('../worker/newsletter-pdf.mjs', import.meta.url))) {
  const { renderBriefPdf } = await import('../worker/newsletter-pdf.mjs');
  const { renderBriefEmails } = await import('../worker/newsletter-email.mjs');
  const pdf = renderBriefPdf(brief), pdfText = new TextDecoder().decode(pdf);
  for (const r of fixture.reports) assert.ok(pdfText.includes(r.url));
  const emails = renderBriefEmails(brief);
  assert.equal(new Set(emails.flatMap(e => e.keys)).size, 10);
  const busy = structuredClone(brief);
  busy.news.groups = Array.from({ length: 24 }, (_, i) => ({ ...structuredClone(checked.groups[0]), ticker: `COMPANY${i}`, company: `Company ${i}`,
    items: checked.groups[0].items.map(r => ({ ...r, keys: r.keys.map(key => `${i}:${key}`) })) }));
  busy.book.listed = 24;
  const parts = renderBriefEmails(busy);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.bytes <= 90000));
  assert.equal(new Set(parts.flatMap(p => p.keys)).size, 240, 'semantic grouping also preserves every source across multiple email parts');
  const longBrief = structuredClone(brief);
  longBrief.news.groups = longReports.groups;
  const longParts = renderBriefEmails(longBrief);
  assert.ok(longParts.length > 1, 'long reports remain separable into safe email parts');
  assert.ok(longParts.every(p => p.bytes <= 90000));
  assert.equal(new Set(longParts.flatMap(p => p.keys)).size, 10);
  if (out) writeFileSync(`${out}/repeated-news.pdf`, pdf);
}
console.log('PASS repeated-news partition, source retention, safety guards, failure/preview/budget handling, rendered email and saved edition');
