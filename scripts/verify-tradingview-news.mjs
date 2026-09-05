#!/usr/bin/env node
// Synthetic public-page responses only. No TradingView/production access in CI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tradingViewTargets, tradingViewNewsUrl, parseTradingViewNews, readTradingViewNews } from './lib/tradingview-news.mjs';
import { enrichTradingViewNews } from './enrich-tradingview-news.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { attributeNewsRow } from '../public/js/data/company-news-attribution.js';
import { filterCompanyNewsByScope } from '../public/js/data/company-news-identity.js';
import { companyNewsArchiveRows, commitCompanyNewsArchive, mergeCompanyNewsArticles } from './lib/company-news-archive.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { createFeed } from '../public/js/data/filings.js';
import { clearAll } from '../public/js/core/store.js';

const now = Date.now(), at = new Date(now).toISOString(), day = at.slice(0, 10);
const holdings = [
  { isin: 'INE000000001', ticker: 'ALPHA', name: 'Alpha Solar', weightPct: 99 },
  { isin: 'INE000000002', ticker: null, name: 'Alpha Solar — warrants' },
  { isin: 'INE000000003', ticker: null, name: 'BSE Beta' },
  { isin: 'INE000000004', ticker: null, name: 'Private Robotics' },
];
const directory = [
  { isin: 'INE000000001', ticker: 'ALPHA', bseSymbol: 'ALPHAB', bseCode: '500001', name: 'Alpha Solar' },
  { isin: 'INE000000003', ticker: null, bseSymbol: 'BETAB', bseCode: '500003', name: 'BSE Beta' },
];
const entities = portfolioNewsEntities(holdings), alpha = entities.find(e => e.ticker === 'ALPHA');
const targets = tradingViewTargets(entities, directory);
assert.deepEqual(targets.find(t => t.entity.ticker === 'ALPHA').symbols, ['NSE:ALPHA', 'BSE:ALPHAB']);
assert.deepEqual(targets.find(t => t.entity.name === 'BSE Beta').symbols, ['BSE:BETAB']);
assert.equal(targets.find(t => t.entity.name === 'Private Robotics').reason, 'no-verified-exchange-symbol');
assert.equal(tradingViewTargets(portfolioNewsEntities([{ name: 'Alpex Solar', ticker: 'ALPEXSOLAR-SM' }]))[0].symbols[0], 'NSE:ALPEXSOLAR');
assert.throws(() => tradingViewNewsUrl('NSE:ALPHA&filter=other'));
const url = new URL(tradingViewNewsUrl('NSE:ALPHA'));
assert.deepEqual(url.searchParams.getAll('filter'), ['lang:en', 'symbol:NSE:ALPHA']);
assert(!/token|cookie|prostatus|priority|section/.test(url.search));

const item = (id, symbol = 'NSE:ALPHA', extra = {}) => ({ id, title: 'Alpha Solar announces an investor day',
  published: Math.floor(now / 1000), provider: { id: 'fixture', name: 'Fixture Publisher' },
  storyPath: `/news/fixture:${id}-alpha/`, relatedSymbols: [{ symbol }], paywall: true,
  permission: 'headline', text: 'DO NOT RETAIN ARTICLE TEXT', ...extra });
const parsed = parseTradingViewNews({ items: [item('1'), item('1'), item('2', 'NSE:ALPHA', { permission: 'provider', title: 'HIDDEN HEADLINE' }),
  item('3', 'NSE:ALPHA', { permission: 'unknown' }), item('4', 'NSE:ALPHA', { published: null }),
  item('5', 'NSE:ALPHA', { storyPath: null, link: 'javascript:alert(1)' }),
  item('6', 'NSE:OTHER', { published: 9999999999999 })] }, 'NSE:ALPHA', now);
assert.equal(parsed.articles.length, 3);
assert.equal(parsed.restricted, 2);
assert.equal(parsed.invalid, 1);
assert.equal(parsed.undated, 2);
assert.equal(parsed.untagged, 1);
assert(!JSON.stringify(parsed).includes('HIDDEN HEADLINE'));
assert(!JSON.stringify(parsed).includes('DO NOT RETAIN'));
assert.equal(parsed.articles[0].paywall, true, 'visible headline is separate from gated article access');
assert.equal(parsed.articles[1].date, null, 'unknown source time is not replaced with collection time');
assert.throws(() => parseTradingViewNews({ message: 'Please sign in' }, 'NSE:ALPHA'));
assert.equal(parseTradingViewNews({ items: [item('mirror')] }, 'BSE:ALPHAB', now, ['NSE:ALPHA', 'BSE:ALPHAB']).untagged, 0, 'exact same-issuer venue aliases are accepted');
await assert.rejects(readTradingViewNews('NSE:ALPHA', { fetcher: async () => new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } }) }), /non-json/);
await assert.rejects(readTradingViewNews('NSE:ALPHA', { fetcher: async () => Response.json({}, { headers: { 'content-length': '3000000' } }) }), /too-large/);

