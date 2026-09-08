#!/usr/bin/env node
// Read-only delivery and timer watchdog. It never dispatches, repairs alarms or contacts Telegram.
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TELEGRAM_LIMIT, validateTelegramCapture } from '../public/js/data/telegram-shared.js';
import { TELEGRAM_FRESH_MS } from '../public/js/data/telegram-health.js';
import { TELEGRAM_PRODUCTION_HOST, TELEGRAM_RUN_OVERDUE_MS } from '../worker/telegram-scheduler.mjs';

export const TELEGRAM_SOURCE_OVERDUE_MS = TELEGRAM_FRESH_MS;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const validTime = (value, now) => Number.isFinite(stamp(value)) && stamp(value) <= now + 60000;

export function assessTelegramHealth(capture, schedule, { now = Date.now() } = {}) {
  const findings = [];
  const add = (code, severity = 'critical') => findings.push({ code, severity });
  let accepted = null;
  try { accepted = validateTelegramCapture(capture, now); } catch { add(capture ? 'capture-invalid' : 'capture-unavailable'); }
  if (accepted) {
    if (!validTime(accepted.lastCheckedAt, now)) add('source-check-time-invalid');
    else if (now - stamp(accepted.lastCheckedAt) > TELEGRAM_SOURCE_OVERDUE_MS) add('source-check-overdue');
    if (accepted.lastRun.status === 'failed') add('source-check-failed');
    else if (accepted.lastRun.status === 'partial') add('source-check-partial', 'warning');
    if (!validTime(accepted.lastRun.at, now)) add('source-attempt-time-invalid');
    if (accepted.retryIds.length) add('source-retries-pending', 'warning');
    if (accepted.publicSafety && stamp(accepted.publicSafety.nextAttemptAt) > now) add('public-source-paused');
    if (accepted.apiSafety?.paused) add('account-review-required');
    else if (accepted.apiSafety?.nextAttemptAt && stamp(accepted.apiSafety.nextAttemptAt) > now) add('api-source-paused');
    // Historical gaps and an unverified public head are coverage limits, not proof the timer
    // has stopped. Publication age likewise cannot establish collection freshness.
    const delivery = capture.delivery;
    if (!['ok', 'partial'].includes(delivery?.status) || !Number.isSafeInteger(delivery?.collectorRunId) || delivery.collectorRunId < 1) add('delivery-unverified');
    else if (delivery.status === 'partial' || delivery.degraded || delivery.collectorFallback || delivery.collectorSkippedRuns?.length) add('delivery-degraded');
    // A valid new head can arrive before its history work finishes. The most recent completed
    // run may then describe an older failure, which cannot invalidate this newer checkpoint.
    const completedAtOrAfterCapture = Number.isSafeInteger(delivery?.collectorLatestCompletedRunId) &&
      delivery.collectorLatestCompletedRunId >= delivery.collectorRunId;
    if (delivery?.collectorLatestFailed || completedAtOrAfterCapture && delivery.collectorLatestConclusion !== 'success') add('collector-latest-failed');
  }
  if (!schedule || schedule.ok !== true) add('scheduler-unavailable');
  else {
    if (!schedule.enabled) add('scheduler-disabled');
    else {
      const deadline = stamp(schedule.nextAttemptAt), alarm = stamp(schedule.alarmAt);
      if (!Number.isFinite(deadline)) add('scheduler-deadline-invalid');
      if (!Number.isFinite(alarm)) {
        // getAlarm() may briefly return null as an alarm starts, before its durable claim.
        // Allow that minute only; a status read never recreates the missing alarm.
        if (Number.isFinite(deadline) && Math.abs(now - deadline) <= 60000) add('scheduler-alarm-starting', 'warning');
        else add('scheduler-alarm-missing');
      } else {
        if (now - alarm > 120000) add('scheduler-alarm-overdue');
        if (Number.isFinite(deadline) && Math.abs(alarm - deadline) > 1000) add('scheduler-alarm-mismatch');
      }
      if (!validTime(schedule.lastAttemptAt, now)) add('scheduler-attempt-time-invalid');
      else if (now - stamp(schedule.lastAttemptAt) > 75 * 60000) add('scheduler-attempt-overdue');
      if (schedule.lastResult === 'checking' && now - stamp(schedule.lastAttemptAt) > 120000) add('scheduler-check-stalled');
      if (['failed', 'recent-run-failed'].includes(schedule.lastResult)) add('scheduler-failed');
      const activeAt = stamp(schedule.activeRun?.createdAt || schedule.activeRun?.firstObservedAt);
      const completedSinceAttempt = accepted && schedule.activeRun && capture.delivery?.collectorRunId === schedule.activeRun.id &&
        capture.delivery?.collectorLatestCompletedRunId === schedule.activeRun.id && capture.delivery.collectorArtifactPhase === 'final' &&
        !capture.delivery.collectorInProgress && capture.delivery.collectorLatestConclusion === 'success' && !capture.delivery.collectorLatestFailed;
      if (!completedSinceAttempt && (schedule.runOverdue || Number.isFinite(activeAt) && now - activeAt > TELEGRAM_RUN_OVERDUE_MS)) add('collector-run-overdue');
    }
  }
  const critical = findings.filter(f => f.severity === 'critical').length;
  return { checkedAt: new Date(now).toISOString(), ok: critical === 0,
    status: critical ? 'critical' : findings.length ? 'warning' : 'ok', findings,
    sourceCheckedAt: accepted?.lastCheckedAt || null, retainedPosts: accepted?.posts.length || 0,
    nextAttemptAt: validTime(schedule?.nextAttemptAt, now + 3600000) ? schedule.nextAttemptAt : null };
}

async function readJson(fetcher, url, maximum) {
  const signal = AbortSignal.timeout(25000);
  const response = await fetcher(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal });
  if (!response.ok || Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw Error('Published check unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Published check empty');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw Error('Published check too large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function checkTelegramHealth({ base = `https://${TELEGRAM_PRODUCTION_HOST}`, fetcher = fetch, now = Date.now() } = {}) {
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw Error('Invalid health-check origin');
  const results = await Promise.allSettled([
    readJson(fetcher, new URL('/api/telegram/posts', origin).href, TELEGRAM_LIMIT + 65536),
    readJson(fetcher, new URL('/api/telegram/schedule', origin).href, 16384),
  ]);
  // Neither response headers/bodies nor exception text can enter a failure report.
  return assessTelegramHealth(...results.map(result => result.status === 'fulfilled' ? result.value : null), { now });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await checkTelegramHealth({ base: process.env.FILINGS_HEALTH_BASE || undefined });
  const lines = ['## Telegram delivery and timer health', '', `Status: ${report.status}`, '',
    'Ten-minute collection target; thirty-minute source freshness threshold. Public-page coverage is not exhaustive.', ''];
  for (const finding of report.findings) {
    const severity = finding.severity === 'critical' ? 'error' : 'warning';
    console.log(`${severity.toUpperCase()}: Telegram ${finding.code}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${severity}::Telegram ${finding.code}`);
    lines.push(`- ${severity}: ${finding.code}`);
  }
  console.log(`Telegram health: ${report.status}`);
  if (process.env.TELEGRAM_HEALTH_REPORT) writeFileSync(process.env.TELEGRAM_HEALTH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
