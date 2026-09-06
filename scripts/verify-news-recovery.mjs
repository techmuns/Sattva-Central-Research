#!/usr/bin/env node
// Failure injection only. No external requests, dispatches, or production data writes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchWorkflow, latestRun } from '../worker/github-actions.mjs';
import { readTradingViewNews, tradingViewTargets } from './lib/tradingview-news.mjs';
import { enrichTradingViewNews } from './enrich-tradingview-news.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { companyNewsArchiveRows } from './lib/company-news-archive.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { NEWS_RECOVERY_TARGETS, newsRecoveryDecision, recoverNewsCaptures } from './recover-news-captures.mjs';

const now = Date.parse('2026-09-06T06:00:00Z'), iso = value => new Date(value).toISOString();
const cfg = { token: 'fixture-not-a-secret', owner: 'fixture', repo: 'repo', ref: 'main', sleepImpl: async () => {} };
const rawRun = (status, age = 1000, conclusion = null) => ({ id: 1, status, conclusion,
  created_at: iso(now - age), updated_at: iso(now - age), head_branch: 'main' });
let posts = 0, gets = 0, mode = 'ok';
const github = async (url, options = {}) => {
  const u = new URL(url);
  assert.equal(u.hostname, 'api.github.com');
  assert.equal(options.redirect, 'error');
  if (options.method === 'POST') {
    posts++;
    assert.equal(JSON.parse(options.body).ref, 'main');
    if (mode === 'ambiguous') return new Response('', { status: 503 });
    if (mode === 'lost-response') throw new TypeError('Connection closed after request');
    return new Response(null, { status: 204 });
  }
  gets++;
  assert.equal(u.searchParams.get('branch'), 'main', 'unrelated branches never influence dispatch eligibility');
  if (mode === 'unavailable') return new Response('', { status: 500 });
  if (mode === 'malformed') return Response.json({ message: 'not a runs list' });
  if (mode === 'rate-limited') return new Response('', { status: 429 });
  if (mode === 'long-retry') return new Response('', { status: 503, headers: { 'retry-after': '120' } });
  if (mode === 'transient' && gets === 1) return new Response('', { status: 502 });
  const active = u.searchParams.get('status');
  return Response.json({ workflow_runs: mode === 'older-waiting' && active === 'waiting'
    ? [rawRun('waiting', 86400000)] : active ? [] : [rawRun('completed', 86400000, 'success')] });
};

mode = 'transient'; gets = 0;
assert.equal((await latestRun(github, cfg, 'fixture.yml')).length, 1);
assert.equal(gets, 2, 'safe GET retries a transient failure');
for (const failure of ['unavailable', 'malformed', 'rate-limited', 'long-retry']) {
  mode = failure; posts = 0;
  await assert.rejects(dispatchWorkflow(github, cfg, 'fixture.yml', 'main'));
  assert.equal(posts, 0, `${failure} status must fail closed`);
}
mode = 'older-waiting'; posts = 0;
assert.equal((await dispatchWorkflow(github, cfg, 'fixture.yml', 'main')).dispatched, false);
assert.equal(posts, 0, 'older waiting runs cannot be hidden behind newer completed jobs');
for (const failure of ['ambiguous', 'lost-response']) {
  mode = failure; posts = 0;
  await assert.rejects(dispatchWorkflow(github, cfg, 'fixture.yml', 'main'), e => e.code === 'dispatch-uncertain');
  assert.equal(posts, 1, 'an uncertain dispatch response must never be blindly retried');
}

let reads = 0, elapsed = 0;
const empty = () => Response.json({ items: [] });
await readTradingViewNews('NSE:ALPHA', { now, clock: () => elapsed, sleep: async ms => { elapsed += ms; }, random: () => 0,
  fetcher: async () => ++reads === 1 ? new Response('', { status: 503 }) : empty() });