const row = { ...parsed.articles[0], entityId: alpha.entityId, ticker: alpha.ticker, firstSeenAt: at };
const syndicated = { ...row, tradingViewId: undefined, tradingViewUrl: undefined, discoverySource: 'publisher-feed',
  discoverySources: ['publisher-feed'], url: 'https://publisher.example/article' };
const enriched = mergeCompanyNewsArticles([syndicated], [{ ...row, url: syndicated.url }]);
assert.equal(enriched.length, 1);
assert(enriched[0].sourceUrls.includes(row.tradingViewUrl));
assert(enriched[0].discoverySources.includes('publisher-feed'));
const corrected = mergeCompanyNewsArticles(enriched, [{ ...row, title: 'Corrected Alpha Solar headline', tradingViewUrl: 'https://in.tradingview.com/news/new-path', url: 'https://publisher.example/corrected' }]);
assert.equal(corrected.length, 1, 'stable provider ID survives title and URL corrections');
const newest = { ...corrected[0], lastSeenAt: new Date(now + 1000).toISOString() };
assert.equal(mergeCompanyNewsArticles([newest], [{ ...row, lastSeenAt: at }])[0].title, newest.title, 'older shard observations cannot undo a newer correction');
assert.equal(mergeCompanyNewsArticles(enriched, [row])[0].url, syndicated.url, 'prefer the original publisher link when a later mirror only supplies its TradingView URL');
assert.equal(attributeNewsRow({ ...row, title: 'A broad sector headline', relatedSymbols: ['NSE:ALPHA'] }, alpha).attribution.status, 'uncertain', 'feed symbol tags are discovery context, not direct-company evidence');

