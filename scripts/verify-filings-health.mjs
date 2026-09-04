import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';
import worker from '../worker/index.js';

const now = Date.now(), recent = new Date(now - 60000).toISOString();
const from = '2025-01-01', to = new Date(now).toISOString().slice(0, 10);
const healthy = {
  company: { version: 1, companies: [{ ticker: 'A' }], createdAt: recent, lastRunFinishedAt: recent, requestedFrom: from, requestedTo: to,
    sources: { announcements: { A: { lastSuccessAt: recent, recentCheckedAt: recent, ranges: [{ from, to }] } }, domestic: { A: { lastSuccessAt: recent } } } },
  announcements: { byTicker: {}, rowCount: 0, capturedAt: recent, coversUniverse: true, shortfall: [], failed: [] },
  insider: { byTicker: {}, rowCount: 0, empty: ['A'], capturedAt: recent, asked: 1, covered: 1, failed: {}, fallback: {} },
};
const assess = (value) => assessFilingsHealth(value, { now });
assert.equal(assess(healthy).status, 'healthy');
const original = structuredClone(healthy);
const auth = structuredClone(healthy);
auth.company.sources.domestic.A.error = { reason: 'unauthorised', message: 'Sensitive upstream error must not be exposed in health report' };
assert.equal(assess(auth).ok, false, 'a fresh job timestamp cannot mask an expired credential');
assert(assess(auth).findings.some((f) => f.code === 'authentication-failed'));
assert(!JSON.stringify(assess(auth)).includes('Sensitive upstream'), 'only controlled diagnostic codes are exposed');

const stale = structuredClone(healthy);
stale.company.lastRunFinishedAt = new Date(now - 5 * 3600000).toISOString();
stale.company.sources.domestic.A.lastSuccessAt = new Date(now - 49 * 3600000).toISOString();
assert(assess(stale).findings.some((f) => f.code === 'capture-job-overdue'));
assert(assess(stale).findings.some((f) => f.code === 'company-check-overdue'));
const pending = structuredClone(healthy);
pending.company.sources.domestic.A = { registeredAt: recent };
assert.equal(assess(pending).status, 'degraded', 'initial capture progress is a visible warning during the fixed grace period');
pending.company.sources.domestic.A.registeredAt = new Date(now - 25 * 3600000).toISOString();
assert.equal(assess(pending).status, 'critical', 'continually unvisited companies escalate even while the job timestamp is fresh');
const badTime = structuredClone(healthy);
badTime.company.sources.domestic.A.lastSuccessAt = 'not-a-date';
assert(assess(badTime).findings.some((f) => f.code === 'invalid-check-time'));
const missing = structuredClone(healthy);
delete missing.company.sources.domestic;
assert.equal(assess(missing).ok, false);
assert.equal(assess({}).critical, 3, 'missing files fail closed for each source independently');
assert.equal(assess(null).critical, 3);
for (const [source, key, value] of [
  ['announcements', 'failed', [null]], ['announcements', 'rowCount', undefined],
  ['insider', 'asked', undefined], ['insider', 'asked', 0], ['insider', 'covered', 2],
  ['insider', 'failed', 'invalid'], ['insider', 'fallback', []], ['insider', 'failedCount', '0'],
]) {
  const malformed = structuredClone(healthy);
  malformed[source][key] = value;
  assert(assess(malformed).findings.some((f) => f.code === 'invalid-capture'), `${source}.${key} must fail closed instead of throwing or reporting healthy`);
}
const corrupt = structuredClone(healthy);
corrupt.company.companies = [null];
corrupt.announcements.rowCount = 4;
assert(assess(corrupt).findings.some((f) => f.code === 'invalid-capture'));
assert(assess(corrupt).findings.some((f) => f.code === 'row-count-mismatch'));
const malformedRanges = structuredClone(healthy);
malformedRanges.company.sources.announcements.A.ranges = {};
assert.equal(assess(malformedRanges).status, 'degraded', 'malformed range metadata cannot assert complete historical coverage');
const retained = structuredClone(healthy);
retained.insider.fallback = { A: { capturedAt: recent, reason: 'timeout' } };
assert(assess(retained).findings.some((f) => f.code === 'company-reads-incomplete'), 'last-good rows cannot mask the failed newest read');
const exchangeInsider = structuredClone(healthy);
exchangeInsider.insider = {
  byTicker: { A: [{ ticker: 'A' }] }, rowCount: 1, capturedAt: recent, coversUniverse: true,
  categories: ['Bulk deal', 'Block deal', 'SAST', 'Insider trade'], failed: {}, failedCount: 0,
  fallback: {}, fallbackCount: 0,
  sources: ['bulk', 'block', 'sast', 'insiders'].map((id) => ({ id, ok: true, rowCount: 1, pagesRead: 2, coverageFrom: '2026-08-01' })),
};
assert.equal(assess(exchangeInsider).ok, true, 'all four market-wide Screener categories satisfy insider coverage');
exchangeInsider.insider.sources.pop();
assert(assess(exchangeInsider).findings.some((f) => f.code === 'trade-category-coverage-unverified'), 'a missing Screener category fails closed');
const short = structuredClone(healthy);
short.announcements.shortfall = [{ category: 'Result', collected: 1, declared: 2 }];
assert(assess(short).findings.some((f) => f.code === 'pagination-shortfall'));
const links = structuredClone(healthy);
links.company.sources.domestic.A.unavailableLinks = 3;
assert.equal(assess(links).status, 'degraded', 'source-null slots remain visible without inventing an HTTP link failure');
assert.deepEqual(healthy, original, 'audit never changes a capture');
assert.equal(assessFilingsHealth(auth, { now, sources: ['announcements'] }).ok, true, 'capture gates audit only their own sources');

