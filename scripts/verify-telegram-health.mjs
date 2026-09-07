#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessTelegramHealth, checkTelegramHealth } from './check-telegram-health.mjs';
import { telegramReadHealth } from '../public/js/data/telegram-health.js';

const now = Date.parse('2026-09-07T13:00:00Z');
const at = minutes => new Date(now + minutes * 60000).toISOString();
const capture = { schemaVersion: 2, channel: 'researchreportss', route: 'embed+permalink',
  lastCheckedAt: at(-5), capturedAt: at(-3 * 1440), latestVerifiedAt: null,
  lastRun: { at: at(-5), status: 'ok' }, historyComplete: false,
  posts: [{ id: 102825, text: 'Unchanged captured report', publishedAt: at(-3 * 1440) }],
  delivery: { status: 'ok', collectorRunId: 123, collectorLatestFailed: false, collectorLatestConclusion: 'success',
    collectorLatestCompletedRunId: 123, collectorArtifactPhase: 'final', collectorInProgress: false } };
const schedule = { ok: true, enabled: true, intervalSeconds: 600, nextAttemptAt: at(5), alarmAt: at(5),
  lastAttemptAt: at(-5), lastResult: 'dispatched', reason: null, failures: 0, activeRun: null, runOverdue: false };
const assess = (changes = {}, timer = {}) => assessTelegramHealth({ ...capture, ...changes }, { ...schedule, ...timer }, { now });
const codes = report => report.findings.map(f => f.code);
assert.equal(assess().status, 'ok', 'quiet publications and incomplete history are not stale collection');
assert.equal(assess({ lastCheckedAt: at(-31) }).ok, false);
assert(codes(assess({ lastCheckedAt: at(10) })).includes('source-check-time-invalid'));
assert(codes(assess({ lastRun: { at: at(-1), status: 'failed', error: 'PRIVATE UPSTREAM' } })).includes('source-check-failed'));
assert.equal(assess({ lastRun: { at: at(-1), status: 'partial' }, retryIds: [999] }).status, 'warning');
assert(codes(assess({ delivery: { ...capture.delivery, collectorLatestFailed: true } })).includes('collector-latest-failed'));
const headDelivery = { ...capture.delivery, collectorArtifactPhase: 'head', collectorInProgress: true,
  collectorLatestCompletedRunId: 122, collectorLatestConclusion: 'failure' };
assert.equal(assess({ delivery: headDelivery }).status, 'ok', 'new healthy head is independent of a previous failed completion');
assert(codes(assess({ delivery: { ...headDelivery, collectorLatestCompletedRunId: 124 } })).includes('collector-latest-failed'),
  'a failed completion newer than the selected checkpoint is actionable');
for (const degraded of [{ status: 'partial' }, { degraded: true }, { collectorFallback: true },
  { collectorSkippedRuns: [{ id: 124, reason: 'PRIVATE UPSTREAM' }] }]) {
  const report = assess({ delivery: { ...capture.delivery, ...degraded } });
  assert(codes(report).includes('delivery-degraded'));
  assert(!JSON.stringify(report).includes('PRIVATE'), 'skipped artifact failure bodies never enter operational reports');
}
assert(codes(assess({ delivery: null })).includes('delivery-unverified'));
assert(codes(assess({ publicSafety: { reason: 'rate-limit', nextAttemptAt: at(60) } })).includes('public-source-paused'));
assert(codes(assess({ apiSafety: { paused: true, reason: 'account-attention' } })).includes('account-review-required'));
assert(codes(assess({ apiSafety: { paused: false, reason: 'connection', nextAttemptAt: at(15) } })).includes('api-source-paused'));
assert(codes(assess({}, { enabled: false })).includes('scheduler-disabled'));
assert(codes(assess({}, { alarmAt: null })).includes('scheduler-alarm-missing'));
assert.equal(assess({}, { alarmAt: null, nextAttemptAt: at(0) }).status, 'warning', 'brief alarm-start state is not a lost timer');
assert(codes(assess({}, { alarmAt: at(-3), nextAttemptAt: at(-3) })).includes('scheduler-alarm-overdue'));
assert(codes(assess({}, { alarmAt: at(15) })).includes('scheduler-alarm-mismatch'));
assert(codes(assess({}, { lastResult: 'failed', reason: 'configuration' })).includes('scheduler-failed'));
assert(codes(assess({}, { lastResult: 'recent-run-failed' })).includes('scheduler-failed'));
assert(codes(assess({}, { lastResult: 'checking', lastAttemptAt: at(-3) })).includes('scheduler-check-stalled'));
assert(codes(assess({}, { activeRun: { id: 7, status: 'queued', createdAt: at(-31) } })).includes('collector-run-overdue'));
assert(codes(assess({}, { activeRun: { id: 7, status: 'waiting', firstObservedAt: at(-31) } })).includes('collector-run-overdue'));
assert(assess({}, { activeRun: { id: 123, status: 'queued', createdAt: at(-31) }, runOverdue: true }).ok,
  'a newly published successful completion supersedes the timer observation of that same active run');
