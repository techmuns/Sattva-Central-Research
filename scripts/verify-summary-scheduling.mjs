import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { localSummaries } from './lib/summaries-local.mjs';
import { prepareSummaryCollection, collectSummaryQueue } from './collect-screener-summaries.mjs';
import { summaryRefreshPlan } from './lib/summary-refresh-plan.mjs';
import { SUMMARY_INTERVAL_MS, SUMMARY_SOURCE_INTERVAL_MS, SUMMARY_WINDOW_MS } from '../public/js/data/concall-summaries-shared.js';

fs.mkdirSync('.cache/summary-scheduling', { recursive: true });
const root = fs.mkdtempSync(path.resolve('.cache/summary-scheduling/ledger-'));
const env = { GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' };
let at = Date.parse('2026-10-16T09:00:00Z'), opened = 0, reads = 0, acknowledged = 0;
const now = () => at, iso = value => new Date(value).toISOString();
const body = { title: 'Concall Summary - Fixture', blocks: [{ type: 'paragraph', text: 'Synthetic private fixture notes discuss operating performance, demand, costs and management outlook for the current financial year. These are test notes only and contain no actual company analysis.' }] };
const inventory = (count = 3) => ({ version: 1, portfolioRevision: 'a'.repeat(64), portfolioCheckedAt: iso(at), sourceCheckedAt: iso(at), portfolioAsOf: '2026-10-01', portfolioWorkbookUploadedAt: '2026-10-01T00:00:00Z',
  holdings: Array.from({ length: count }, (_, i) => ({ isin: `INE${String(i + 1).padStart(9, '0')}`, name: `Fixture ${i + 1}`, ticker: `TEST${i + 1}`, companyKey: `TEST${i + 1}`, discovery: 'matched' })),
  targets: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), isin: `INE${String(i + 1).padStart(9, '0')}`, name: `Fixture ${i + 1}`, ticker: `TEST${i + 1}`, companyKey: `TEST${i + 1}`, companyUrl: `https://www.screener.in/company/TEST${i + 1}/`, publishedDate: '2026-10-15', kind: 'Transcript', sourceName: 'Synthetic fixture', rank: i, url: `https://www.screener.in/concalls/summary/${i + 1}/` })) });
