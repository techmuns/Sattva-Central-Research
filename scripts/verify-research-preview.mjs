import assert from 'node:assert/strict';
import { researchPreview } from '../public/js/research/preview.js';
import { researchHistory } from '../public/js/research/history.js';

const company = { ticker: 'JAYNECOIND', isin: 'INE854B01010', name: 'Jayaswal Neco' };
const source = (id, rows, extra = {}) => ({ id, tab: 'News', status: 'ready', asOf: '2026-09-06', rows, ...extra });
const confirmed = { ticker: company.ticker, attribution: 'confirmed', date: '2026-09-04', title: 'Company statement' };
const preview = researchPreview({ selection: { companies: [company] }, sources: [
  source('company-news', [confirmed, { ...confirmed, attribution: 'related', title: 'Related entity' },
    { ...confirmed, ticker: 'IIFL', title: 'Another company' },
    { ...confirmed, isin: 'DIFFERENT', title: 'Conflicting identity' },
    { ...confirmed, recordType: 'reference-page', title: 'Share price page' },
    { ...confirmed, attribution: undefined, title: 'Unverified attribution' }], { dataQuality: 'partial' }),
  source('daily-alerts', [{ ...confirmed, headline: confirmed.title }]),
  source('announcements', [{ ticker: company.ticker, title: 'Board meeting scheduled for 9 September', date: '2026-09-05' }]),
  source('company-filings', [{ ticker: company.ticker, title: 'Quarterly presentation', period: 'Jun 2026' }], { status: 'unavailable' }),
] });
assert.deepEqual(preview.items.map(item => item.title), ['Board meeting scheduled for 9 September', 'Company statement']);
assert.equal(preview.items[1].quality, 'partial');
assert.equal(preview.items[1].date, '2026-09-04');
assert.equal(preview.sources.at(-1).status, 'unavailable');
assert.equal(preview.sources.at(-1).asOf, '2026-09-06');
assert.equal(preview.sources.length, 4, 'partial and unavailable sources remain explicit');

const unresolved = { isin: 'INE000000001', ticker: null, name: 'Tickerless holding' };
assert.equal(researchPreview({ selection: { companies: [unresolved] }, sources: [source('company-news', [
  { isin: unresolved.isin, attribution: 'confirmed', title: '<img src=x onerror=alert(1)>', date: null },
])] }).items[0].company, unresolved.name, 'ISIN-only companies remain eligible; renderer must treat title as text');
assert.equal(researchPreview({ selection: { companies: [unresolved] }, sources: [source('company-news', [confirmed])] }).items.length, 0);
assert.equal(researchPreview({ sources: [source('announcements', Array.from({ length: 20 }, (_, i) => ({ ticker: `TEST${i}`, title: `Title ${i}` })))] }).items.length, 3, 'preview is bounded, not a completeness claim');

const hexaware = { ticker: 'HEXT', name: 'Hexaware Technologies', inScope: false };
const report = 'JM Financial sees 11% UPSIDE in Hexaware Technologies- Vivek Jetley to take over as CEO';
const reportUrl = 'https://t.me/researchreportss/102825';
const social = researchPreview({ selection: { companies: [hexaware], topics: ['leadership'],
  window: { start: '2026-07-09', end: '2026-09-06' } }, sources: [
  source('announcements', [{ ticker: 'HEXT', date: '2026-09-06', title: 'Quarterly investor presentation' }]),
  source('telegram', [{ ticker: 'HEXT', text: report, publishedAt: '2026-09-04T10:46:00Z', url: reportUrl },
    { ticker: 'OTHER', text: 'Another company appointed a CEO', publishedAt: '2026-09-06' }], {
    tab: 'Telegram', source: 'Telegram public channel @researchreportss', dataQuality: 'partial',
  }),
  source('chatter-posts', [{ ticker: 'HEXT', text: 'The proposed CEO appointment remains subject to approval.', date: '2026-09-05', url: 'https://forum.valuepickr.com/t/hexaware/123/456' }], { tab: 'Public Chatter posts' }),
  source('daily-alerts', [{ ticker: 'HEXT', headline: report, date: '2026-09-04', url: reportUrl }]),
] });
assert.deepEqual(social.items.map(item => item.title), ['The proposed CEO appointment remains subject to approval.', report, 'Quarterly investor presentation'],
  'a directly relevant report precedes newer unrelated announcements and survives outside the display scope');
