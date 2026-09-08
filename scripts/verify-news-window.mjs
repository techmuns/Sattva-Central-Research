#!/usr/bin/env node
import assert from 'node:assert/strict';
import { newsDay, newsPublicationDay, newsPeriodBounds, recentNewsWindow, matchesNewsPeriod,
  newsShardInWindow, newsHeadCoversArchive } from '../public/js/data/news-window.js';
import { withNewsHistory } from '../public/js/data/news-history.js';
import { newsSourceMeta } from '../public/js/ui/news-sources.js';

const now = Date.parse('2026-09-08T04:30:00Z');
const olderMeta = { newsDelivery: { core: { readerCheckedAt: 100, status: 'ok' } } };
const recentMeta = { newsDelivery: { core: { readerCheckedAt: 200, status: 'unavailable' } } };
assert.equal(newsSourceMeta([olderMeta, recentMeta]), recentMeta, 'source registry uses newest attempt, even when failed');
assert.equal(newsSourceMeta([{}, recentMeta]), recentMeta, 'recent-only News can populate sources without loading full history');
const sharedCore = { readerCheckedAt: 300, status: 'ok' };
const noTvCheck = { newsDelivery: { core: sharedCore } };
const checkedTv = { tradingViewCoverage: { checkedAt: '2026-09-08T04:30:00Z' },
  newsDelivery: { core: sharedCore, tradingView: { readerCheckedAt: 301, status: 'ok' } } };
assert.equal(newsSourceMeta([noTvCheck, checkedTv]).tradingViewCoverage, checkedTv.tradingViewCoverage,
  'shared core timestamps cannot select a reader that has not checked TradingView');
const failedTv = { ...noTvCheck, tradingViewReadError: 'fixture outage',
  newsDelivery: { core: sharedCore, tradingView: { readerCheckedAt: 302, status: 'unavailable' } } };
assert.equal(newsSourceMeta([failedTv, checkedTv]).tradingViewReadError, 'fixture outage',
  'latest failed TradingView check wins over an earlier success');
assert.equal(newsDay('2026-08-31T18:29:59Z'), '2026-08-31');
assert.equal(newsDay('2026-08-31T18:30:00Z'), '2026-09-01');
assert.equal(newsDay('2026-12-31T18:30:00Z'), '2027-01-01');
assert.equal(newsPublicationDay({ firstSeenAt: new Date(now).toISOString() }), null);
assert.equal(newsPublicationDay({ date: '2026-02-30' }), null);
assert.equal(newsPublicationDay({ date: '2024-02-29' }), '2024-02-29');
assert.equal(newsPublicationDay({ date: '2026-09-03', publishedAt: '2026-09-03T20:00:00Z' }), '2026-09-03');
assert.equal(newsPublicationDay({ publishedAt: '2026-09-03T20:00:00Z' }), '2026-09-04');
for (const [period, from] of [['today','2026-09-08'],['3','2026-09-06'],['7','2026-09-02'],['14','2026-08-26'],['30','2026-08-10'],['month','2026-09-01']]) {
  assert.equal(newsPeriodBounds(period, now).from, from);
  assert(matchesNewsPeriod({ date: from }, period, now), `${period}: inclusive first day`);
  assert(!matchesNewsPeriod({ date: '2026-09-09' }, period, now), `${period}: future is not today`);
  assert(!matchesNewsPeriod({}, period, now), `${period}: undated is not recent`);
}
assert(matchesNewsPeriod({}, 'undated', now));
assert.equal(recentNewsWindow(Date.parse('2026-08-31T10:00:00Z')).from, '2026-08-01', 'calendar month can be 31 days');
assert.equal(newsPeriodBounds('30', Date.parse('2026-08-31T10:00:00Z')).from, '2026-08-02');
assert.equal(newsPeriodBounds('3', Date.parse('2024-03-01T10:00:00Z')).from, '2024-02-28');
const range = recentNewsWindow(now);
assert(newsShardInWindow({ file: 'market-news/2026-08.json' }, range));
assert(!newsShardInWindow({ month: '2026-07' }, range));
assert(newsShardInWindow({ month: 'undated' }, range));
assert(!newsShardInWindow({ month: 'undated' }, { ...range, includeUndated: false }));
assert(newsShardInWindow({ month: '2026-08' }, newsPeriodBounds('month', now)), 'UTC August can carry September 1 IST');

const at = new Date(now).toISOString();
let indexAt = at, fail = false;
const head = { retention: 'permanent-archive', archive: { index: 'company-news/index.json', articleCount: 3 },
  newsHeadWindow: { from: '2026-08-09', to: '2026-09-08', updatedAt: at } };
const row = (id, date) => ({ ticker: 'AAA', company: 'Company A', title: id, date, url: `https://example.test/${id}` });
const source = [row('head', '2026-09-08')];
const base = { rows: () => source, meta: () => ({ ...head, ok: true }), seed: async () => {}, load: async () => {},
  refreshSnapshot: async () => ({ available: true }), onChange: () => () => {}, invalidate() {}, wasAskedEmpty: () => false };
const calls = [];
const read = async path => {
  calls.push(path);
  if (path.endsWith('index.json')) return { tag: indexAt, value: { updatedAt: indexAt, articleCount: 3, archive: [
    { file: 'company-news/2026-09.json', count: 1 }, { file: 'company-news/2026-08.json', count: 1 },
    { file: 'company-news/2020-01.json', count: 1 },
  ] } };
  if (fail) throw Error('fixture outage');
  return { value: { articles: [path.includes('2020') ? row('old', '2020-01-01')
    : path.includes('2026-08') ? row('boundary', '2026-08-10') : row('new', '2026-09-07')] } };
};
assert(newsHeadCoversArchive(head, { updatedAt: at, articleCount: 3 }, range));
assert(!newsHeadCoversArchive({ ...head, retention: null }, { updatedAt: at, articleCount: 3 }, range));
assert(!newsHeadCoversArchive(head, { updatedAt: at, articleCount: 4 }, range));
const bounded = withNewsHistory(base, { read, window: () => range });
await bounded.seed();
assert.deepEqual(calls, ['data/company-news/index.json'], 'verified complete head avoids duplicate monthly downloads');
indexAt = '2026-09-08T04:31:00Z';
calls.length = 0;
await bounded.refreshSnapshot();
assert.deepEqual(calls, ['data/company-news/index.json', 'data/company-news/2026-09.json', 'data/company-news/2026-08.json'],
  'newer index reconciles recent months only');
assert.equal(bounded.rows().length, 3);
indexAt = '2026-09-08T04:32:00Z'; fail = true;
assert.equal((await bounded.refreshSnapshot()).partial, true);
assert.equal(bounded.rows().length, 3, 'failed refresh cannot erase retained recent stories');
fail = false;
const full = withNewsHistory(base, { read });
await full.seed();
assert(full.rows().some(row => row.title === 'old'), 'full archive remains available to other consumers');
assert(!bounded.rows().some(row => row.title === 'old'), 'full-history read cannot widen the recent reader');
console.log('PASS News windows: IST/leap/year/month boundaries, undated/future separation, verified-head reuse, bounded catch-up, failed-read retention and independent full history.');
