#!/usr/bin/env node
// Bounded catch-up, not another scraper. Only fixed news workflows on main; no reruns,
// cancellation, deployments, arbitrary inputs, or untrusted workflow artifacts.
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { dispatchWorkflow, latestRun, isInFlight, parseRepo } from '../worker/github-actions.mjs';

const MINUTE = 60000;
export const NEWS_RECOVERY_TARGETS = [
  { file: 'tradingview-news-refresh.yml', path: 'tradingview-news/latest.json', interval: 15 },
  { file: 'market-news-refresh.yml', path: 'market-news.json', interval: 30, sources: ['moneycontrol'], group: 'market-news' },
  { file: 'rss-news-refresh.yml', path: 'market-news.json', interval: 60,
    sources: ['business-standard', 'mint', 'economic-times', 'investing'], group: 'market-news' },
  { file: 'company-news-refresh.yml', path: 'news.json', interval: 180, inputs: { scope: 'book' } },
  { file: 'twitter-refresh.yml', path: 'twitter-posts.json', interval: 30 },
  { file: 'telegram-refresh.yml', path: 'telegram-posts.json', interval: 30 },
];
const timestamp = (value, now) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed <= now + MINUTE ? parsed : 0;
};

export function newsRecoveryDecision(target, snapshot, runs, { now, blockedUntil = null, enabled = true } = {}) {
  if (!enabled) return { reason: 'disabled', due: false };
  if (timestamp(blockedUntil, Infinity) > now) return { reason: 'source-backoff', due: false };
  if (runs.some(isInFlight)) return { reason: 'already-running', due: false };
  // Moneycontrol's overnight target is hourly. An RSS write cannot reset its capture clock.
  const interval = target.file === 'market-news-refresh.yml' && (new Date(now).getUTCHours() < 3 || new Date(now).getUTCHours() >= 15) ? 60 : target.interval;
  const sourceTimes = target.sources?.map(id => timestamp(snapshot?.sources?.find(s => s.id === id)?.capturedAt, now));
  const captured = sourceTimes ? Math.min(...sourceTimes) : timestamp(snapshot?.capturedAt, now);
  const ordered = [...runs].sort((a, b) => timestamp(b.createdAt, now) - timestamp(a.createdAt, now));
  const latest = ordered[0];
  if (latest && !timestamp(latest.createdAt, now)) throw Error('Latest workflow creation time is invalid');
  let failures = 0;
  for (const run of ordered) {
    if (run.status !== 'completed' || run.conclusion === 'success') break;
    failures++;
  }
  // Persistent failures are retried progressively less often, never in a workflow_run loop.
  const cooldown = Math.max(interval, failures ? Math.min(360, 30 * 2 ** Math.min(failures - 1, 4)) : interval) * MINUTE;
  const attempted = timestamp(latest?.createdAt, now);
  if (attempted && now - attempted < cooldown) return { reason: 'cooling-down', due: false };
  const age = captured ? now - captured : Infinity;
  return { due: age >= interval * MINUTE, reason: age >= interval * MINUTE ? 'overdue' : 'current',
    capturedAt: captured ? new Date(captured).toISOString() : null, overdueRatio: age / (interval * MINUTE) };
}

export async function recoverNewsCaptures({ repository, token, dataDir = fileURLToPath(new URL('../public/data/', import.meta.url)),
  fetcher = fetch, now = Date.now(), apply = false, maxDispatches = 2, xEnabled = true, clock = Date.now } = {}) {
  const cfg = { ...parseRepo(repository), token, ref: 'main' };
  const started = clock(), results = [], due = [], busyGroups = new Set();
  // Read all targets before writing. An unavailable GitHub status means no dispatch for that
  // target, not an assumption that its queue is empty. One failed source cannot stop the others.
  for (const target of NEWS_RECOVERY_TARGETS) {
    try {
      const runs = await latestRun(fetcher, cfg, target.file, { perPage: 20 });
      if (runs.some(isInFlight) && target.group) busyGroups.add(target.group);
      const snapshot = readJson(join(dataDir, target.path), null);
      const state = target.file === 'tradingview-news-refresh.yml' ? readJson(join(dataDir, 'tradingview-news/tradingview.json'), {}) : {};
      const decision = newsRecoveryDecision(target, snapshot, runs, { now,
        blockedUntil: state.blockedUntil, enabled: target.file !== 'twitter-refresh.yml' || xEnabled });
      const result = { workflow: target.file, ...decision };
      results.push(result);
      if (decision.due) due.push({ target, result });
    } catch (error) { results.push({ workflow: target.file, due: false, reason: 'check-failed', error: error.code || 'invalid-capture' }); }
  }
  let dispatched = 0;
  for (const { target, result } of due.sort((a, b) => b.result.overdueRatio - a.result.overdueRatio)) {
    delete result.overdueRatio;
    if (!apply) { result.reason = 'would-dispatch'; continue; }
    if (dispatched >= Math.min(2, maxDispatches) || clock() - started > 100000) { result.reason = 'deferred-budget'; continue; }
    if (target.group && busyGroups.has(target.group)) { result.reason = 'shared-writer-busy'; continue; }
    try {
      // Recheck ALL active statuses immediately before dispatch. No refresh inputs can request
      // an expensive full universe walk or change the portfolio/source configuration.
      const inputs = target.file === 'tradingview-news-refresh.yml' ? null : { source: 'recovery', ...(target.inputs || {}) };
      const out = await dispatchWorkflow(fetcher, cfg, target.file, 'main', inputs);
      result.reason = out.dispatched ? 'dispatched' : 'already-running';
      if (out.dispatched) dispatched++;
      if (target.group) busyGroups.add(target.group);
    } catch (error) {
      result.reason = 'dispatch-failed'; result.error = error.code || 'upstream';
      // Even an ambiguous POST consumes a slot and its write group. Never blindly repeat it.
      dispatched++;
      if (target.group) busyGroups.add(target.group);
      if (['rate-limited', 'unauthorised', 'forbidden'].includes(error.code)) break;
    }
  }
  for (const result of results) delete result.overdueRatio;
  return { checkedAt: new Date(now).toISOString(), mode: apply ? 'recovery' : 'read-only',
    ok: !results.some(r => ['check-failed', 'dispatch-failed'].includes(r.reason)), results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  if (apply && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main'))
    throw Error('Automatic recovery writes run only inside the main-branch Actions watchdog');
  const report = await recoverNewsCaptures({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
    apply, xEnabled: process.env.X_CAPTURE_ENABLED !== 'false' });
  const lines = ['## News capture recovery', '', `Mode: ${report.mode}. At most two catch-up dispatches; no full scans or run cancellations.`, '',
    ...report.results.map(r => `- ${r.workflow}: ${r.reason}${r.error ? ` (${r.error})` : ''}`)];
  console.log(lines.join('\n'));
  if (process.env.NEWS_RECOVERY_REPORT) writeJson(process.env.NEWS_RECOVERY_REPORT, report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