assert.equal(reads, 2);
assert.equal(elapsed, 750);
for (const status of [401, 403, 404, 422, 429]) {
  reads = 0;
  await assert.rejects(readTradingViewNews('NSE:ALPHA', { now,
    fetcher: async () => { reads++; return new Response('', { status }); } }), e => e.status === status);
  assert.equal(reads, 1, `HTTP ${status} is not a transient retry`);
}
reads = 0;
await assert.rejects(readTradingViewNews('NSE:ALPHA', { now,
  fetcher: async () => { reads++; return new Response('', { status: 503, headers: { 'retry-after': '3600' } }); } }), e => e.retryAfterMs === 3600000);
assert.equal(reads, 1, 'Retry-After beyond the deadline is deferred to a later run');
reads = 0; elapsed = 0;
await assert.rejects(readTradingViewNews('NSE:ALPHA', { now, clock: () => elapsed,
  sleep: async () => { elapsed += 16000; }, fetcher: async () => { reads++; return new Response('', { status: 503 }); } }));
assert.equal(reads, 1, 'an overslept retry never starts another request outside its deadline');

const holdings = [{ isin: 'INE000000001', ticker: 'ALPHA', name: 'Alpha Solar' },
  { isin: 'INE000000002', ticker: 'BETA', name: 'Beta Systems' }];
const entities = portfolioNewsEntities(holdings);
const directory = [{ ...holdings[0] }, { ...holdings[1], bseSymbol: 'BETA' }];
assert.deepEqual(tradingViewTargets(entities, directory, { nseEntries: [directory[0]] })[1].symbols, ['BSE:BETA'], 'BSE ticker does not invent an NSE listing');
assert.deepEqual(tradingViewTargets(entities, [directory[0]], { nseEntries: [directory[0]] })[1].symbols, ['NSE:BETA'],
  'new verified portfolio tickers do not wait for the next directory refresh');
assert.deepEqual(tradingViewTargets(entities, [{ ...directory[1], historical: true }], {
  nseEntries: [directory[0]], previousEntries: { [`${entities[1].entityId}|NSE:BETA`]: { lastSuccessAt: iso(now) } },
})[1].symbols, ['NSE:BETA', 'BSE:BETA'], 'a proven historical venue keeps collecting even after leaving the current exchange directory');
const mahindra = portfolioNewsEntities([{ isin: 'INE101A01026', ticker: 'M&M', name: 'Mahindra & Mahindra' }]);
assert.deepEqual(tradingViewTargets(mahindra, [{ isin: 'INE101A01026', ticker: 'M&M', bseSymbol: 'M&M' }])[0].symbols,
  ['NSE:M&M', 'BSE:M_M'], 'provider spelling correction leaves NSE unchanged');

const target = NEWS_RECOVERY_TARGETS[0], run = (age, conclusion = 'success') => ({ createdAt: iso(now - age * 60000), status: 'completed', conclusion });
assert.equal(newsRecoveryDecision(target, { capturedAt: iso(now) }, [], { now }).due, false);
assert.equal(newsRecoveryDecision(target, {}, [run(3)], { now }).reason, 'cooling-down');
assert.equal(newsRecoveryDecision(target, {}, [run(31, 'failure'), run(90, 'failure')], { now }).reason, 'cooling-down');
assert.equal(newsRecoveryDecision(target, {}, [], { now, blockedUntil: iso(now + 3600000) }).reason, 'source-backoff');
assert.equal(newsRecoveryDecision(target, {}, [], { now, enabled: false }).reason, 'disabled');
assert.equal(newsRecoveryDecision(NEWS_RECOVERY_TARGETS[1], { capturedAt: iso(now), sources: [
  { id: 'mint', capturedAt: iso(now) }, { id: 'moneycontrol', capturedAt: iso(now - 3600000) },
] }, [run(120)], { now }).due, true, 'fresh RSS cannot hide stale Moneycontrol');

