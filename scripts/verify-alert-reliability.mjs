#!/usr/bin/env node
// Deterministic customer-failure replays. No upstream calls or production mutations.
import assert from 'node:assert/strict';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
import { withTwitterCollectionStatus } from './record-twitter-status.mjs';
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const { rankReport, materialEvidence } = await import('../public/js/data/ai-alerts.js');
const { announcementSignal, materializePublicAlertWindow, readCachedAlertWindow, ALERT_WINDOW_CACHE_KEY } = await import('../public/js/data/daily-alerts.js');
const { writeEntry } = await import('../public/js/core/store.js');
const { nseRecords } = await import('../public/js/data/alert-sources.js');
const mute = await import('../public/js/core/ai-mute.js');
const holdings = [{ ticker: 'JAYNECOIND', name: 'Jayaswal Neco Industries' }];
const story = {
  id: 'news:one', ticker: 'JAYNECOIND', company: holdings[0].name, day: '2026-09-04',
  feed: 'news', headline: 'Jayaswal Neco announces capacity expansion', importance: 'high',
  direction: 'neutral', namesCompany: true, aiEligible: true, url: 'https://publisher.example/story',
  attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed', companyTicker: 'JAYNECOIND' },
};
const rank = (events, day = '2026-09-04', status = 'ok') => rankReport({ day, scope: 'portfolio', events,
  feeds: ['news', 'announcements', 'nse-filings', 'earnings'].map(id => ({ id, status, reachesToday: status === 'ok' })),
}, { holdings, insightCompanies: [] });
for (let offset = 0; offset < 14; offset++) {
  const day = `2026-09-${String(4 + offset).padStart(2, '0')}`;
  for (const status of ['ok', 'pending', 'failed']) {
    const result = rank([story], day, status);
    assert.equal(result.cards.length, 1, `material neutral news remains on ${day} while source ${status}`);
    assert.equal(result.cards[0].priority, 'important', 'retention does not fabricate urgency');
    assert.equal(result.cards[0].score, result.cards[0].scoreBreakdown.reduce((sum, part) => sum + part.points, 0));
  }
}
assert(rank([story], '2026-09-05').cards[0].score < rank([story]).cards[0].score, 'recency still affects ordering');
assert.equal(rank([story], '2026-09-18').cards.length, 0, 'events expire after the stated 14-day window');
assert.equal(rank([{ ...story, importance: 'low' }], '2026-09-05').cards.length, 0, 'routine news gets no retention bypass');
assert.equal(rank([{ ...story, aiEligible: false }]).cards.length, 0, 'uncertain or context-only news never bypasses eligibility');
assert.equal(rank([{ ...story, day: '2026-09-31' }], '2026-10-01').cards.length, 0, 'invalid source dates cannot manufacture a material alert');

const saved = materializePublicAlertWindow({ day: '2026-09-17', feeds: [{ id: 'news', status: 'ok', reachesToday: true }], events: [
  story, { ...story, id: 'expired', day: '2026-09-03' }, { ...story, id: 'future', day: '2026-09-18' },
] });
assert.deepEqual(saved.events.map(event => event.id), [story.id], 'the public cache retains day 14 and excludes expired/future events');
await writeEntry(ALERT_WINDOW_CACHE_KEY, { value: saved });
const restored = await readCachedAlertWindow({ scope: 'portfolio', holdings, day: '2026-09-17' });
assert.equal(rankReport(restored, { holdings, insightCompanies: [] }).cards.length, 1, 'reload preserves a day-14 material alert');
assert.equal((await readCachedAlertWindow({ scope: 'portfolio', holdings, day: '2026-09-18' })).events.length, 0, 'reload expires an event on day 15');
await writeEntry(ALERT_WINDOW_CACHE_KEY, { value: { ...saved, day: story.day } });
assert.equal((await readCachedAlertWindow({ scope: 'portfolio', holdings, day: '2026-09-17' })).events.length, 1, 'a two-week-old cached observation remains usable offline');
assert.equal(await readCachedAlertWindow({ scope: 'portfolio', holdings, day: '2026-09-18' }), null, 'cache validity matches the review window');

for (const title of ['Analyst Day presentation', 'Investor Presentation', 'Capital Markets Day disclosure', 'Analysts / Institutional Investor Meet: presentation', 'Presentation to analysts']) {
  const signal = announcementSignal({ title });
  assert.equal(signal.importance, 'high', title);
  assert.equal(signal.direction, 'neutral', 'disclosure is not a buy/sell inference');
  assert.match(signal.importanceReason, /not confirmation/);
}
for (const title of ['Analyst / Institutional Investor Meet - Intimation', 'Notice of Annual General Meeting', 'Trading window closure']) {
  assert.equal(announcementSignal({ title }).importance, 'low', `routine filing stays low: ${title}`);
}
const filing = { ticker: 'JAYNECOIND', company: holdings[0].name, publishedAt: '2026-09-04T10:00:00Z',
  subject: 'Analyst Presentation', description: 'Investor day source document', url: 'https://nsearchives.nseindia.com/corporate/test.pdf' };