assert.equal(social.items[1].date, '2026-09-04', 'publication time supplies the date, not the later source check');
assert.equal(social.items[1].url, reportUrl, 'the exact original message remains accessible before inference');
assert.equal(social.items[1].inScope, false, 'preview source citations retain the explicit company scope override');
assert.equal(social.items[1].publisher, 'Telegram public channel @researchreportss');
assert.equal(social.items[1].attribution, 'Unverified discussion excerpt', 'a literal CEO report is not presented as confirmation');
assert.equal(social.items[1].quality, 'partial', 'claim verification and collection completeness are separate');
assert.equal(social.items[1].kind, 'excerpt');
assert.equal(social.items[1].truncated, false);
assert.equal(social.items.filter(item => item.title === report).length, 1, 'All Alerts cannot duplicate the original social report');

const oldAndUndated = researchPreview({ selection: { companies: [hexaware], topics: ['leadership'],
  window: { start: '2026-08-07', end: '2026-09-06' } }, sources: [source('telegram', [
  { ticker: 'HEXT', text: 'CEO appointed in an older report.', publishedAt: '2025-03-31' },
  { ticker: 'HEXT', text: 'CEO transition discussed in an undated post.', firstSeenAt: '2026-09-06', url: 'javascript:alert(1)' },
  { ticker: 'HEXT', text: 'CEO succession planned according to a recent post.', publishedAt: '2026-09-05T21:30:00Z' },
])] });
assert.deepEqual(oldAndUndated.items.map(item => item.date), ['2026-09-06', null, '2025-03-31'], 'IST event dates and requested window rank before undated and older fallback evidence');
assert.equal(oldAndUndated.items[1].url, null, 'unsafe source URLs never become original-source links');
assert.equal(oldAndUndated.items[1].title, 'CEO transition discussed in an undated post.', 'preview reproduces source wording without filling in a person or effective date');

const longReport = `${'Reported discussion context. '.repeat(10)}${report}`;
const literal = researchPreview({ selection: { companies: [hexaware] }, sources: [source('telegram', [
  { ticker: 'HEXT', text: longReport, publishedAt: '2026-09-04' },
])] }).items[0];
assert.equal(literal.title, longReport, 'a report answer beyond 220 characters is retained instead of cut off at the old headline limit');
assert.equal(literal.truncated, false);
const bounded = researchPreview({ selection: { companies: [hexaware] }, sources: [source('telegram', [
  { ticker: 'HEXT', text: 'Original source words '.repeat(100), publishedAt: '2026-09-04', url: 'https://user:secret@example.com/post' },
])] }).items[0];
assert.equal(bounded.title.length, 700);
assert.equal(bounded.truncated, true, 'literal text clipping is disclosed');
assert.equal(bounded.url, null, 'credential-bearing source links are not rendered');
console.log('PASS research preview: exact identity, attributed literal social leads, topic and date ranking, original links, duplicate suppression, partial coverage and bounds');

const history = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}:` + 'long message '.repeat(600) }));
const recent = researchHistory(history);
assert(recent.reduce((sum, item) => sum + item.text.length, 0) <= 3000);
assert(recent.at(-1).text.startsWith('79:'));
assert.equal(JSON.stringify(recent), JSON.stringify(researchHistory(recent)), 'server and browser bounds are idempotent');
assert(recent.length <= 12);
assert.deepEqual(researchHistory([...history, { role: 'assistant', text: 'failed partial answer', incomplete: true }]), recent);
console.log('PASS long conversation history stays within 3,000 characters and excludes failed answers');