const scratch = mkdtempSync(join(tmpdir(), 'news-recovery-fixture-'));
try {
  let attempts = [];
  const fetcher = async url => {
    const symbol = new URL(url).searchParams.getAll('filter').find(f => f.startsWith('symbol:')).slice(7);
    attempts.push(symbol);
    return Response.json({ items: [{ id: symbol, title: `${symbol} investor day`, provider: { name: 'Fixture' },
      published: now / 1000, storyPath: `/news/fixture:${symbol}/`, relatedSymbols: [{ symbol }] }] });
  };
  const options = { dataDir: scratch, portfolio: { holdings }, isolated: true, now, clock: () => now,
    spacingMs: 0, fetcher, checkpointEvery: 1 };
  await assert.rejects(enrichTradingViewNews({ ...options, onProgress: () => { throw Error('Simulated interruption'); } }), /Simulated/);
  const dir = join(scratch, 'tradingview-news');
  assert.equal(companyNewsArchiveRows(dir).length, 1, 'archive checkpoint survives interruption');
  assert.equal(readJson(join(dir, 'latest.json')), null, 'unfinished capture is not certified as a complete new head');
  attempts = [];
  await enrichTradingViewNews({ ...options, now: now + 1000, maxRequests: 1 });
  assert.deepEqual(attempts, ['NSE:BETA'], 'restart resumes the unattempted company first');
  assert.equal(companyNewsArchiveRows(dir).length, 2);
  const before = readJson(join(dir, 'tradingview.json'));
  attempts = [];
  await enrichTradingViewNews({ ...options, now: now + 2000, fetcher: async () => new Response('', { status: 422 }) });
  const failed = readJson(join(dir, 'tradingview.json'));
  assert(Object.values(failed.entries).every(e => e.error === 'http-422' && e.nextRetryAt));
  for (const [key, entry] of Object.entries(failed.entries)) assert.equal(entry.lastSuccessAt, before.entries[key].lastSuccessAt);
  await enrichTradingViewNews({ ...options, now: now + 60000 });
  assert.deepEqual(attempts, [], 'unsupported symbols are deferred, not hammered every quarter hour');
  assert.equal(companyNewsArchiveRows(dir).length, 2, 'failed and deferred reads never delete history');

  // Tests use a later clock so every fixture capture is overdue. All GitHub calls are mocked.
  mode = 'ok'; posts = 0;
  let report = await recoverNewsCaptures({ repository: 'fixture/repo', token: cfg.token, dataDir: scratch, fetcher: github, now: now + 86400000 });
  assert.equal(posts, 0, 'read-only is the default');
  assert(report.results.some(r => r.reason === 'would-dispatch'));
  report = await recoverNewsCaptures({ repository: 'fixture/repo', token: cfg.token, dataDir: scratch, fetcher: github, now: now + 86400000, apply: true });
  assert.equal(posts, 2, 'catch-up has a hard two-dispatch budget across all sources');
  assert(report.results.some(r => r.reason === 'deferred-budget'));
  mode = 'older-waiting'; posts = 0;
  report = await recoverNewsCaptures({ repository: 'fixture/repo', token: cfg.token, dataDir: scratch, fetcher: github, now: now + 86400000, apply: true });
  assert.equal(posts, 0, 'final active-status check prevents catch-up duplicates');

  const workflow = readFileSync(new URL('../.github/workflows/news-recovery.yml', import.meta.url), 'utf8');
  assert(workflow.includes('ref: main') && workflow.includes('persist-credentials: false'));
  assert(workflow.includes('head_repository.full_name == github.repository'));
  assert(!/workflow_run\.head_sha|download-artifact|contents: write|cancel-in-progress: true/.test(workflow));
  assert(workflow.includes('workflow_run:') && workflow.includes('cron:'));
  const capture = readFileSync(new URL('../.github/workflows/tradingview-news-refresh.yml', import.meta.url), 'utf8');
  assert(capture.includes('CAPTURE_OUTCOME') && capture.includes('continue-on-error: true'));
  console.log('PASS bounded news recovery: mapping, transient retries, source backoff, interruption checkpoints, branch-safe dispatch, active-run guards, uncertain POSTs and sustained-failure cooldowns.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