const originalCaches = globalThis.caches, originalFetch = globalThis.fetch;
const cache = new Map(), jobs = [], assetReads = [];
globalThis.caches = { default: { match: async (key) => cache.get(key.url)?.clone(), put: async (key, value) => cache.set(key.url, value.clone()) } };
globalThis.fetch = async () => { throw new Error('Health endpoint must never call an upstream or dispatch a capture'); };
let data = healthy;
const paths = { '/data/filing-capture/index.json': 'company', '/data/corp-announcements.json': 'announcements', '/data/insider-trades.json': 'insider' };
const env = { ASSETS: { fetch: async (request) => {
  const path = new URL(request.url).pathname;
  assetReads.push(path);
  const value = data[paths[path]];
  return value ? Response.json(value) : new Response('', { status: 404 });
} } };
const get = async (method = 'GET') => {
  const response = await worker.fetch(new Request('https://preview.example/api/filings-health', { method }), env, { waitUntil: (job) => jobs.push(job) });
  await Promise.all(jobs.splice(0));
  return response;
};
try {
  assert.equal((await get('POST')).status, 405);
  assert.equal(assetReads.length, 0);
  assert.equal((await get()).status, 200);
  assert.equal(assetReads.length, 3);
  await get();
  assert.equal(assetReads.length, 3, 'short health cache avoids repeatedly downloading large captures');
  cache.clear(); data = auth;
  const response = await get();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'critical');
} finally { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; }

// Exercise the real CLI against a local static-capture server, including a red exit and report.
const scratch = mkdtempSync(join(tmpdir(), 'sattva-health-'));
const server = createServer((req, res) => {
  const value = data[paths[new URL(req.url, 'http://localhost').pathname]];
  res.writeHead(value ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value || {}));
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const report = join(scratch, 'report.json');
  const options = { env: { ...process.env, FILINGS_HEALTH_BASE: `http://127.0.0.1:${server.address().port}`, FILINGS_HEALTH_REPORT: report, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' }, timeout: 20000 };
  data = auth;
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/check-filings-health.mjs'], options), (error) => error.code === 1);
  assert.equal(JSON.parse(readFileSync(report)).status, 'critical');
  data = healthy;
  await promisify(execFile)(process.execPath, ['scripts/check-filings-health.mjs'], options);
  assert.equal(JSON.parse(readFileSync(report)).status, 'healthy');
  const announcementsWorkflow = readFileSync(new URL('../.github/workflows/announcements-refresh.yml', import.meta.url), 'utf8');
  assert(announcementsWorkflow.indexOf('Check operational capture health') > announcementsWorkflow.indexOf('git push origin HEAD:main'), 'announcement health gate runs after preserving/publishing captured progress');
  const insiderWorkflow = readFileSync(new URL('../.github/workflows/insider-trades-refresh.yml', import.meta.url), 'utf8');
  for (const gate of ['Check trade capture health', 'Check filing and trade capture health']) {
    assert(insiderWorkflow.indexOf(gate) > insiderWorkflow.indexOf('git push origin HEAD:main'), `${gate} runs after preserving/publishing captured progress`);
  }
} finally { await new Promise((resolve) => server.close(resolve)); rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS source health failures, fixed initial grace, stale checks, retained-data incidents, HTTP 503, read-only caching and workflow gate ordering');
