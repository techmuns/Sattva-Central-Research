#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceConnection, sourceReadState, sourceSummary } from '../public/js/ui/source-connections.js';
import { newsSourceItems, NEWS_PUBLISHERS, screenerInsightsSource } from '../public/js/ui/news-sources.js';
const now = Date.now(), at = new Date(now).toISOString();
for (const [readState, label] of [['read', 'Connected'], ['dated', 'Refresh due'], ['unconfirmed', 'Saved copy'], ['unavailable', 'Connection paused'], ['partial', 'Partial coverage'], ['unchecked', 'Ready to check']]) {
  const item = sourceConnection({ status: 'live', readState });
  assert.equal(item.label, label); assert.equal(item.connected, readState === 'read');
}
assert(!sourceConnection({ status: 'live', readState: 'read' }, { online: false }).connected);
assert.equal(sourceConnection({ status: 'live' }).label, 'Scheduled');
assert.equal(sourceConnection({ status: 'derived' }).label, 'Computed');
assert.equal(sourceReadState({ at }, now), 'read');
assert.equal(sourceReadState({ at, failed: true }, now), 'unavailable');
assert.equal(sourceReadState({ at, partial: true }, now), 'partial');
assert.equal(sourceReadState({ at }, now + 46 * 60000), 'dated');
assert.equal(sourceReadState({ at: now + 11 * 60000 }, now), 'unchecked');
assert.equal(sourceReadState({ at: undefined }, now), 'unchecked');
assert.equal(sourceReadState({ at: 'bad date' }, now), 'unchecked');
const tv = { checkedAt: at, mappedCompanies: 10, activeCompanies: 10, staleOrFailedSymbols: 0 };
const discovery = { capturedAt: at, completedQueries: 10, plannedQueries: 10, staleOrIncompleteQueries: 0, pagesFailed: 0, documentsPending: 0 };
const publishers = NEWS_PUBLISHERS.map(p => ({ id: p.id, capturedAt: at, ok: true, feeds: 3, feedsOk: 3 }));
let items = newsSourceItems({ tradingViewCoverage: tv, enrichmentCoverage: discovery }, publishers);
assert.equal(items.length, 8); assert(items.every(i => sourceConnection(i).connected));
assert.equal(new Set(items.map(i => i.id)).size, items.length);
assert(newsSourceItems({}, []).every(i => !sourceConnection(i).connected), 'unloaded sources cannot be green');
items = newsSourceItems({ tradingViewCoverage: { ...tv, blockedUntil: new Date(now + 3600000).toISOString() },
  enrichmentCoverage: { ...discovery, staleOrIncompleteQueries: 3, pagesFailed: 2 } }, publishers.map(p => ({ ...p, ok: false })));
assert(items.every(i => !sourceConnection(i).connected), 'failure and partial source metadata override recent timestamps');
assert(!sourceConnection(newsSourceItems({ tradingViewCoverage: tv, tradingViewReadError: 'HTTP 503' })[0]).connected);
assert(!sourceConnection(newsSourceItems({ tradingViewCoverage: tv, tradingViewHealth: { ok: false } })[0]).connected);
assert(newsSourceItems({}, publishers, true).filter(i => i.id.startsWith('publisher-')).every(i => !sourceConnection(i).connected), 'archive-read failure overrides retained publisher success');
assert(!sourceConnection(screenerInsightsSource(null)).connected);
assert(sourceConnection(screenerInsightsSource({ checkedAt: at, companies: 10, targets: 10, failed: 0, fullCoverage: true })).connected);
assert(!sourceConnection(screenerInsightsSource({ checkedAt: at, fullCoverage: true, latestReadFailed: true })).connected);
const rss = readFileSync(new URL('../worker/rss-news.mjs', import.meta.url), 'utf8');
const publisherIds = [...new Set([...rss.matchAll(/\{ id: '([^']+)', publisher:/g)].map(m => m[1]))];
assert.deepEqual(NEWS_PUBLISHERS.map(p => p.id).sort(), ['moneycontrol', ...publisherIds].sort());

// Source registry is presentation only. Opening it must not query upstreams or dispatch jobs.
globalThis.document = { addEventListener() {}, hidden: false };
let networkReads = 0;
globalThis.fetch = async () => { networkReads++; throw Error('Registry must not fetch'); };
const { sourceGroups, sourcesModalHtml } = await import('../public/js/ui/sources.js');
const groups = sourceGroups(), all = groups.flatMap(g => g.items);
assert.equal(groups.find(g => g.id === 'portfolio-news').items.length, 9);
for (const id of ['tradingview-news', 'global-company-news', 'official-company-ir', 'screener-insights', 'x-portfolio-search']) assert.equal(all.filter(i => i.id === id).length, 1, id);
assert(!all.some(i => i.planned || i.internal || i.name === 'Analyst consensus estimates'));
assert(!all.some(i => i.name === 'No accounts monitored yet'), 'empty editor state is not a source');
assert.equal(all.find(i => i.name === 'Screener.in — company filings').readState, 'unchecked');
assert.equal(all.find(i => i.name === 'Screener.in — company filings').status, 'live', 'configured scheduling remains distinct from unloaded coverage');
assert(all.some(i => i.name === 'BSE SME'), 'configured failing sources remain visible');
const summary = sourceSummary(groups);
assert.equal(summary.total, all.length);
assert.equal(summary.connected, all.filter(i => sourceConnection(i).connected).length);
assert(sourcesModalHtml().includes(`${summary.connected} connected`));
assert.equal(networkReads, 0);
console.log('PASS source registry: complete new-source inventory, publisher parity, safe vocabulary, verified freshness, offline, retained failures and no network side effects');
