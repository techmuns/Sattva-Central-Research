#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessWorkflow, checkWorkflows, cronMatches, workflowCatalog } from './check-workflow-health.mjs';
const now = Date.parse('2026-09-05T20:00:00Z'); // Saturday
const active = { state: 'active' }, workflow = { file: 'example.yml', name: 'Example', schedules: ['30 1 * * 1-5'] };
const run = { id: 1, head_branch: 'main', status: 'completed', conclusion: 'success', event: 'schedule', created_at: '2026-09-04T01:35:00Z' };
assert(cronMatches('*/15 * * * *', Date.parse('2026-09-05T20:15:00Z')));
assert(!cronMatches('0 4-15 * * 1-5', now));
assert(cronMatches('0 15-23,0-2 * * *', Date.parse('2026-09-05T01:00:00Z')));
assert(cronMatches('0 0 * * 7', Date.parse('2026-09-06T00:00:00Z')));
assert(assessWorkflow(workflow, active, [run], { now }).ok, 'weekday-only capture is not overdue on a weekend');
assert(!assessWorkflow(workflow, active, [{ ...run, created_at: '2026-09-03T01:35:00Z' }], { now }).ok);
assert(!assessWorkflow(workflow, { state: 'disabled_inactivity' }, [run], { now }).ok);
assert(!assessWorkflow(workflow, active, [], { now }).ok);
assert(!assessWorkflow(workflow, active, [{ ...run, conclusion: 'failure' }], { now }).ok);
const episode = { ...workflow, episodeEndsAt: '2026-09-05T19:00:00Z' };
const terminal = { ...run, conclusion: 'failure', created_at: '2026-09-05T19:05:00Z' };
const ended = assessWorkflow(episode, { state: 'disabled_manually' }, [terminal], { now });
assert(ended.ok, 'an ended one-off audit is not an overdue recurring collector');
assert.equal(ended.assessment, 'completed-episode');
assert.equal(ended.latestRun.conclusion, 'failure', 'the historical failure remains explicit and is never reported as a pass');
assert(!assessWorkflow(episode, { state: 'disabled_manually' }, [], { now }).ok, 'an audit that never ran remains unhealthy after expiry');
assert(!assessWorkflow(episode, active, [terminal], { now }).ok, 'an audit still active after expiry remains unhealthy');
assert(!assessWorkflow(episode, { state: 'disabled_manually' }, [run], { now }).ok, 'an old run cannot prove the final audit happened');
for (const conclusion of [null, 'cancelled', 'skipped']) assert(!assessWorkflow(episode, { state: 'disabled_manually' },
  [{ ...terminal, status: conclusion ? 'completed' : 'in_progress', conclusion }], { now }).ok,
  'missing or unfinished final observations remain unhealthy');
assert(assessWorkflow(episode, { state: 'disabled_manually' }, [{ ...terminal,
  created_at: '2026-09-05T18:55:00Z', run_started_at: '2026-09-05T19:05:00Z' }], { now }).ok,
  'a queued final audit can start after the deadline');
assert(!assessWorkflow(episode, { state: 'disabled_manually' }, [run], { now: now - 2 * 3600000 }).ok,
  'a disabled audit still fails during its promised observation window');
assert(!assessWorkflow(workflow, active, [{ ...run, head_branch: 'codex/test' }], { now }).ok);
assert(!assessWorkflow({ ...workflow, schedules: ['*/15 * * * *'] }, active, [run], { now }).ok, 'frequent capture requires recent successful runs');
const recent = { ...run, created_at: '2026-09-05T19:15:00Z' };
const frequent = { ...workflow, schedules: ['*/15 * * * *'] };
const skipped = { ...recent, id: 2, conclusion: 'skipped', event: 'workflow_run', created_at: '2026-09-05T19:30:00Z' };
const cancelled = { ...skipped, id: 3, conclusion: 'cancelled', created_at: '2026-09-05T19:35:00Z' };
const replacement = { ...recent, id: 4, status: 'in_progress', conclusion: null, created_at: '2026-09-05T19:40:00Z' };
assert(assessWorkflow(frequent, active, [skipped, recent], { now }).ok);
assert(assessWorkflow(frequent, active, [replacement, cancelled, skipped, recent], { now }).ok);
assert(!assessWorkflow(frequent, active, [cancelled, skipped, recent], { now }).ok, 'a cancellation with no replacement still fails');
assert(!assessWorkflow(frequent, active, [skipped, { ...recent, conclusion: 'failure' }], { now }).ok, 'skipped runs cannot hide a real failure');
assert(!assessWorkflow(frequent, active, [skipped, run], { now }).ok, 'no-op runs cannot advance the success clock');
assert(assessWorkflow({ ...workflow, schedules: ['*/15 * * * *'] }, active, [{ ...recent, event: 'workflow_run' }], { now }).ok,
  'completion-driven recovery counts as a real automatic workflow run');
