#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attributeNewsRow, attributionFor, newsSearchText, newsCanSupportAI } from '../public/js/data/company-news-attribution.js';
import { newsSignal, eventSearchText, announcementSignal } from '../public/js/data/daily-alerts.js';
import { rankReport } from '../public/js/data/ai-alerts.js';
import { createFeed } from '../public/js/data/filings.js';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/company-news-attribution.json', import.meta.url)));
const cases = fixture.cases;
const day = '2026-09-04';
const eventFor = row => ({ feed: 'news', feedLabel: 'Company news', day, ticker: row.ticker,
  company: row.company, headline: row.title, sourceRecord: row, ...newsSignal(row) });
for (const test of cases) {
  const raw = { date: day, query: test.identity.name, ...test.row };
  const before = JSON.stringify(raw);
  const row = attributeNewsRow(raw, test.identity);
  assert.equal(row.attribution.status, test.status, test.id);
  assert.equal(JSON.stringify(raw), before, `${test.id}: original source is unchanged`);
  assert.equal(row.title, raw.title);
  assert.equal(row.summary, raw.summary);
  if (test.status !== 'unrelated') {
    for (const query of [test.identity.name, test.identity.ticker].filter(Boolean)) {
      assert(newsSearchText(row).toLowerCase().includes(query.toLowerCase()), `${test.id}: News recall for ${query}`);
      assert(eventSearchText(eventFor(row)).toLowerCase().includes(query.toLowerCase()), `${test.id}: All Alerts recall for ${query}`);
    }
  } else {
    assert.equal(row.ticker, null);
    assert.equal(row.entityId, null);
    assert.equal(row.attribution.companyTicker, null);
    assert.equal(row.queryTicker, test.identity.ticker);
    assert(!newsSearchText(row).toLowerCase().includes('jayaswal'));
    assert(!eventSearchText(eventFor(row)).toLowerCase().includes('jayaswal'));
    assert(eventSearchText(eventFor(row)).toLowerCase().includes('lululemon'));
  }
  assert.equal(newsCanSupportAI(eventFor(row)), test.status === 'confirmed');
}
const mismatch = cases.find(t => t.id === 'reported-mismatch');
assert.equal(attributeNewsRow({ ...mismatch.row, summary: 'Updated text could now discuss Jayaswal Neco Industries.' }, mismatch.identity).attribution.status, 'uncertain', 'changed evidence invalidates the narrow reviewed exclusion');
assert.equal(attributeNewsRow({ ...mismatch.row, title: 'Jayaswal Neco Industries and Lululemon announce a joint venture' }, mismatch.identity).attribution.status, 'confirmed', 'never a publisher or Lululemon keyword blacklist');
assert.equal(attributeNewsRow(mismatch.row, { ticker: 'LULU', name: 'Lululemon' }).attribution.status, 'confirmed', 'reviewed exclusions are company-specific');
assert.equal(attributionFor({ title: 'Unknown article' }).status, 'uncertain');

const base = { id: 'earnings', day, ticker: 'JAYNECOIND', company: 'Jayaswal Neco Industries', feed: 'earnings', feedLabel: 'Earnings', importance: 'high', direction: 'neutral', headline: 'Quarterly results' };
const feeds = ['earnings', 'news'].map(id => ({ id, status: 'ok', reachesToday: true }));
const options = { holdings: [{ ticker: base.ticker, name: base.company }] };
const report = events => rankReport({ day, scope: 'portfolio', feeds, events }, options);
const before = report([base]).allCards[0];
for (const news of [
  { ...base, id: 'legacy', feed: 'news', namesCompany: false, headline: 'Lululemon analysis' },
  eventFor(attributeNewsRow({ title: 'Unknown brand receives approval' }, { ticker: base.ticker, name: base.company })),
  eventFor(attributeNewsRow(mismatch.row, mismatch.identity)),
]) {
  const after = report([base, news]).allCards[0];
  assert.equal(after.score, before.score, 'uncertain/unrelated/legacy news adds zero ranking points');
  assert.equal(after.feedCount, before.feedCount, 'no false independent-feed corroboration');
  assert.deepEqual(after.confluence, before.confluence);
  assert.deepEqual(after.contextEvents, before.contextEvents, 'unverified news is not used as supporting card context');
  assert.equal(after.events.length, before.events.length);
  assert.equal(report([news]).cards.length, 0, 'unverified news cannot manufacture a card');
}
const confirmed = eventFor(attributeNewsRow({ title: 'Jayaswal Neco Industries reports quarterly earnings' }, { ticker: base.ticker, name: base.company }));
assert.equal(report([confirmed]).cards.length, 1, 'genuine matched material news can still surface alone');
assert.equal(report([base, confirmed]).allCards[0].feedCount, 2);
assert.equal(announcementSignal({ title: 'Routine filing' }).direction, 'neutral');
assert(eventSearchText({ feed: 'announcements', ticker: 'JAYNECOIND', company: 'Jayaswal Neco', headline: 'Routine filing', namesCompany: false }).includes('JAYNECOIND'), 'official records never use news attribution gates');
const requests = [];
const brandedIdentity = { ticker: 'BETALTD', key: 'BETALTD', name: 'Private Beta Limited', brands: ['BetaPay'] };
globalThis.fetch = async (input) => {
  const url = String(input); requests.push(url);
  if (!url.startsWith('data/news.json')) throw new Error(`Unexpected test request: ${url}`);
  return new Response(JSON.stringify({ capturedAt: '2026-09-04T08:00:00Z', entities: [brandedIdentity],
    byTicker: { BETALTD: [{ title: 'BetaPay launches a new product', query: 'Private Beta Limited', date: day }] } }), { headers: { 'content-type': 'application/json' } });
};
const feed = createFeed('news');
await feed.load([{ ticker: 'BETALTD', name: 'Private Beta Limited' }]);
assert.equal(feed.rows()[0].attribution.status, 'confirmed', 'snapshot row is decorated with its reviewed brand');
feed.setWanted([{ ticker: 'BETALTD', name: 'Private Beta Limited', brands: [] }]);
assert.equal(feed.rows()[0].attribution.status, 'confirmed', 'scope changes cannot erase reviewed aliases');
assert.equal(feed.rows()[0].ticker, 'BETALTD', 'legacy row without a ticker retains its searched ticker');
assert.equal(requests.length, 1, 'classification and scope changes make no extra requests');
console.log(`PASS: ${cases.length} stable attribution cases; all retained positive/uncertain company searches, narrow reviewed mismatch, unchanged source records and zero false AI corroboration.`);