const checkpoint = async () => { acknowledged++; };
let runtime;
const open = async () => { opened++; assert(acknowledged > 0); return { page: {}, close: async () => {} }; };
const read = async () => { reads++; return body; };
try {
  const file = path.join(root, 'cooldown.sqlite');
  runtime = localSummaries(file, { env, now, checkpoint });
  await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory(2) });
  const refused = await runtime.client({ action: 'reserve', requestId: randomUUID() });
  await runtime.client({ action: 'complete', ...refused, outcome: 'rate-limited' });
  const cooldown = Date.parse(runtime.store.status().cooldownUntil);
  assert.equal(cooldown, at + SUMMARY_WINDOW_MS);
  await runtime.close();
  runtime = localSummaries(file, { env: { ...env, GITHUB_RUN_ID: '12346' }, now, checkpoint });
  at = cooldown - 5 * 60000;
  assert(summaryRefreshPlan(runtime.store.status(), { now: at }).due);
  const during = await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory(3) });
  assert.equal(during.state.holdings.length, 3, 'New holdings are discovered even while paid requests are paused');
  assert.equal(summaryRefreshPlan(during.state, { now: at }).sourceDue, false, 'The workflow skips browser installation during cooldown');
  assert.equal((await collectSummaryQueue({ client: runtime.client, now, openSession: open, read })).reason, 'source-cooldown');
  assert.equal(opened, 0); assert.equal(reads, 0);
  assert.equal(summaryRefreshPlan(during.state, { now: at }).nextCheckAt, iso(cooldown));
  at = cooldown;
  assert(summaryRefreshPlan(runtime.store.status(), { now: at }).due, 'A completion wakeup crosses the cooldown boundary without waiting another half hour');
  const resumed = await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory(3) });
  assert(summaryRefreshPlan(resumed.state, { now: at }).sourceDue);
  assert.equal((await collectSummaryQueue({ client: runtime.client, now, openSession: open, read })).saved, 1);
  assert.equal(reads, 1, 'The first eligible run automatically saves a summary');
  for (let i = 0; i < 20; i++) {
    at += 1000;
    assert.equal(summaryRefreshPlan(runtime.store.status(), { now: at }).due, false, 'Completion storms cannot repeatedly refresh or install browsers');
    assert.equal((await collectSummaryQueue({ client: runtime.client, now, openSession: open, read })).attempted, 0, 'Every entry point enforces the same persisted pacing');
  }
  assert.equal(reads, 1); assert.equal(runtime.store.read(['1'])[0].status, 'ready');
  assert.equal(runtime.store.status().rateLimitStreak, 0);
  await runtime.close();

  // Many independent wakeups over a full rolling day cannot exhaust the 60-attempt ceiling.
  at = Date.parse('2026-10-18T09:00:00Z');
  runtime = localSummaries(path.join(root, 'paced.sqlite'), { env, now, checkpoint });
  const first = at;
  for (let i = 0; i < 48; i++) {
    await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory(60) });
    assert.equal((await collectSummaryQueue({ client: runtime.client, now, openSession: open, read })).saved, 1);
    const latest = runtime.db.prepare('SELECT MAX(started) at FROM summary_attempts').get().at;
    assert.equal(latest, first + i * SUMMARY_SOURCE_INTERVAL_MS);
    at += SUMMARY_SOURCE_INTERVAL_MS;
  }
  assert.equal(at - first, SUMMARY_WINDOW_MS);
  const times = runtime.db.prepare('SELECT started FROM summary_attempts ORDER BY started').all();
  assert.equal(times.length, 48); assert(times.every((row, i) => !i || row.started - times[i - 1].started >= SUMMARY_SOURCE_INTERVAL_MS));
  assert.equal(runtime.store.status().requestBudget, 60, 'The original rolling ceiling is preserved for imported attempts');
  await runtime.close();

  runtime = localSummaries(path.join(root, 'backoff.sqlite'), { env, now, checkpoint });
  for (const days of [1, 2, 4, 7, 7]) {
    await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory() });
    const claim = await runtime.client({ action: 'reserve', requestId: randomUUID() }); assert(claim.reserved);
    await runtime.client({ action: 'complete', ...claim, outcome: 'rate-limited' });
    const retry = Date.parse(runtime.store.status().cooldownUntil); assert.equal(retry, at + days * SUMMARY_WINDOW_MS);
    at = retry;
  }
  const previous = runtime.store.status().cooldownUntil;
  await prepareSummaryCollection({ client: runtime.client, inventory: async () => inventory() });
  assert.equal(runtime.store.status().cooldownUntil, previous, 'Discovery does not shorten or replace the source cooldown');
  assert.equal(summaryRefreshPlan({ discoveryAttemptedAt: iso(at), discoveryStatus: 'failed', pending: 1, nextSourceAttemptAt: iso(at - 1) }, { now: at }).sourceDue, false);
  assert(summaryRefreshPlan({ discoveryAttemptedAt: iso(at - SUMMARY_INTERVAL_MS) }, { now: at }).due, 'Failed discovery automatically retries at the ordinary cadence');

  const workflow = fs.readFileSync('.github/workflows/screener-summaries-refresh.yml', 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*Screener concall collection, TradingView portfolio news, RSS news refresh/);
  assert.match(workflow, /head_repository\.full_name == github\.repository/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/, 'Completion events execute the trusted default-branch SHA');
  assert.match(workflow, /group: screener-summary-account\s+cancel-in-progress: false/);
  assert(workflow.indexOf('--prepare') < workflow.indexOf('Install pinned browser runtime'));
  assert.equal((workflow.match(/if: steps\.plan\.outputs\.source_due == 'true'/g) || []).length, 2);
  console.log('PASS automatic summary recovery: restart, cooldown boundary, current holdings during pause, coalesced wakeups, at most 48 paced requests/day, repeated refusal backoff, retained history and trusted completion triggers');
} finally { await runtime?.close(); }