assert(assessWorkflow({ ...workflow, schedules: ['*/15 * * * *'] }, active, [recent, { ...recent, id: 2, status: 'queued', conclusion: null, created_at: '2026-09-05T19:45:00Z' }], { now }).ok);
assert(!assessWorkflow(workflow, active, [{ ...recent, status: 'in_progress', conclusion: null, created_at: '2026-09-05T17:00:00Z' }, run], { now }).ok);
const calls = [];
let report = await checkWorkflows({ repository: 'example/repo', token: 'fixture', catalog: [workflow], now, fetcher: async (url, options) => {
  calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
  return Response.json(url.includes('/runs?') ? { workflow_runs: [run] } : active);
} });
assert(report.ok); assert.equal(calls.length, 2);
report = await checkWorkflows({ repository: 'example/repo', catalog: [workflow], now, fetcher: async () => new Response('', { status: 403 }) });
assert(!report.ok); assert.deepEqual(report.workflows[0].issues, ['workflow-check-unavailable']);
const catalog = workflowCatalog();
for (const file of ['announcements-refresh.yml', 'corporate-actions-refresh.yml']) {
  const yaml = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  assert.match(yaml, /uses: actions\/checkout@v5\s+with:\s+(?:#[^\n]*\n\s+)*ref: \$\{\{ github.ref \}\}/,
    `${file}: a queued capture starts from the latest checkpoint on its branch`);
}
assert(catalog.some(w => w.file === 'tradingview-news-refresh.yml'));
assert.equal(catalog.find(w => w.file === 'newsletter-monitor.yml').episodeEndsAt, '2026-10-20T02:30:00Z');
assert(catalog.some(w => w.file === 'verify.yml') && catalog.some(w => w.file === 'deploy.yml'));
assert(!catalog.some(w => ['filings-health.yml', 'bse-ipo-refresh.yml'].includes(w.file)), 'exclude self-reference and removed workflow catalog entries');
for (const entry of catalog) for (const cron of entry.schedules) assert.doesNotThrow(() => cronMatches(cron, now));

// Reproduce the publishing failure without touching the user's checkout or any remote service.
// Execute the actual workflow staging block against disposable Git fixtures, then rebase over
// an unrelated source update. The old block left price-move-checks.json dirty and failed here.
const yaml = readFileSync(new URL('../.github/workflows/technicals-refresh.yml', import.meta.url), 'utf8');
const stage = yaml.slice(yaml.indexOf('          git add public/data/technicals.json'), yaml.indexOf('          if git diff --cached --quiet;'));
assert(stage.includes('git add public/data/price-move-checks.json'));
assert(!/git add (?:-A|\.|--all)/.test(stage), 'never scoop up unrelated changes');
assert(yaml.includes('group: data-refresh'));
assert(readFileSync(new URL('../.github/workflows/price-move-verify.yml', import.meta.url), 'utf8').includes('group: data-refresh'), 'shared cache writers retain serialization');
const scratch = mkdtempSync(join(tmpdir(), 'source-publish-test-'));
const git = (...args) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  git('init', '-b', 'fixture-base'); git('config', 'user.name', 'Local fixture'); git('config', 'user.email', 'fixture@example.test');
  mkdirSync(join(scratch, 'public/data'), { recursive: true });
  const files = ['technicals', 'price-move-checks', 'atr-history', 'earnings-live', 'mc-ticker-map', 'result-returns', 'earnings-calendar', 'concall-scans', 'super-investors'];
  for (const name of files) writeFileSync(join(scratch, `public/data/${name}.json`), '{}\n');
  git('add', 'public/data'); git('commit', '-m', 'Fixture baseline');
  git('switch', '-c', 'fixture-upstream'); writeFileSync(join(scratch, 'other-source.json'), '{}\n'); git('add', 'other-source.json'); git('commit', '-m', 'Unrelated upstream capture');
  git('switch', 'fixture-base');
  for (const name of files) writeFileSync(join(scratch, `public/data/${name}.json`), '{"updated":true}\n');
  execFileSync('bash', ['-e', '-c', stage], { cwd: scratch });
  assert.equal(git('diff', '--name-only').trim(), '', 'every scraper-owned tracked file is staged');
  git('commit', '-m', 'Fixture daily capture'); git('rebase', 'fixture-upstream');
  assert.equal(git('status', '--porcelain').trim(), '');
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log('PASS pipeline health: current workflow inventory, UTC schedules, weekends, disabled/failed/overdue jobs, read-only API errors, and clean daily-capture rebase');
