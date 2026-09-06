#!/usr/bin/env node
// Isolated filesystem and synthetic network/clock only; never dispatch or mutate production.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enrichTradingViewNews } from './enrich-tradingview-news.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { companyNewsArchiveRows } from './lib/company-news-archive.mjs';
import { withTradingViewNews, NEWS_SNAPSHOT_POLL_MS } from '../public/js/data/tradingview-news.js';
import { assessTradingViewCoverage } from '../public/js/data/tradingview-news-health.js';
import { createFeed } from '../public/js/data/filings.js';

const scratch = mkdtempSync(join(tmpdir(), 'continuous-news-test-'));
const originalFetch = globalThis.fetch;
let now = Date.now();
const iso = () => new Date(now).toISOString();
const holdings = [{ isin: 'INE000000001', ticker: 'ALPHA', name: 'Alpha Solar' },
  { isin: 'INE000000002', ticker: 'BETA', name: 'Beta Systems' }];
try {
  const core = { capturedAt: iso(), byTicker: { ALPHA: [{ title: 'Alpha Solar company news',
    url: 'https://publisher.example/core', date: iso().slice(0, 10), ticker: 'ALPHA', source: 'Publisher' }] } };
  writeJson(join(scratch, 'news.json'), core);
  writeJson(join(scratch, 'filing-capture/portfolio.json'), { sentinel: 'other collectors own this file' });
  let blocked = false;
  const calls = [];
  const fetcher = async url => {
    const symbol = new URL(url).searchParams.getAll('filter').find(f => f.startsWith('symbol:')).slice(7);
    calls.push(symbol);
    if (blocked) return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
    return Response.json({ items: [{ id: symbol, title: `${symbol.endsWith('ALPHA') ? 'Alpha Solar' : 'Beta Systems'} wins an order`,
      published: Math.floor(now / 1000), provider: { name: 'Publisher' },
      storyPath: `/news/fixture:${symbol}-order/`, relatedSymbols: [{ symbol }] }] });
  };
  const options = { dataDir: scratch, portfolio: { holdings }, fetcher, isolated: true, spacingMs: 0, maxRequests: 1 };
  let coverage = await enrichTradingViewNews({ ...options, now });
  assert.equal(coverage.targetIntervalMinutes, 15);
  assert.equal(coverage.staleAfterMinutes, 45);
  assert.equal(coverage.staleOrFailedSymbols, 1);
  assert.equal(assessTradingViewCoverage(coverage, { now }).ok, false, 'one fresh symbol cannot conceal an unfinished portfolio sweep');
  now += 15 * 60000;
  coverage = await enrichTradingViewNews({ ...options, now });
  assert.deepEqual(calls, ['NSE:ALPHA', 'NSE:BETA'], 'short budgets rotate fairly, without starving later symbols');
  assert.equal(coverage.staleOrFailedSymbols, 0);
  assert.equal(assessTradingViewCoverage(coverage, { now }).ok, true);
  const dir = join(scratch, 'tradingview-news');
  assert.equal(companyNewsArchiveRows(dir).length, 2);
  assert(readJson(join(dir, 'index.json')).archive.every(s => s.file.startsWith('tradingview-news/')));
  assert.deepEqual(readJson(join(scratch, 'news.json')), core, 'independent capture never rewrites the core head');
  assert.deepEqual(readJson(join(scratch, 'filing-capture/portfolio.json')), { sentinel: 'other collectors own this file' });
  assert(!readdirSync(scratch).includes('company-news'), 'fast capture cannot race with the core archive writer');
  const healthySnapshot = readJson(join(dir, 'latest.json'));
  blocked = true; now += 15 * 60000;
  coverage = await enrichTradingViewNews({ ...options, now });
  assert(assessTradingViewCoverage(coverage, { now }).critical.some(f => f.code === 'source-backoff'));
  const before = calls.length;
  now += 15 * 60000;
  await enrichTradingViewNews({ ...options, now });
  assert.equal(calls.length, before, 'frequent schedules still respect source-wide Retry-After');
  assert.equal(companyNewsArchiveRows(dir).length, 2, 'blocked reads do not retract permanent news');
  assert.equal(assessTradingViewCoverage(healthySnapshot.tradingViewCoverage, { now: now + 46 * 60000 }).ok, false);
  assert.equal(assessTradingViewCoverage({ ...healthySnapshot.tradingViewCoverage, checkedAt: iso(), oldestSuccessAt: null }, { now }).ok, false);
  assert.equal(assessTradingViewCoverage(null, { now }).ok, false);

  // The actual News adapter sees independent publications without changing the old core clock.
  let publication = healthySnapshot;
  const requests = [];
  globalThis.fetch = async url => { requests.push(String(url)); assert.equal(String(url), 'data/news.json'); return Response.json(core); };
  const timers = new Map(), listeners = new Map();
  let timerId = 0;
  const doc = { hidden: false, addEventListener: (event, fn) => listeners.set(event, fn),
    removeEventListener: event => listeners.delete(event) };
  const feed = withTradingViewNews(createFeed('news'), { doc, now: () => now,
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    cancel: id => timers.delete(id), read: async path => {
      assert.equal(path, 'data/tradingview-news/latest.json'); requests.push(path);
      return { value: publication };
    } });
  let emits = 0;
  const off = feed.onChange(() => emits++);
  await feed.seed();
  assert.equal(feed.rows().length, 3);
  const initialRows = feed.rows();
  assert.equal(feed.rows(), initialRows, 'unchanged complete union is reused by reference');
  feed.meta(); feed.wasAskedEmpty('ALPHA'); feed.forTicker('ALPHA');
  assert.equal(feed.rows(), initialRows, 'coverage and per-company reads never rebuild the union');
  assert.equal(feed.meta().capturedAt, core.capturedAt, 'TradingView freshness never launders core search freshness');
  assert.equal(timers.size, 1, 'one shared poller for all consumers');
  const off2 = feed.onChange(() => {});
  await feed.load([]);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, NEWS_SNAPSHOT_POLL_MS);
  const next = { ...publication.byTicker.ALPHA[0], title: 'Alpha Solar corrected order headline', lastSeenAt: iso() };
  publication = { ...publication, capturedAt: iso(), byTicker: { ...publication.byTicker, ALPHA: [next] } };
  const tick = [...timers.entries()][0]; timers.delete(tick[0]); now += NEWS_SNAPSHOT_POLL_MS;
  await tick[1].fn();
  assert(feed.rows().some(r => r.title === next.title), 'new headlines land automatically while open');
  assert.notEqual(feed.rows(), initialRows, 'a new publication invalidates the complete union');
  assert.equal(feed.rows().length, 3, 'stable story IDs deduplicate a corrected headline');
  assert.equal(feed.meta().capturedAt, core.capturedAt);
  publication = healthySnapshot;
  await feed.refreshSnapshot();
  assert(feed.rows().some(r => r.title === next.title), 'older publication cannot roll back known corrections');
  assert(feed.meta().tradingViewReadError);
  publication = null;
  await feed.refreshSnapshot();
  assert.equal(feed.rows().length, 3, 'failed publication retains last-good news');
  doc.hidden = true; listeners.get('visibilitychange')();
  assert.equal(timers.size, 0, 'hidden browser does no polling; server capture is independent');
  now += 30 * 60000; doc.hidden = false; listeners.get('visibilitychange')();
  assert.equal([...timers.values()][0].delay, 0, 'overdue visibility resume reads immediately');
  off2(); off();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  assert(emits > 0);
  assert(!requests.some(path => path.startsWith('api/') || path.includes('news-mediator')), 'polls never trigger jobs or per-company upstream walks');

  const workflow = readFileSync(new URL('../.github/workflows/tradingview-news-refresh.yml', import.meta.url), 'utf8');
  const coreWorkflow = readFileSync(new URL('../.github/workflows/company-news-refresh.yml', import.meta.url), 'utf8');
  const healthWorkflow = readFileSync(new URL('../.github/workflows/filings-health.yml', import.meta.url), 'utf8');
  assert(workflow.includes('7,22,37,52 * * * *') && workflow.includes('ref: main'));
  assert(workflow.includes('group: tradingview-portfolio-news') && !workflow.includes('group: company-news-refresh'));
  assert(!coreWorkflow.includes('enrich-tradingview-news.mjs'), 'no simultaneous writers or duplicate upstream walks');
  assert(workflow.includes('git add public/data/tradingview-news/'));
  assert(workflow.indexOf('Check TradingView coverage') > workflow.indexOf('git push origin HEAD:main'), 'durable progress before health gate');
  assert(healthWorkflow.includes('check-tradingview-news-health.mjs'), 'independent deployed-data watchdog catches missing jobs/publications');
  console.log('Continuous portfolio news: isolated/fair capture, backoff, staleness, automatic browser refresh and scheduler contracts verified.');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
}