const [nse] = nseRecords([filing]);
assert.equal(nse.aiEligible, true, 'material NSE disclosures can originate an alert');
assert.equal(rank([{ ...nse, feed: 'nse-filings' }], '2026-09-05').cards.length, 1);
for (const field of ['ticker', 'publishedAt', 'url']) assert.equal(nseRecords([{ ...filing, [field]: null }])[0].aiEligible, false, `missing ${field} remains context-only`);
const bse = { ...nse, id: 'bse:one', feed: 'announcements' };
const duplicate = rank([bse, { ...nse, feed: 'nse-filings' }]).cards[0];
assert.equal(duplicate.events.length, 1, 'same issuer disclosure on BSE/NSE is one evidence item');
const twoDisclosures = rank([bse, { ...nse, id: 'nse:two', feed: 'nse-filings', url: `${filing.url}?other=1`, headline: 'Second investor presentation' }]).cards[0];
assert.equal(twoDisclosures.feedCount, 1, 'two exchange copies are never two independent feeds');

const strong = { ...story, id: 'strong', feed: 'earnings', headline: 'Material earnings decline', direction: 'negative' };
const initial = rank([strong, story]).cards[0];
mute.hide(initial.ticker, initial.evidenceKey);
assert(mute.isHidden(initial.ticker, rank([story, strong]).cards[0].evidenceKey), 'reordering does not revive dismissed evidence');
assert(mute.isHidden(initial.ticker, JSON.stringify(materialEvidence([strong]))), 'aging out a weaker old event does not revive a card');
assert(mute.isHidden(initial.ticker, rank([strong, story, { ...story, id: 'routine', importance: 'low' }]).cards[0].evidenceKey), 'routine arrivals do not revive a card');
const later = rank([strong, story, { ...story, id: 'new-material', url: 'https://publisher.example/new-order', headline: 'Jayaswal Neco secures export order' }]).cards[0];
assert.equal(later.topEvent.id, initial.topEvent.id, 'older strong event still leads');
assert(!mute.isHidden(later.ticker, later.evidenceKey), 'new material evidence revives the card anyway');
assert(!mute.isHidden(initial.ticker, rank([strong, { ...story, headline: 'Corrected capacity expansion disclosure' }]).cards[0].evidenceKey), 'a material source correction revives the card');
const realNow = Date.now;
try {
  Date.now = () => realNow() + 13 * 86400000;
  assert(mute.isHidden(initial.ticker, initial.evidenceKey), 'read evidence remains dismissed through day 14');
  Date.now = () => realNow() + 15 * 86400000;
  assert(!mute.isHidden(initial.ticker, initial.evidenceKey), 'an open tab expires cached mute state after the review window');
}
finally { Date.now = realNow; }

const capture = { capturedAt: '2026-09-04T12:00:00Z', posts: [{ tweet_id: '1', text: 'Retained source post' }], failed: [] };
const original = structuredClone(capture);
const disabled = withTwitterCollectionStatus(capture, { enabled: false });
assert.deepEqual(disabled.posts, capture.posts);
assert.equal(disabled.capturedAt, capture.capturedAt);
assert.deepEqual(withTwitterCollectionStatus(disabled, { enabled: false, now: '2026-09-06T12:00:00Z' }), disabled, 'disabled schedule creates no timestamp churn');
for (const code of [2, 3, 1, null]) {
  const failed = withTwitterCollectionStatus(capture, { enabled: true, code, now: '2026-09-05T12:00:00Z' });
  assert.equal(failed.collection.status, 'unavailable');
  assert.equal(failed.capturedAt, capture.capturedAt, 'failed login never refreshes the data age');
  assert.deepEqual(failed.posts, capture.posts);
}
assert.equal(withTwitterCollectionStatus(capture, { enabled: true, code: 0 }).collection.status, 'ok');
assert.equal(withTwitterCollectionStatus({ ...capture, failed: [{ handle: 'one' }] }, { enabled: true, code: 0 }).collection.status, 'partial');
assert.deepEqual(capture, original, 'status annotations do not mutate retained evidence');
console.log('PASS 14-day material alerts, official research disclosures, exchange deduplication, new-evidence unmute and optional X retention.');
