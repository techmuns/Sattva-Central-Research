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
assert(!assessWorkflow(workflow, active, [{ ...run, head_branch: 'codex/test' }], { now }).ok);
assert(!assessWorkflow({ ...workflow, schedules: ['*/15 * * * *'] }, active, [run], { now }).ok, 'frequent capture requires recent successful runs');
const recent = { ...run, created_at: '2026-09-05T19:15:00Z' };
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
assert(catalog.some(w => w.file === 'tradingview-news-refresh.yml'));
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