const scratch = mkdtempSync(join(tmpdir(), 'tradingview-news-test-'));
const realFetch = globalThis.fetch;
try {
  writeJson(join(scratch, 'announcement-identities.json'), { entries: directory });
  const dir = join(scratch, 'company-news');
  const coreAt = new Date(now - 86400000).toISOString();
  commitCompanyNewsArchive({ dir, entities, capturedAt: coreAt, articles: [{ ...row, tradingViewId: undefined,
    title: 'An old archived report', url: 'https://publisher.example/old', date: '2020-01-01', publishedAt: '2020-01-01T00:00:00Z' }] });
  writeJson(join(scratch, 'news.json'), { capturedAt: coreAt, byTicker: { ALPHA: [{
    title: 'An old archived report', url: 'https://publisher.example/old', date: '2020-01-01', source: 'Fixture Publisher',
  }] }, empty: ['ALPHA'], entities });
  let mode = 'ok';
  const calls = [];
  const fetcher = async (input, options) => {
    const u = new URL(input);
    assert.equal(u.hostname, 'news-mediator.tradingview.com');
    assert.equal(u.pathname, '/public/view/v1/symbol');
    assert.equal(options.redirect, 'error');
    assert(!Object.keys(options.headers).some(k => /cookie|authorization/i.test(k)));
    const symbol = u.searchParams.getAll('filter').find(f => f.startsWith('symbol:')).slice(7);
    calls.push(symbol);
    if (mode === 'blocked') return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
    if (mode === 'empty') return Response.json({ items: [] });
    const title = symbol === 'BSE:BETAB' ? 'BSE Beta announces an investor day' : 'Alpha Solar announces an investor day';
    return Response.json({ items: [item(symbol.includes('ALPHA') ? 'shared-alpha' : symbol, symbol, { title })] });
  };
  const options = { dataDir: scratch, portfolio: { holdings, portfolio: { status: 'live' } }, fetcher, now, spacingMs: 0 };
  const coverage = await enrichTradingViewNews(options);
  assert.equal(coverage.plannedSymbols, 3);
  assert.equal(coverage.unresolvedCompanies, 1);
  assert.equal(coverage.staleOrFailedSymbols, 0);
  assert.equal(companyNewsArchiveRows(dir).length, 3, 'NSE/BSE mirrors merge by the source story ID; old history remains');
  const captured = readJson(join(scratch, 'news.json'));
  assert.equal(captured.capturedAt, coreAt, 'TradingView cannot launder core source freshness');
  assert.equal(readJson(join(dir, 'index.json')).updatedAt, coreAt);
  assert(!JSON.stringify(readJson(join(dir, 'tradingview.json'))).includes('weightPct'));
  assert(!captured.empty.includes('ALPHA'));
  assert(captured.byTicker['ISIN:INE000000003'].length, 'BSE-only rows remain tickerless but scoped');
  mode = 'empty';
  await enrichTradingViewNews({ ...options, now: now + 3600000 });
  assert.equal(companyNewsArchiveRows(dir).length, 3, 'empty public views never erase captured rows');
  const beforeBlocked = readJson(join(dir, 'tradingview.json'));
  mode = 'blocked'; calls.length = 0;
  const blocked = await enrichTradingViewNews({ ...options, now: now + 7200000 });
  assert.equal(calls.length, 1, 'a source-wide refusal stops the whole walk');
  assert(blocked.blockedUntil);
  for (const [key, entry] of Object.entries(readJson(join(dir, 'tradingview.json')).entries))
    assert.equal(entry.lastSuccessAt, beforeBlocked.entries[key].lastSuccessAt);
  calls.length = 0;
  await enrichTradingViewNews({ ...options, now: now + 7201000 });
  assert.equal(calls.length, 0, 'Retry-After is respected without alternate endpoints');
  mode = 'ok'; calls.length = 0;
  const newHoldings = [holdings[2], { isin: 'INE000000005', ticker: 'NEWCO', name: 'New Company' }];
  await enrichTradingViewNews({ ...options, portfolio: { holdings: newHoldings }, now: now + 14400000 });
  assert(calls.includes('NSE:NEWCO'), 'new holding is automatically enrolled');
  assert(!calls.some(s => s.includes('ALPHA')), 'exited holding is no longer polled');
  assert(companyNewsArchiveRows(dir).some(r => r.entityId === alpha.entityId), 'exit does not delete the prior archive');
  assert(!filterCompanyNewsByScope(companyNewsArchiveRows(dir), 'portfolio', newHoldings).some(r => r.entityId === alpha.entityId));
  assert(Object.values(readJson(join(dir, 'tradingview.json')).entries).filter(e => e.entityId === alpha.entityId).every(e => !e.active));

  // Bounded pages cannot certify full history. A later quiet read does not erase a detected gap.
  const crowded = async () => Response.json({ items: Array.from({ length: 30 }, (_, i) => item(`crowded-${i}`, 'NSE:NEWCO')) });
  await enrichTradingViewNews({ ...options, portfolio: { holdings: [newHoldings[1]] }, fetcher: crowded, now: now + 18000000 });
  assert.equal(readJson(join(dir, 'tradingview.json')).coverage.possibleGapSymbols, 1);
  mode = 'empty';
  await enrichTradingViewNews({ ...options, portfolio: { holdings: [newHoldings[1]] }, now: now + 21600000 });
  assert.equal(readJson(join(dir, 'tradingview.json')).coverage.possibleGapSymbols, 1);
  await assert.rejects(enrichTradingViewNews({ ...options, portfolio: { holdings: [] } }), /empty book/);

  // Real browser feed code: independent revision refreshes without changing core source time.
  await clearAll();
  let snapshot = { ...captured, coversUniverse: true };
  globalThis.fetch = async input => {
    assert.equal(input, 'data/news.json', 'no live company walk is required for the enrichment');
    return Response.json(snapshot);
  };
  const feed = createFeed('news');
  await feed.load([alpha]);
  const count = feed.rows().length;
  snapshot = { ...snapshot, newsUpdatedAt: new Date(now + 1000).toISOString(),
    byTicker: { ...snapshot.byTicker, ALPHA: [...snapshot.byTicker.ALPHA, { ...row, tradingViewId: 'new', title: 'Fresh Alpha Solar news', url: 'https://publisher.example/fresh' }] } };
  assert.equal((await feed.refreshSnapshot()).changed, true);
  assert.equal(feed.rows().length, count + 1);
  assert.equal(feed.meta().capturedAt, coreAt);
  assert.equal(feed.meta().tradingViewCoverage.plannedSymbols, 3);
  snapshot = { ...snapshot, coversUniverse: false };
  globalThis.fetch = async input => input === 'data/news.json' ? Response.json(snapshot) : Response.json({ ok: true, articles: [] });
  await feed.refresh();
  assert(feed.rows().some(r => r.tradingViewId === 'new'), 'a live Muns empty read cannot hide independent TradingView observations');
  assert.equal(feed.meta().origin, 'mixed', 'a Muns refresh does not certify the retained TradingView rows as live');
  snapshot = { ...captured, coversUniverse: true };
  delete snapshot.tradingViewCoverage;
  await feed.refreshSnapshot();
  assert.equal(feed.rows().length, count + 1, 'stale core snapshot cannot retract a newer enrichment');
  assert.equal(feed.meta().tradingViewCoverage.plannedSymbols, 3, 'stale metadata cannot erase the source coverage status');
} finally { globalThis.fetch = realFetch; await clearAll(); rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS TradingView public metadata, access boundaries, stable dedupe, automatic entries/exits, BSE-only identities, permanent history, source refusal and independent browser refresh.');