assert(codes(assess({ delivery: { ...headDelivery, collectorLatestConclusion: 'success' } },
  { activeRun: { id: 123, status: 'in_progress', createdAt: at(-31) }, runOverdue: true })).includes('collector-run-overdue'),
  'previous successful completion cannot mask a currently stalled head checkpoint');
assert(codes(assess({ delivery: { ...capture.delivery, collectorLatestCompletedRunId: 122 } },
  { activeRun: { id: 123, status: 'in_progress', createdAt: at(-31) }, runOverdue: true })).includes('collector-run-overdue'),
  'completion attribution requires the same run ID');
assert(codes(assess({}, { lastAttemptAt: at(-76) })).includes('scheduler-attempt-overdue'));
assert.deepEqual(codes(assessTelegramHealth(null, null, { now })), ['capture-unavailable', 'scheduler-unavailable']);
assert(!JSON.stringify(assess({ lastRun: { at: at(-1), status: 'failed', error: 'PRIVATE UPSTREAM' } })).includes('PRIVATE'));
assert.equal(telegramReadHealth({ ...capture, capturedAt: at(0), lastCheckedAt: at(-31) }, now).state, 'stale',
  'a fresh capture/cache time cannot repair stale source checks in the dashboard');
assert.equal(telegramReadHealth({ ...capture, capturedAt: at(0), lastRun: { at: at(0), status: 'failed' } }, now).state, 'partial');
assert.equal(telegramReadHealth({ ...capture, lastCheckedAt: at(10) }, now).state, 'unknown', 'future dates cannot certify freshness');
assert.equal(telegramReadHealth({ ...capture, delivery: headDelivery }, now).state, 'checked',
  'the dashboard also accepts a clean head despite an older completed failure');

const requests = [];
let mode = 'ok';
const fetcher = async (url, options) => {
  requests.push(url);
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers, undefined, 'health check sends no credentials');
  assert.equal(new URL(url).origin, 'https://dashboard.test');
  if (mode === 'error') return new Response('PRIVATE UPSTREAM', { status: 503, headers: { 'private-header': 'secret' } });
  if (mode === 'large' && url.endsWith('/schedule')) return new Response('PRIVATE UPSTREAM', { headers: { 'content-length': '999999' } });
  if (mode === 'stream-large' && url.endsWith('/schedule')) return new Response('x'.repeat(16385));
  return Response.json(url.endsWith('/posts') ? capture : schedule);
};
assert((await checkTelegramHealth({ base: 'https://dashboard.test/ignored', fetcher, now })).ok);
assert.deepEqual(requests.sort(), ['https://dashboard.test/api/telegram/posts', 'https://dashboard.test/api/telegram/schedule']);
mode = 'error';
const failed = await checkTelegramHealth({ base: 'https://dashboard.test', fetcher, now });
assert(!failed.ok); assert(!JSON.stringify(failed).includes('PRIVATE')); assert(!JSON.stringify(failed).includes('secret'));
for (mode of ['large', 'stream-large']) assert(codes(await checkTelegramHealth({ base: 'https://dashboard.test', fetcher, now })).includes('scheduler-unavailable'));
await assert.rejects(checkTelegramHealth({ base: 'https://secret@dashboard.test', fetcher, now }), /Invalid health-check origin/);
const workflow = readFileSync(new URL('../.github/workflows/filings-health.yml', import.meta.url), 'utf8');
assert.match(workflow, /name: Check Telegram[^\n]*\n\s+if: always\(\)/);
assert.match(workflow, /run: node scripts\/check-telegram-health\.mjs/);
assert.match(workflow, /\$\{\{ runner\.temp \}\}\/telegram-health\.json/);
console.log('PASS Telegram health: source/delivery failures, quiet feeds, history limits, safety pauses, actual/missing/overdue alarms, stalled jobs and bounded read-only diagnostics');
