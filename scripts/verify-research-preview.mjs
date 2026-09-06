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
console.log('PASS research preview: exact identity, attribution, duplicate suppression, dates, partial coverage, tickerless holdings and bounds');

const history = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}:` + 'long message '.repeat(600) }));
const recent = researchHistory(history);
assert(recent.reduce((sum, item) => sum + item.text.length, 0) <= 3000);
assert(recent.at(-1).text.startsWith('79:'));
assert.equal(JSON.stringify(recent), JSON.stringify(researchHistory(recent)), 'server and browser bounds are idempotent');
assert(recent.length <= 12);
assert.deepEqual(researchHistory([...history, { role: 'assistant', text: 'failed partial answer', incomplete: true }]), recent);
console.log('PASS long conversation history stays within 3,000 characters and excludes failed answers');
